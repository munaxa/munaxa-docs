import { Inject, Injectable } from '@nestjs/common';

import { type DocumentId, type RevisionId, asId } from '@edms/domain';

import { UNIT_OF_WORK, type UnitOfWork, requireTransaction } from '../../../core/prisma';
import { requireContext } from '../../../core/tenancy/tenant-context';
import type { SearchSource, SearchSourceFacts } from '../application/ports';

/**
 * The projection's one read of the source tables.
 *
 * This class is a recorded exception to "modules call each other's application services": it
 * reads document, folder, library, organisation, confidentiality, metadata, revision and
 * approval rows *as rows*, because a projection's input is the join across them and six
 * bespoke bulk-read services invented for one consumer would spread the read model's shape
 * across six modules (see this module's README, and the Phase 8 report's decision record).
 * The discipline that matters is preserved: this reader makes **no decision** — the ACL goes
 * through `ACL_RESOLVER`, the text through Preview's own query service — and it writes
 * nothing. A schema change that breaks it breaks a projection, which the rebuild repairs;
 * it cannot corrupt a source of truth it never touches.
 *
 * Every method joins the ambient unit of work when one exists and opens its own otherwise,
 * so the consumer can call it directly and the projection can call it mid-transaction.
 */
@Injectable()
export class PrismaSearchSourceReader implements SearchSource {
  constructor(@Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork) {}

  async factsFor(documentId: DocumentId): Promise<SearchSourceFacts | null> {
    return this.unitOfWork.run(async () => {
      const tx = requireTransaction();
      const tenantId = requireContext().tenantId;

      const document = await tx.document.findFirst({
        where: { id: documentId, tenantId },
        include: {
          confidentiality: { select: { rank: true } },
          folder: { select: { id: true, path: true, libraryId: true } },
          currentRevision: true,
          metadataValues: {
            include: { field: { select: { id: true, isSearchable: true, dataType: true } } },
          },
        },
      });
      // Soft-deleted and purged documents are not findable: the entry is removed, never
      // filtered at query time — an unfindable row in the index is a leak waiting for a
      // predicate bug.
      if (document === null || document.deletedAt !== null || document.status === 'PURGED') {
        return null;
      }

      const revision =
        document.currentRevision ??
        (document.latestRevisionId === null
          ? null
          : await tx.documentRevision.findFirst({
              where: { id: document.latestRevisionId, tenantId },
            }));

      const library = await tx.library.findFirst({
        where: { id: document.folder.libraryId, tenantId },
        select: { id: true, ownerScopeType: true, ownerScopeId: true },
      });
      const placement = await this.placementOf(
        library === null
          ? { libraryId: document.folder.libraryId, scopeType: null, scopeId: null }
          : {
              libraryId: library.id,
              scopeType: library.ownerScopeType,
              scopeId: library.ownerScopeId,
            },
      );

      const approvers = await tx.approvalTask.findMany({
        where: { tenantId, state: 'DECIDED', instance: { documentId: document.id } },
        select: { assigneeId: true, decidedById: true },
      });
      const approverIds = [
        ...new Set(approvers.map((task) => task.decidedById ?? task.assigneeId)),
      ];

      const metadata = collectMetadata(document.metadataValues);

      return {
        document: {
          id: asId<DocumentId>(document.id),
          title: document.title,
          description: document.description,
          status: document.status,
          documentNumber: document.documentNumber,
          documentTypeId: document.documentTypeId,
          categoryId: document.categoryId,
          confidentialityRank: document.confidentiality.rank,
          ownerUserId: document.ownerUserId,
          createdAt: document.createdAt,
          updatedAt: document.updatedAt,
          version: document.version,
        },
        placement: {
          libraryId: document.folder.libraryId,
          folderId: document.folder.id,
          folderPath: document.folder.path,
          entityId: placement.entityId,
          departmentId: placement.departmentId,
          branchId: placement.branchId,
        },
        revision:
          revision === null
            ? null
            : {
                id: asId<RevisionId>(revision.id),
                ordinal: revision.ordinal,
                label: revision.label,
                filename: revision.filename,
                publishedAt: revision.publishedAt,
                effectiveFrom: revision.effectiveFrom,
              },
        metadata,
        approverIds,
      } satisfies SearchSourceFacts;
    });
  }

  async documentIdForRevision(revisionId: RevisionId): Promise<DocumentId | null> {
    return this.unitOfWork.run(async () => {
      const revision = await requireTransaction().documentRevision.findFirst({
        where: { id: revisionId, tenantId: requireContext().tenantId },
        select: { documentId: true },
      });
      return revision === null ? null : asId<DocumentId>(revision.documentId);
    });
  }

  async findableIdsAfter(cursor: DocumentId | null, limit: number): Promise<readonly DocumentId[]> {
    return this.unitOfWork.run(async () => {
      const rows = await requireTransaction().document.findMany({
        where: {
          tenantId: requireContext().tenantId,
          deletedAt: null,
          status: { not: 'PURGED' },
          ...(cursor === null ? {} : { id: { gt: cursor } }),
        },
        orderBy: { id: 'asc' },
        take: limit,
        select: { id: true },
      });
      return rows.map((row) => asId<DocumentId>(row.id));
    });
  }

  /**
   * The same enumeration, narrowed to one scope node's subtree.
   *
   * How a node becomes a document predicate depends on the node. A folder is a path prefix — the
   * property ADR-0014 exists for. A library is a column. A document is itself. The organisation
   * nodes above a library are *not* resolved here: an entry on a department reaches its libraries,
   * and resolving that would be a second implementation of `ScopeChainReader.librariesUnder` in a
   * module that has no business knowing the organisation tree. Those reproject the whole tenant
   * instead, which the consumer says out loud in its log rather than doing quietly — see
   * `search-index.consumer.ts`.
   */
  async findableIdsUnderScope(
    scope: { readonly type: string; readonly id: string },
    cursor: DocumentId | null,
    limit: number,
  ): Promise<readonly DocumentId[]> {
    return this.unitOfWork.run(async () => {
      const tx = requireTransaction();
      const { tenantId } = requireContext();
      const narrowing = await this.narrowingFor(scope);
      if (narrowing === null) {
        return [];
      }
      const rows = await tx.document.findMany({
        where: {
          tenantId,
          deletedAt: null,
          status: { not: 'PURGED' },
          ...narrowing,
          ...(cursor === null ? {} : { id: { gt: cursor } }),
        },
        orderBy: { id: 'asc' },
        take: limit,
        select: { id: true },
      });
      return rows.map((row) => asId<DocumentId>(row.id));
    });
  }

  /** Null means "this node does not narrow" — the caller reprojects the tenant. */
  private async narrowingFor(scope: {
    readonly type: string;
    readonly id: string;
  }): Promise<Record<string, unknown> | null> {
    if (scope.type === 'DOCUMENT') {
      return { id: scope.id };
    }
    if (scope.type === 'LIBRARY') {
      return { folder: { libraryId: scope.id } };
    }
    if (scope.type === 'FOLDER') {
      const folder = await requireTransaction().folder.findFirst({
        where: { id: scope.id, tenantId: requireContext().tenantId },
        select: { path: true },
      });
      return folder === null
        ? // The folder is gone. Nothing to narrow to, and nothing beneath it to reproject.
          { id: NO_SUCH_DOCUMENT }
        : { folder: { OR: [{ path: folder.path }, { path: { startsWith: `${folder.path}.` } }] } };
    }
    return null;
  }

  async typeIdByCode(code: string): Promise<string | null> {
    return this.unitOfWork.run(async () => {
      const type = await requireTransaction().documentType.findFirst({
        where: {
          tenantId: requireContext().tenantId,
          code: { equals: code, mode: 'insensitive' },
          deletedAt: null,
        },
        select: { id: true },
      });
      return type?.id ?? null;
    });
  }

  /** Entity, department and branch, derived from the library's owner node. */
  private async placementOf(library: {
    readonly libraryId: string;
    readonly scopeType: string | null;
    readonly scopeId: string | null;
  }): Promise<{
    readonly entityId: string | null;
    readonly departmentId: string | null;
    readonly branchId: string | null;
  }> {
    const none = { entityId: null, departmentId: null, branchId: null };
    if (library.scopeId === null) {
      return none;
    }
    const tx = requireTransaction();
    const tenantId = requireContext().tenantId;
    if (library.scopeType === 'ENTITY') {
      return { ...none, entityId: library.scopeId };
    }
    if (library.scopeType === 'DEPARTMENT') {
      const department = await tx.department.findFirst({
        where: { id: library.scopeId, tenantId },
        select: { id: true, entityId: true, branchId: true },
      });
      return department === null
        ? none
        : {
            entityId: department.entityId,
            departmentId: department.id,
            branchId: department.branchId,
          };
    }
    // TENANT and COMPANY owners place a library above the entity level; the filter columns
    // stay null and the document is findable through every other facet.
    return none;
  }
}

type MetadataValueRow = {
  readonly metadataFieldId: string;
  readonly textValue: string | null;
  readonly numberValue: { toString(): string } | null;
  readonly dateValue: Date | null;
  readonly booleanValue: boolean | null;
  readonly referenceValue: string | null;
  readonly selectValues: readonly string[];
  readonly field: {
    readonly id: string;
    readonly isSearchable: boolean;
    readonly dataType: string;
  };
};

/**
 * Metadata twice over: every value keyed by field id for display and `meta.<fieldId>`
 * filters, and the searchable fields' words for the B weight. Numbers, dates, booleans and
 * references are filterable facts, not words — they stay out of the text.
 */
function collectMetadata(rows: readonly MetadataValueRow[]): {
  readonly values: Readonly<Record<string, unknown>>;
  readonly searchableText: string;
} {
  const values: Record<string, unknown> = {};
  const searchable: string[] = [];
  for (const row of rows) {
    const value =
      row.textValue ??
      row.numberValue?.toString() ??
      row.dateValue?.toISOString() ??
      row.booleanValue ??
      row.referenceValue ??
      (row.selectValues.length > 0 ? row.selectValues : null);
    if (value !== null) {
      values[row.metadataFieldId] = value;
    }
    if (row.field.isSearchable) {
      if (row.textValue !== null) {
        searchable.push(row.textValue);
      }
      searchable.push(...row.selectValues);
    }
  }
  return { values, searchableText: searchable.join('\n') };
}

/** A folder that vanished narrows to nothing rather than to everything. */
const NO_SUCH_DOCUMENT = '00000000-0000-0000-0000-000000000000';
