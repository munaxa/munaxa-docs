import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { DocumentStatusKey } from '@edms/domain';
import { type Page, skipFor, toPage } from '@edms/utils';

import type { ReportQuery, ReportRow, ReportSource } from '../../reporting/application/ports';
import { requireTransaction } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';
import { PrismaDocumentRepository } from './prisma-document.repository';

/**
 * Three of Phase 15's reports, answered by the module that owns the rows.
 *
 * **Every one of them starts at `PrismaDocumentRepository.whereFor`**, and that is the whole design
 * rather than an implementation detail. `whereFor` is where Phase 14 put the ACL predicate — inside
 * the repository rather than in the service — precisely so that everything counting or listing
 * documents inherits the caller's reach without knowing how. The dashboard's tiles inherited it in
 * Phase 14's own commit; these reports inherit it now, in the same way, by calling the same
 * function.
 *
 * A reporting module issuing its own `SELECT … FROM document` would have to rebuild the regions
 * walk — libraries, materialised folder paths, excluded subtrees, deny-wins — and the day the two
 * disagreed, the *report* would be the artefact somebody had printed and circulated. That is the
 * failure this seam exists to make impossible, and it is why `reporting/` has no Prisma model but
 * its own two.
 *
 * ## The deleted report reads deleted rows, and needs nothing special to do it
 *
 * `whereFor` already takes `deleted: 'live' | 'deleted' | 'all'` — Phase 10's own filter — so the
 * deleted-documents report is the same predicate with one field changed. It is *also* still ACL
 * filtered, which makes the report narrower than the recycle bin rather than wider: the bin is
 * gated on `document:restore` and lists what the tenant deleted, and this lists what the caller
 * could have seen before somebody deleted it. The catalogue requires `document:restore` **as well
 * as** `report:view` so it can never be the looser of the two doors.
 */
@Injectable()
export class DocumentReportSource implements ReportSource {
  constructor(private readonly documents: PrismaDocumentRepository) {}

  run(query: ReportQuery): Promise<Page<ReportRow>> {
    switch (query.query) {
      case 'documents':
        return this.documents$(query, 'live');
      case 'deleted-documents':
        return this.documents$(query, 'deleted');
      case 'documents-by-dimension':
        return this.byDimension(query);
      default:
        // Unreachable through the service, which routes by the catalogue's own `source`. Loud
        // rather than empty: an empty page here would be a report that silently answered nothing.
        throw new Error(`Document answers no report called ${query.query}.`);
    }
  }

  private async documents$(
    query: ReportQuery,
    deleted: 'live' | 'deleted',
  ): Promise<Page<ReportRow>> {
    const tx = requireTransaction();
    const where = await this.whereFor(query, deleted);

    const [rows, total] = await Promise.all([
      tx.document.findMany({
        where,
        // Deleted rows read newest-deleted-first, live rows newest-changed-first: the question
        // "what was deleted" is a question about when, and ordering it by `updated_at` would sort
        // by the delete's own stamp anyway but say something different in the column header.
        orderBy: deleted === 'deleted' ? { deletedAt: 'desc' } : { updatedAt: 'desc' },
        skip: skipFor(query.page),
        take: query.page.pageSize,
        select: {
          documentNumber: true,
          title: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          deletedAt: true,
          deleteReason: true,
          deleteCascadeId: true,
          documentType: { select: { name: true } },
          category: { select: { name: true } },
          confidentiality: { select: { name: true } },
          folder: { select: { path: true, library: { select: { name: true } } } },
          // `owner_user_id` and `deleted_by` are plain columns — `document` has no relation to
          // `user`, deliberately, because the directory is Identity's and a join here would be
          // this module reading its rows. So the names come from one lookup for the page, below.
          ownerUserId: true,
          deletedBy: true,
          _count: { select: { revisions: true } },
        },
      }),
      // The same `where`. 08 §7's Query row: a document the caller cannot reach is absent from the
      // page **and from the total**, so a report's own row count never says how much it omitted.
      tx.document.count({ where }),
    ]);

    // One query for every person named on this page, never one per row. A twenty-five row report
    // resolving names a row at a time is the N+1 that 19 exists to prevent, and a report is the
    // one screen somebody runs with a page size of two hundred.
    const names = await this.namesFor(
      rows.flatMap((row) => [row.ownerUserId, row.deletedBy].filter(isPresent)),
    );

    return toPage(
      rows.map((row): ReportRow =>
        deleted === 'deleted'
          ? {
              documentNumber: row.documentNumber,
              title: row.title,
              library: row.folder.library.name,
              folderPath: row.folder.path,
              deletedAt: row.deletedAt,
              deletedBy: row.deletedBy === null ? null : (names.get(row.deletedBy) ?? null),
              deleteReason: row.deleteReason,
              // Phase 10's cascade identifier, rendered as the fact it encodes rather than as a
              // UUID: "was this deleted on its own, or did a folder take it".
              cascaded: row.deleteCascadeId === null ? 'no' : 'yes',
            }
          : {
              documentNumber: row.documentNumber,
              title: row.title,
              status: row.status,
              documentType: row.documentType.name,
              category: row.category?.name ?? null,
              confidentiality: row.confidentiality.name,
              library: row.folder.library.name,
              folderPath: row.folder.path,
              owner: names.get(row.ownerUserId) ?? null,
              revisionCount: row._count.revisions,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
            },
      ),
      total,
      query.page,
    );
  }

  /**
   * "Documents per department, per type or per user" — Phase 13 §8's limit row.
   *
   * A `groupBy` over the *same* predicate, which is what makes the breakdown and the list agree:
   * clicking a bar and running the `documents` report with that filter returns exactly the rows the
   * bar counted, because both start at `whereFor`.
   *
   * Department is the one dimension that is not a column on `document`. It is the owner's primary
   * department, so it is two aggregates rather than one — documents grouped by owner, then owners
   * resolved to a department — and the intermediate is bounded by the number of people rather than
   * by the number of documents.
   */
  private async byDimension(query: ReportQuery): Promise<Page<ReportRow>> {
    const dimension = query.strings['dimension'] ?? 'STATUS';
    const where = await this.whereFor(query, 'live');

    if (dimension === 'DEPARTMENT') {
      return this.byDepartment(where, query);
    }

    const by = {
      TYPE: 'documentTypeId',
      CATEGORY: 'categoryId',
      OWNER: 'ownerUserId',
      STATUS: 'status',
    }[dimension] as 'documentTypeId' | 'categoryId' | 'ownerUserId' | 'status';

    const grouped = await requireTransaction().document.groupBy({
      by: [by],
      where,
      _count: { _all: true },
    });
    const labels = await this.labelsFor(
      dimension,
      grouped.map((row) => String(row[by] ?? '')),
    );

    const entries = grouped
      .map((row) => {
        const value = row[by];
        return {
          // A row whose dimension is null is "unassigned" rather than absent: a report that
          // silently dropped every document with no category would have a total smaller than the
          // list it summarises, which is the divergence this whole seam exists to prevent.
          label: value === null ? UNASSIGNED : (labels.get(String(value)) ?? String(value)),
          count: row._count._all,
        };
      })
      .sort((left, right) => right.count - left.count);

    // Grouped rows are the *whole* answer, and there are as many as there are types or people —
    // bounded by configuration, never by document count — so the page is applied here rather than
    // in SQL, and `total` is the number of groups. Paging in SQL would need a second grouped query
    // to count them.
    return toPage(page(entries, query), entries.length, query.page);
  }

  private async byDepartment(
    where: Prisma.DocumentWhereInput,
    query: ReportQuery,
  ): Promise<Page<ReportRow>> {
    const tx = requireTransaction();
    // Documents grouped by owner first — bounded by the number of people, not by documents — then
    // the owners resolved to their primary department in one query. Two aggregates rather than a
    // scan: the alternative loads every document row to group them in this process, which is the
    // shape 02 §5 exists to prevent.
    const grouped = await tx.document.groupBy({
      by: ['ownerUserId'],
      where,
      _count: { _all: true },
    });
    const memberships = await tx.userDepartment.findMany({
      where: {
        tenantId: requireContext().tenantId,
        userId: { in: grouped.map((row) => row.ownerUserId) },
        isPrimary: true,
      },
      select: { userId: true, department: { select: { name: true } } },
    });
    const departmentOf = new Map(
      memberships.map((row) => [row.userId, row.department.name] as const),
    );

    const counts = new Map<string, number>();
    for (const row of grouped) {
      // Somebody with no *primary* department is "unassigned" rather than dropped: a report whose
      // groups do not sum to its own list's total is a report somebody reconciles against and
      // cannot balance.
      const name = departmentOf.get(row.ownerUserId) ?? UNASSIGNED;
      counts.set(name, (counts.get(name) ?? 0) + row._count._all);
    }
    const entries = [...counts.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((left, right) => right.count - left.count);
    return toPage(page(entries, query), entries.length, query.page);
  }

  /** Display names for a page's people, in one query. */
  private async namesFor(ids: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) {
      return new Map();
    }
    const rows = await requireTransaction().user.findMany({
      where: { tenantId: requireContext().tenantId, id: { in: unique } },
      select: { id: true, displayName: true },
    });
    return new Map(rows.map((row) => [row.id, row.displayName] as const));
  }

  /** Names for the identifiers a `groupBy` returns. One query per report, never one per group. */
  private async labelsFor(
    dimension: string,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    const tenantId = requireContext().tenantId;
    const present = ids.filter((id) => id !== '');
    if (present.length === 0 || dimension === 'STATUS') {
      // A status is its own label — 13 §2's rule for audit codes applied here: the code is what a
      // filter is written against, and a phrase in its place gives one value two names.
      return new Map();
    }
    const tx = requireTransaction();
    const where = { tenantId, id: { in: [...present] } };
    if (dimension === 'TYPE') {
      const rows = await tx.documentType.findMany({ where, select: { id: true, name: true } });
      return new Map(rows.map((row) => [row.id, row.name]));
    }
    if (dimension === 'CATEGORY') {
      const rows = await tx.category.findMany({ where, select: { id: true, name: true } });
      return new Map(rows.map((row) => [row.id, row.name]));
    }
    const rows = await tx.user.findMany({ where, select: { id: true, displayName: true } });
    return new Map(rows.map((row) => [row.id, row.displayName]));
  }

  /** The list's own predicate, plus this report's date range. */
  private async whereFor(
    query: ReportQuery,
    deleted: 'live' | 'deleted',
  ): Promise<Prisma.DocumentWhereInput> {
    const base = await this.documents.whereFor({
      page: 1,
      pageSize: 1,
      sortDirection: 'desc',
      deleted,
      ...(query.strings['libraryId'] !== undefined && { libraryId: query.strings['libraryId'] }),
      ...(query.strings['folderId'] !== undefined && { folderId: query.strings['folderId'] }),
      ...(query.strings['documentTypeId'] !== undefined && {
        documentTypeId: query.strings['documentTypeId'],
      }),
      ...(query.strings['categoryId'] !== undefined && { categoryId: query.strings['categoryId'] }),
      ...(query.strings['ownerUserId'] !== undefined && {
        ownerUserId: query.strings['ownerUserId'],
      }),
      ...(query.strings['status'] !== undefined && {
        status: query.strings['status'] as DocumentStatusKey,
      }),
    });
    const from = query.dates['from'];
    const to = query.dates['to'];
    if (from === undefined && to === undefined) {
      return base;
    }
    // The range applies to the act the report is about: when a document was created, or when it
    // was deleted. Applying `created_at` to a deletion report would answer "documents created last
    // month that have since been deleted", which is a different and much less useful question.
    const field = deleted === 'deleted' ? 'deletedAt' : 'createdAt';
    return {
      AND: [
        base,
        {
          [field]: {
            ...(from !== undefined && { gte: from }),
            ...(to !== undefined && { lte: to }),
          },
        },
      ],
    };
  }
}

/** What a grouped row with no value is called, on the wire and in an export. */
const UNASSIGNED = 'UNASSIGNED';

function isPresent(value: string | null): value is string {
  return value !== null;
}

function page(
  entries: readonly { label: string; count: number }[],
  query: ReportQuery,
): readonly ReportRow[] {
  const start = skipFor(query.page);
  return entries.slice(start, start + query.page.pageSize);
}
