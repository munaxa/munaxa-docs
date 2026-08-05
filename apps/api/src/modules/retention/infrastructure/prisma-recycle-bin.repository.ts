import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { type Page, normalizePageRequest, skipFor, toPage } from '@edms/utils';

import { requireTransaction } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';
import type { DeletedItem, RecycleBinRepository, RecycleBinRequest } from '../application/ports';

/**
 * The recycle bin's read, over `document` and `folder`.
 *
 * This repository reads rows two other modules own, and it is the deliberate exception the module
 * README records — the same exception Search's `PrismaSearchSourceReader` is: a *read model* over
 * other modules' tables, in this module's infrastructure, writing nothing. The alternative — paging
 * Document's list and Library's list separately and merging in memory — would make `total` a lie,
 * which is what the paging contract forbids.
 *
 * Two shapes, one page. The union is computed in SQL rather than by fetching both lists whole,
 * because "one page of everything deleted, newest first" is a question only the database can
 * answer without reading everything: each half is filtered and the union is sorted and paged once.
 *
 * `ix_document_deleted` (partial, `deleted_at IS NOT NULL`) is what this query walks on the
 * document side — the index this phase added after Phase 9 observed there was none on `deleted_at`.
 */
@Injectable()
export class PrismaRecycleBinRepository implements RecycleBinRepository {
  async list(request: RecycleBinRequest): Promise<Page<DeletedItem>> {
    const normalized = normalizePageRequest(request);
    const tenantId = requireContext().tenantId;
    const tx = requireTransaction();

    const search = request.search === undefined ? null : `%${escapeLike(request.search)}%`;
    const kind = request.kind ?? null;
    const direction =
      request.sortBy === 'deletedAt' && request.sortDirection === 'asc'
        ? Prisma.sql`ASC`
        : Prisma.sql`DESC`;

    // A UNION ALL of two disjoint sets, sorted and paged once. `deleted_by_name` is joined here
    // rather than resolved per row by the caller, because a bin without "who deleted it" is a bin
    // that answers half its question.
    const items = await tx.$queryRaw<RawItem[]>`
      SELECT * FROM (
        SELECT
          d.id,
          'DOCUMENT'::text            AS kind,
          d.title                     AS name,
          d.document_number           AS document_number,
          f.path                      AS path,
          d.deleted_at                AS deleted_at,
          d.deleted_by                AS deleted_by,
          u.display_name              AS deleted_by_name,
          d.delete_reason             AS delete_reason,
          d.delete_cascade_id         AS cascade_id,
          d.version                   AS version
        FROM document d
        JOIN folder f ON f.id = d.folder_id
        LEFT JOIN "user" u ON u.id = d.deleted_by
        WHERE d.tenant_id = ${tenantId}::uuid
          AND d.deleted_at IS NOT NULL
          AND d.status <> 'PURGED'
          AND (${kind}::text IS NULL OR ${kind}::text = 'DOCUMENT')
          AND (${search}::text IS NULL
               OR d.title ILIKE ${search}
               OR d.document_number ILIKE ${search})
        UNION ALL
        SELECT
          fo.id,
          'FOLDER'::text              AS kind,
          fo.name                     AS name,
          NULL                        AS document_number,
          fo.path                     AS path,
          fo.deleted_at               AS deleted_at,
          fo.deleted_by               AS deleted_by,
          u.display_name              AS deleted_by_name,
          NULL                        AS delete_reason,
          fo.delete_cascade_id        AS cascade_id,
          fo.version                  AS version
        FROM folder fo
        LEFT JOIN "user" u ON u.id = fo.deleted_by
        WHERE fo.tenant_id = ${tenantId}::uuid
          AND fo.deleted_at IS NOT NULL
          AND (${kind}::text IS NULL OR ${kind}::text = 'FOLDER')
          AND (${search}::text IS NULL OR fo.name ILIKE ${search})
      ) bin
      ORDER BY bin.deleted_at ${direction}
      OFFSET ${skipFor(normalized)}
      LIMIT ${normalized.pageSize}
    `;

    const [documentCount, folderCount] = await Promise.all([
      kind === 'FOLDER'
        ? Promise.resolve(0)
        : tx.document.count({
            where: {
              tenantId,
              deletedAt: { not: null },
              status: { not: 'PURGED' },
              ...(request.search !== undefined && {
                OR: [
                  { title: { contains: request.search, mode: Prisma.QueryMode.insensitive } },
                  {
                    documentNumber: {
                      contains: request.search,
                      mode: Prisma.QueryMode.insensitive,
                    },
                  },
                ],
              }),
            },
          }),
      kind === 'DOCUMENT'
        ? Promise.resolve(0)
        : tx.folder.count({
            where: {
              tenantId,
              deletedAt: { not: null },
              ...(request.search !== undefined && {
                name: { contains: request.search, mode: Prisma.QueryMode.insensitive },
              }),
            },
          }),
    ]);

    return toPage(items.map(toItem), documentCount + folderCount, normalized);
  }
}

interface RawItem {
  id: string;
  kind: 'DOCUMENT' | 'FOLDER';
  name: string;
  document_number: string | null;
  path: string | null;
  deleted_at: Date;
  deleted_by: string | null;
  deleted_by_name: string | null;
  delete_reason: string | null;
  cascade_id: string | null;
  version: number;
}

function toItem(row: RawItem): DeletedItem {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    documentNumber: row.document_number,
    path: row.path,
    deletedAt: row.deleted_at,
    deletedBy: row.deleted_by,
    deletedByName: row.deleted_by_name,
    deleteReason: row.delete_reason,
    cascadeId: row.cascade_id,
    version: row.version,
  };
}

/** `%` and `_` are pattern characters to ILIKE; a search containing one means the literal. */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (match) => `\\${match}`);
}
