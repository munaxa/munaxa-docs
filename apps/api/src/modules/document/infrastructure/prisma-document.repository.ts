import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

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
 */
@Injectable()
export class PrismaDocumentRepository implements DocumentRepository {
  constructor(private readonly stamps: RecordStamps) {}

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

  async setDeleted(id: DocumentId, expectedVersion: number, deleted: boolean): Promise<void> {
    await this.versioned(
      id,
      expectedVersion,
      deleted ? this.stamps.deletion() : this.stamps.restoration(),
      // Both directions need to find the row whatever its current delete state, so the predicate
      // cannot filter on `deleted_at` the way every other write here does.
      true,
    );
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

  private async whereFor(request: DocumentListRequest): Promise<Prisma.DocumentWhereInput> {
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
      OR: searchConditions(request.search, ['title', 'description', 'documentNumber']),
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
  metadataValues: readonly JoinedMetadata[];
  favorites: readonly unknown[];
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

function toRow(row: JoinedRow, _actorId: string | null): DocumentRow {
  const revision = row.revisions[0];
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
    latestRevision:
      revision === undefined
        ? null
        : {
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
