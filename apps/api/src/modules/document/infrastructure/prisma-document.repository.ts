import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { Permission, type AnyId, asId } from '@edms/domain';
import type {
  CategoryId,
  DocumentId,
  DocumentOriginKey,
  DocumentStatusKey,
  DocumentTypeId,
  FolderId,
  MetadataDataTypeKey,
  RevisionId,
  RevisionStatusKey,
  ScanStatusKey,
  UserId,
} from '@edms/domain';
import { type Page, toPage } from '@edms/utils';

import {
  ACL_RESOLVER,
  type AclResolver,
  type VisibilityRegion,
} from '../../../core/authorization/acl-resolver.port';
import { VersionConflictError } from '../../../core/errors/application-errors';
import {
  RecordStamps,
  deletedCondition,
  orderByFor,
  pageArgs,
  searchConditions,
} from '../../../core/persistence';
import { requireTransaction } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';
import type { MetadataColumns } from '../domain/metadata';
import type {
  CascadedDocument,
  DocumentListRequest,
  DocumentRepository,
  DocumentRow,
  DuplicateMatchRow,
  NewDocument,
} from '../application/ports';

/**
 * Documents, in the database.
 *
 * Three things here are specific to this table rather than to the repository shape.
 *
 * **A list is one query with its joins, never a query per row.** A folder of two hundred documents
 * renders the type's name, the category's name, the confidentiality level, the folder and the
 * latest revision's file for each of them — six lookups a row if the naive thing is done, and the
 * naive thing is what makes a document system feel slow at exactly the scale customers reach
 * (`19-performance-and-scalability.md`).
 *
 * **"Everything beneath this folder" is a path prefix, not a recursive walk.** The materialised
 * path is what ADR-0014 is for, and `path LIKE 'a.b.%'` is an index range scan whatever the depth.
 *
 * **Favourites are joined per caller, not per tenant.** `isFavorite` is one person's answer, so the
 * join carries the acting user — and a list rendered for two people is two different lists in that
 * one column.
 *
 * **The ACL predicate is in `whereFor`, not in the service** — Phase 14's addition, and the reason
 * is Phase 13's report. The dashboard's counts are built from *this function*, so putting the
 * predicate here is what makes its claim true: the counts inherit the ACL filter "in the same commit
 * and without `dashboard.service.ts` changing". Putting it in `DefaultDocumentService.list` would
 * have filtered the list and left every count beside it describing a different set of rows — which
 * is exactly the divergence 08 §7's Query row exists to prevent, arriving through the one door
 * nobody was watching.
 *
 * It is pushed into SQL rather than applied after the fetch, for §7's stated reason: fetch-then-
 * filter leaks totals, facet counts and page boundaries. A document the caller may not reach is
 * **absent** from the list and from its total, not present-and-hidden.
 */
@Injectable()
export class PrismaDocumentRepository implements DocumentRepository {
  constructor(
    private readonly stamps: RecordStamps,
    @Inject(ACL_RESOLVER) private readonly acl: AclResolver,
  ) {}

  async findById(id: DocumentId, includeDeleted: boolean): Promise<DocumentRow | null> {
    const row = await requireTransaction().document.findFirst({
      where: {
        id,
        tenantId: this.tenantId(),
        ...(includeDeleted ? {} : { deletedAt: null }),
      },
      include: this.include(),
    });
    return row === null ? null : toRow(row, this.actorId());
  }

  async list(request: DocumentListRequest): Promise<Page<DocumentRow>> {
    const tx = requireTransaction();
    const where = await this.whereFor(request);

    const [rows, total] = await Promise.all([
      tx.document.findMany({
        where,
        orderBy: orderByFor(
          request.sortBy as 'title' | undefined,
          request.sortDirection,
          'updatedAt',
        ),
        ...pageArgs(request),
        include: this.include(),
      }),
      tx.document.count({ where }),
    ]);

    return toPage(
      rows.map((row) => toRow(row, this.actorId())),
      total,
      request,
    );
  }

  async insert(document: NewDocument): Promise<void> {
    await requireTransaction().document.create({
      data: {
        id: document.id,
        tenantId: this.tenantId(),
        folderId: document.folderId,
        documentTypeId: document.documentTypeId,
        categoryId: document.categoryId,
        confidentialityId: document.confidentialityId,
        retentionPolicyId: document.retentionPolicyId,
        title: document.title,
        description: document.description,
        origin: document.origin,
        ownerUserId: document.ownerUserId,
        ...this.stamps.creation(),
      },
    });
  }

  async update(
    id: DocumentId,
    expectedVersion: number,
    patch: {
      title?: string;
      description?: string | null;
      categoryId?: string | null;
      confidentialityId?: string;
    },
  ): Promise<void> {
    await this.versioned(id, expectedVersion, patch);
  }

  async move(id: DocumentId, expectedVersion: number, folderId: string): Promise<void> {
    await this.versioned(id, expectedVersion, { folderId });
  }

  /**
   * Moves the lifecycle status.
   *
   * Guarded on the version like every other write here, so a decision taken against a document
   * somebody has since edited loses rather than overwriting. The transition's *legality* is checked
   * in the use case against the table; this is the write that follows it.
   */
  async setStatus(
    id: DocumentId,
    expectedVersion: number,
    status: DocumentStatusKey,
  ): Promise<void> {
    const { count } = await requireTransaction().document.updateMany({
      where: { id, tenantId: this.tenantId(), version: expectedVersion, deletedAt: null },
      data: { status, ...this.stamps.update(), version: expectedVersion + 1 },
    });
    if (count === 0) {
      throw new VersionConflictError(expectedVersion, expectedVersion);
    }
  }

  async assignNumber(id: DocumentId, documentNumber: string, at: Date): Promise<boolean> {
    // `documentNumber: null` in the WHERE is the write-once rule itself: a numbered document
    // matches no rows, whatever raced ahead of this statement. No version check — the caller
    // holds the approval's transaction, and a number is never a lost-update casualty.
    const result = await requireTransaction().document.updateMany({
      where: { id, tenantId: this.tenantId(), documentNumber: null, deletedAt: null },
      data: {
        documentNumber,
        numberedAt: at,
        ...this.stamps.update(),
        version: { increment: 1 },
      },
    });
    return result.count > 0;
  }

  async setDeleted(
    id: DocumentId,
    expectedVersion: number,
    deleted: boolean,
    marks?: { readonly reason: string | null; readonly cascadeId: string | null },
  ): Promise<void> {
    await this.versioned(
      id,
      expectedVersion,
      deleted
        ? {
            ...this.stamps.deletion(),
            deleteReason: marks?.reason ?? null,
            deleteCascadeId: marks?.cascadeId ?? null,
          }
        : // The restore clears both marks with the delete columns: a reason describes a delete
          // that is no longer in force, and a cascade identifier left behind would make a later
          // delete of the same subtree indistinguishable from this one.
          { ...this.stamps.restoration(), deleteReason: null, deleteCascadeId: null },
      // Both directions need to find the row whatever its current delete state, so the predicate
      // cannot filter on `deleted_at` the way every other write here does.
      true,
    );
  }

  async cascadeIdOf(id: DocumentId): Promise<string | null> {
    const row = await requireTransaction().document.findFirst({
      where: { id, tenantId: this.tenantId() },
      select: { deleteCascadeId: true },
    });
    return row?.deleteCascadeId ?? null;
  }

  async cascadeDeleteUnderFolder(input: {
    folderId: string;
    path: string;
    cascadeId: string;
  }): Promise<readonly CascadedDocument[]> {
    const tx = requireTransaction();
    const tenantId = this.tenantId();
    // Read first, then stamp: the caller needs each document's number and frozen policy to write
    // its schedule, and the update alone would not say which rows it took.
    const rows = await tx.document.findMany({
      where: {
        tenantId,
        deletedAt: null,
        folder: { OR: [{ path: input.path }, { path: { startsWith: `${input.path}.` } }] },
      },
      select: { id: true, documentNumber: true, retentionPolicyId: true },
    });
    if (rows.length === 0) {
      return [];
    }
    await tx.document.updateMany({
      where: { id: { in: rows.map((row) => row.id) }, tenantId },
      // No reason of its own: the folder delete is the reason, recorded on the folder's audit
      // event, and the shared cascade identifier is what ties each row to it.
      data: { ...this.stamps.deletion(), deleteCascadeId: input.cascadeId },
    });
    return rows;
  }

  async listCascade(cascadeId: string): Promise<readonly CascadedDocument[]> {
    return requireTransaction().document.findMany({
      where: { tenantId: this.tenantId(), deleteCascadeId: cascadeId, deletedAt: { not: null } },
      select: { id: true, documentNumber: true, retentionPolicyId: true },
    });
  }

  async restoreCascade(cascadeId: string): Promise<number> {
    const { count } = await requireTransaction().document.updateMany({
      where: { tenantId: this.tenantId(), deleteCascadeId: cascadeId, deletedAt: { not: null } },
      data: { ...this.stamps.restoration(), deleteReason: null, deleteCascadeId: null },
    });
    return count;
  }

  async attachLatestRevision(id: DocumentId, revisionId: string): Promise<void> {
    // Not versioned: this runs inside the same transaction that created the document, a few
    // statements after the insert, and there is no concurrent writer to lose to. Bumping the
    // version here would hand the caller a stale one for the `If-Match` it is about to be given.
    await requireTransaction().document.updateMany({
      where: { id, tenantId: this.tenantId() },
      data: { latestRevisionId: revisionId },
    });
  }

  async setCurrentRevision(id: DocumentId, revisionId: string): Promise<void> {
    // Not versioned for the same reason `attachLatestRevision` is not: publication has already
    // taken the document row under its own version guard a statement earlier, and bumping again
    // here would hand the caller a stale `If-Match`.
    await requireTransaction().document.updateMany({
      where: { id, tenantId: this.tenantId() },
      data: { currentRevisionId: revisionId },
    });
  }

  /**
   * Replaces every metadata value in one statement pair.
   *
   * Delete-then-insert rather than a per-field upsert, because a patch that supplies four of a
   * type's ten fields means the other six are *cleared*, not left alone — the caller has already
   * decided that, in `coerceMetadata`, and doing it here in two statements is what keeps the
   * document's values and the type's field list from drifting apart.
   */
  async replaceMetadata(
    id: DocumentId,
    values: ReadonlyMap<string, MetadataColumns>,
  ): Promise<void> {
    const tx = requireTransaction();
    await tx.documentMetadataValue.deleteMany({ where: { documentId: id } });
    if (values.size === 0) {
      return;
    }
    const stamps = this.stamps.creation();
    await tx.documentMetadataValue.createMany({
      data: [...values].map(([metadataFieldId, columns]) => ({
        tenantId: this.tenantId(),
        documentId: id,
        metadataFieldId,
        textValue: columns.textValue,
        numberValue: columns.numberValue === null ? null : new Prisma.Decimal(columns.numberValue),
        dateValue: columns.dateValue,
        booleanValue: columns.booleanValue,
        referenceValue: columns.referenceValue,
        selectValues: [...columns.selectValues],
        ...stamps,
      })),
    });
  }

  async countUnderFolderPath(path: string): Promise<number> {
    return requireTransaction().document.count({
      where: {
        tenantId: this.tenantId(),
        deletedAt: null,
        folder: { OR: [{ path }, { path: { startsWith: `${path}.` } }] },
      },
    });
  }

  async findByFileObject(fileObjectId: string): Promise<readonly DuplicateMatchRow[]> {
    const rows = await requireTransaction().document.findMany({
      where: {
        tenantId: this.tenantId(),
        deletedAt: null,
        revisions: { some: { fileObjectId, deletedAt: null } },
      },
      select: {
        id: true,
        title: true,
        documentNumber: true,
        createdAt: true,
        folder: { select: { name: true, path: true } },
      },
      // Bounded: a warning listing eleven documents and a warning listing four hundred say the
      // same thing to the person reading it, and the second costs a page of rows to say it.
      take: DUPLICATE_LIMIT,
      orderBy: { createdAt: Prisma.SortOrder.asc },
    });
    return rows.map((row) => ({
      documentId: row.id,
      title: row.title,
      documentNumber: row.documentNumber,
      folderName: row.folder.name,
      folderPath: row.folder.path,
      createdAt: row.createdAt,
    }));
  }

  // --- Internals ---------------------------------------------------------------------------

  /**
   * The predicate every list, count and metric in this module is built from.
   *
   * `public` since Phase 13, and that is the whole of how the dashboard avoids inventing a second
   * definition of anything: `DashboardDocumentMetrics` counts through *this* function, so the tile
   * that says "4 drafts" and the list the tile links to cannot describe different sets of rows.
   * A metrics adapter with its own `where` object would have been four lines shorter and one
   * release away from disagreeing.
   */
  async whereFor(request: DocumentListRequest): Promise<Prisma.DocumentWhereInput> {
    const tenantId = this.tenantId();
    const subtree =
      request.underFolderId === undefined
        ? null
        : await requireTransaction().folder.findFirst({
            where: { id: request.underFolderId, tenantId, deletedAt: null },
            select: { path: true },
          });

    return {
      tenantId,
      ...(await this.visibilityCondition()),
      deletedAt: deletedCondition(request.deleted),
      ...(request.folderId !== undefined && { folderId: request.folderId }),
      ...(subtree !== null && {
        folder: { OR: [{ path: subtree.path }, { path: { startsWith: `${subtree.path}.` } }] },
      }),
      ...(request.underFolderId !== undefined &&
        subtree === null && {
          // The folder named does not exist. Matching nothing is the honest answer; ignoring the
          // filter would silently widen the list to the whole tenant.
          id: NO_SUCH_ID,
        }),
      ...(request.libraryId !== undefined && { folder: { libraryId: request.libraryId } }),
      ...(request.documentTypeId !== undefined && { documentTypeId: request.documentTypeId }),
      ...(request.categoryId !== undefined && { categoryId: request.categoryId }),
      ...(request.confidentialityId !== undefined && {
        confidentialityId: request.confidentialityId,
      }),
      ...(request.status !== undefined && { status: request.status }),
      ...(request.ownerUserId !== undefined && { ownerUserId: request.ownerUserId }),
      ...(request.favorite === true && {
        favorites: { some: { userId: this.actorId() ?? NO_SUCH_ID } },
      }),
      ...(request.lockedByMe === true && {
        locks: { some: liveLockOf(this.actorId() ?? NO_SUCH_ID, this.stamps.now()) },
      }),
      OR: searchConditions(request.search, ['title', 'description', 'documentNumber']),
    };
  }

  /**
   * 08 §7's Query row: the caller's reach, as a `WHERE`.
   *
   * Resolved through `ACL_RESOLVER` — the same implementation that answers `AclGuard` and that
   * materialises the search index's `acl_subjects` — so a document present in this list is one a
   * direct read would return, and one absent from it is one a direct read would `404`.
   *
   * **A system run is not filtered, and that is not a hole.** `userId` is null only for the outbox
   * consumers and the schedules, which have no reach question to answer: the search projection
   * materialises an entry's answer *for everybody*, so filtering its source read by the reach of a
   * caller that does not exist would produce an index that shows nobody anything. Row-level
   * security is still the boundary on that path, as it is on every other.
   */
  private async visibilityCondition(): Promise<Prisma.DocumentWhereInput> {
    const context = requireContext();
    if (context.userId === null) {
      return {};
    }
    const filter = await this.acl.visibilityFilter(
      {
        userId: asId(context.userId),
        roleIds: context.roles.map((role) => asId<AnyId>(role)),
        departmentIds: [],
        delegationIds: [],
      },
      Permission.DOCUMENT_VIEW,
    );

    const allowed = filter.allowedRegions.map((region) => regionCondition(region));
    const denied = filter.deniedRegions
      .map((region) => regionCondition(region))
      .filter((condition) => !isUnconditional(condition));

    // An **unconditional** allowed region — the tenant-level role grant with no inheritance break
    // to cut out of it — is not `OR: [{}]`. Prisma does not read an empty object inside an `OR` as
    // "everything"; it reads it as a branch with no condition and drops it, so a caller who could
    // see the whole tenant would see nothing. The unconditional case is the overwhelming majority
    // of requests, so it is spelled as the absence of an allow clause rather than as a branch.
    const unconditional = allowed.some(isUnconditional);
    return {
      AND: [
        // No allowed region at all is the closed default, spelled as a predicate that matches
        // nothing rather than as an omitted clause — an omitted clause is one refactor away from
        // reading as "no restriction", which is the wrong direction for this file to fail in.
        ...(unconditional ? [] : [allowed.length === 0 ? { id: NO_SUCH_ID } : { OR: allowed }]),
        ...(denied.length === 0 ? [] : [{ NOT: { OR: denied } }]),
      ],
    };
  }

  private async versioned(
    id: DocumentId,
    expectedVersion: number,
    data: Record<string, unknown>,
    includeDeleted = false,
  ): Promise<void> {
    const { count } = await requireTransaction().document.updateMany({
      // The version is in the *predicate*. A concurrent writer that already moved it on matches
      // nothing here, so the loser of a race fails loudly rather than overwriting silently.
      where: {
        id,
        tenantId: this.tenantId(),
        version: expectedVersion,
        ...(includeDeleted ? {} : { deletedAt: null }),
      },
      data: { ...data, version: expectedVersion + 1, ...this.stamps.update() },
    });
    if (count === 0) {
      throw new VersionConflictError(expectedVersion, expectedVersion + 1);
    }
  }

  /**
   * Everything a document row renders, in one query.
   *
   * `revisions` is taken newest-first with a limit of one: the latest revision is what Phase 3
   * shows, and ordering plus `take` is an index lookup rather than a load of the whole history.
   */
  private include() {
    return {
      folder: {
        select: { name: true, path: true, libraryId: true, library: { select: { name: true } } },
      },
      documentType: { select: { name: true, revisionLabelStyle: true } },
      category: { select: { name: true } },
      confidentiality: { select: { name: true, rank: true } },
      revisions: {
        where: { deletedAt: null },
        orderBy: { ordinal: Prisma.SortOrder.desc },
        take: 1,
        include: {
          fileObject: true,
          previews: { where: { kind: 'THUMBNAIL' as const }, take: 1 },
        },
      },
      // The published revision, when one exists. Its own join rather than a second scan of
      // `revisions`: what a reader reads is `current_revision_id`'s row, and after a check-in
      // the latest revision is an unapproved draft that must not stand in for it.
      currentRevision: {
        include: {
          fileObject: true,
          previews: { where: { kind: 'THUMBNAIL' as const }, take: 1 },
        },
      },
      // The live lock, so "checked out by whom, until when" renders without a second call.
      locks: {
        where: { releasedAt: null },
        take: 1,
        include: { holder: { select: { displayName: true } } },
      },
      metadataValues: { include: { field: true } },
      favorites: { where: { userId: this.actorId() ?? NO_SUCH_ID }, take: 1 },
    };
  }

  private tenantId(): string {
    return requireContext().tenantId;
  }

  private actorId(): string | null {
    return requireContext().userId;
  }
}

/** A page of duplicates nobody reads is a page of duplicates nobody needed. */
const DUPLICATE_LIMIT = 20;

/** A UUID nothing will ever have, for a filter that must match no rows rather than all of them. */
const NO_SUCH_ID = '00000000-0000-0000-0000-000000000000';

/**
 * One person's *live* check-out claims — the predicate behind "Checked Out".
 *
 * Exported so the dashboard's metrics adapter counts through the same three conditions the list
 * filters on. All three matter: released locks are history and the table keeps them on purpose,
 * and an expired lock is one the next operation on the document will sweep aside — counting either
 * would tell somebody they hold a claim they do not.
 */
export function liveLockOf(userId: string, now: Date): Prisma.DocumentLockWhereInput {
  return { lockedBy: userId, releasedAt: null, expiresAt: { gt: now } };
}

// --- Mapping ----------------------------------------------------------------------------

interface JoinedRow {
  id: string;
  folderId: string;
  documentTypeId: string;
  categoryId: string | null;
  confidentialityId: string;
  retentionPolicyId: string | null;
  title: string;
  description: string | null;
  status: string;
  origin: string;
  documentNumber: string | null;
  numberedAt: Date | null;
  ownerUserId: string;
  currentRevisionId: string | null;
  latestRevisionId: string | null;
  createdAt: Date;
  createdBy: string | null;
  updatedAt: Date;
  updatedBy: string | null;
  deletedAt: Date | null;
  deletedBy: string | null;
  version: number;
  folder: { name: string; path: string; libraryId: string; library: { name: string } };
  documentType: { name: string };
  category: { name: string } | null;
  confidentiality: { name: string; rank: number };
  revisions: readonly JoinedRevision[];
  currentRevision: JoinedRevision | null;
  locks: readonly JoinedLock[];
  metadataValues: readonly JoinedMetadata[];
  favorites: readonly unknown[];
}

interface JoinedLock {
  id: string;
  lockedBy: string;
  draftRevisionId: string | null;
  acquiredAt: Date;
  expiresAt: Date;
  holder: { displayName: string } | null;
}

interface JoinedRevision {
  id: string;
  ordinal: number;
  label: string;
  status: string;
  changeNote: string | null;
  filename: string;
  createdAt: Date;
  createdBy: string | null;
  fileObject: {
    id: string;
    mimeType: string;
    sizeBytes: bigint;
    checksumSha256: string;
    scanStatus: string;
  };
  previews: readonly { fileObjectId: string }[];
}

interface JoinedMetadata {
  metadataFieldId: string;
  textValue: string | null;
  numberValue: Prisma.Decimal | null;
  dateValue: Date | null;
  booleanValue: boolean | null;
  referenceValue: string | null;
  selectValues: string[];
  field: { key: string; name: string; dataType: string };
}

function toRevisionView(revision: JoinedRevision) {
  return {
    id: revision.id,
    ordinal: revision.ordinal,
    label: revision.label,
    status: revision.status as RevisionStatusKey,
    changeNote: revision.changeNote,
    createdAt: revision.createdAt,
    createdBy: revision.createdBy,
    file: {
      fileObjectId: revision.fileObject.id,
      filename: revision.filename,
      mimeType: revision.fileObject.mimeType,
      sizeBytes: Number(revision.fileObject.sizeBytes),
      checksumSha256: revision.fileObject.checksumSha256,
      scanStatus: revision.fileObject.scanStatus as ScanStatusKey,
      thumbnailFileObjectId: revision.previews[0]?.fileObjectId ?? null,
    },
  };
}

function toRow(row: JoinedRow, _actorId: string | null): DocumentRow {
  const revision = row.revisions[0];
  const lock = row.locks[0];
  return {
    id: row.id as DocumentId,
    folderId: row.folderId as FolderId,
    documentTypeId: row.documentTypeId as DocumentTypeId,
    categoryId: row.categoryId as CategoryId | null,
    confidentialityId: row.confidentialityId,
    retentionPolicyId: row.retentionPolicyId,
    title: row.title,
    description: row.description,
    status: row.status as DocumentStatusKey,
    origin: row.origin as DocumentOriginKey,
    documentNumber: row.documentNumber,
    numberedAt: row.numberedAt,
    ownerUserId: row.ownerUserId as UserId,
    currentRevisionId: row.currentRevisionId as RevisionId | null,
    latestRevisionId: row.latestRevisionId as RevisionId | null,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
    deletedAt: row.deletedAt,
    deletedBy: row.deletedBy,
    version: row.version,
    folderName: row.folder.name,
    folderPath: row.folder.path,
    libraryId: row.folder.libraryId,
    libraryName: row.folder.library.name,
    documentTypeName: row.documentType.name,
    categoryName: row.category?.name ?? null,
    confidentialityName: row.confidentiality.name,
    confidentialityRank: row.confidentiality.rank,
    // The join was already restricted to the acting user, so a row present means this person
    // marked it. Counting rather than comparing keeps the answer where the query decided it.
    isFavorite: row.favorites.length > 0,
    latestRevision: revision === undefined ? null : toRevisionView(revision),
    currentRevision: row.currentRevision === null ? null : toRevisionView(row.currentRevision),
    liveLock:
      lock === undefined
        ? null
        : {
            id: lock.id,
            lockedBy: lock.lockedBy as UserId,
            lockedByName: lock.holder?.displayName ?? null,
            acquiredAt: lock.acquiredAt,
            expiresAt: lock.expiresAt,
            draftRevisionId: lock.draftRevisionId,
          },
    metadata: row.metadataValues.map((value) => ({
      fieldId: value.metadataFieldId,
      key: value.field.key,
      name: value.field.name,
      dataType: value.field.dataType as MetadataDataTypeKey,
      // The type's own `isRequired` lives on the join row between type and field; a document's
      // stored value does not carry it, and a screen rendering an existing document does not need
      // it — the form that edits one asks the type.
      isRequired: false,
      columns: {
        textValue: value.textValue,
        numberValue: value.numberValue === null ? null : value.numberValue.toString(),
        dateValue: value.dateValue,
        booleanValue: value.booleanValue,
        referenceValue: value.referenceValue,
        selectValues: value.selectValues,
      },
    })),
  };
}

/**
 * One `VisibilityRegion`, as a document predicate.
 *
 * A region is a container minus the folder subtrees that break inheritance below the node granting
 * it. The exclusions are why this is not simply "folder path starts with": a grant on a library
 * reaches every folder in it *except* the ones that stopped inheriting, and expressing that as
 * `IN (allowed folders)` would mean enumerating a tenant's folder tree on every list.
 *
 * `tenantWide` produces an empty object, which Prisma reads as "no additional condition" — the
 * tenant filter and RLS are still there, above it. That is the tenant-level role grant, and it is
 * the branch almost every request in almost every tenant takes.
 */
/** `{}` is Prisma's "no condition", and the one shape that must never sit inside an `OR`. */
function isUnconditional(condition: Prisma.DocumentWhereInput): boolean {
  return Object.keys(condition).length === 0;
}

function regionCondition(region: VisibilityRegion): Prisma.DocumentWhereInput {
  const bases: Prisma.DocumentWhereInput[] = [];
  if (region.tenantWide) {
    bases.push({});
  }
  if (region.libraryIds.length > 0) {
    bases.push({ folder: { libraryId: { in: [...region.libraryIds] } } });
  }
  for (const path of region.folderPaths) {
    bases.push({ folder: { OR: [{ path }, { path: { startsWith: `${path}.` } }] } });
  }
  if (region.documentIds.length > 0) {
    bases.push({ id: { in: [...region.documentIds] } });
  }
  if (bases.length === 0) {
    return { id: NO_SUCH_ID };
  }
  const base: Prisma.DocumentWhereInput =
    bases.length === 1 ? (bases[0] as Prisma.DocumentWhereInput) : { OR: bases };
  if (region.excludedFolderPaths.length === 0) {
    return base;
  }
  return {
    AND: [
      base,
      {
        NOT: {
          OR: region.excludedFolderPaths.map((path) => ({
            folder: { OR: [{ path }, { path: { startsWith: `${path}.` } }] },
          })),
        },
      },
    ],
  };
}
