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
import type { Page, PageRequest } from '@edms/utils';

import type { MetadataColumns } from '../domain/metadata';

/**
 * The product's root aggregate.
 *
 * Its identity never changes: not when it is revised, not when it moves folder, not when it
 * is archived (`docs/architecture/03-domain-model.md` §3).
 */
export const DOCUMENT_REPOSITORY = Symbol('DocumentRepository');
export const DOCUMENT_LOCK_REPOSITORY = Symbol('DocumentLockRepository');
export const DOCUMENT_QUERY_SERVICE = Symbol('DocumentQueryService');

/**
 * Two ports this module *declares* and another module *implements*.
 *
 * The dependency direction between modules is fixed: a module may call downward and publish
 * upward, and Revision and Storage both sit below Document in that order — Revision depends on
 * Document, not the other way round. But creating a document creates its first revision and
 * references its first blob, and all three have to commit together: a document with no revision is
 * a document with no content, and a revision holding a blob nothing counted is a blob retention
 * will delete underneath it.
 *
 * So the dependency is inverted rather than reversed. Document declares what it needs, in its own
 * vocabulary, here. Revision and Storage implement it, and the composition root binds them. Nothing
 * in Document imports either module, which is what the boundary lint checks and what keeps the
 * direction honest — the Nest import in `document.module.ts` is wiring, and it points the way DI
 * wiring always points: from the consumer to the container entry that satisfies it.
 */
export const REVISION_WRITER = Symbol('RevisionWriter');
export const DOCUMENT_CONTENT_GATE = Symbol('DocumentContentGate');

export interface DocumentRecord {
  readonly id: DocumentId;
  readonly folderId: FolderId;
  readonly documentTypeId: DocumentTypeId;
  readonly categoryId: CategoryId | null;
  readonly confidentialityId: string;
  readonly retentionPolicyId: string | null;
  readonly title: string;
  readonly description: string | null;
  readonly status: DocumentStatusKey;
  readonly origin: DocumentOriginKey;
  /** Assigned at approval, then immutable — and never reused, even after deletion. */
  readonly documentNumber: string | null;
  readonly ownerUserId: UserId;
  readonly currentRevisionId: RevisionId | null;
  readonly latestRevisionId: RevisionId | null;
  readonly createdAt: Date;
  readonly createdBy: string | null;
  readonly updatedAt: Date;
  readonly updatedBy: string | null;
  readonly deletedAt: Date | null;
  readonly deletedBy: string | null;
  readonly version: number;
}

/** A document with everything a screen renders, joined once rather than per row. */
export interface DocumentRow extends DocumentRecord {
  readonly folderName: string;
  readonly folderPath: string;
  readonly libraryId: string;
  readonly libraryName: string;
  readonly documentTypeName: string;
  readonly categoryName: string | null;
  readonly confidentialityName: string;
  readonly confidentialityRank: number;
  readonly isFavorite: boolean;
  readonly latestRevision: RevisionView | null;
  readonly metadata: readonly MetadataView[];
}

export interface RevisionView {
  readonly id: string;
  readonly ordinal: number;
  readonly label: string;
  readonly status: RevisionStatusKey;
  readonly changeNote: string | null;
  readonly createdAt: Date;
  readonly createdBy: string | null;
  readonly file: FileView;
}

/** What the bytes are — never mixed with what the document means. */
export interface FileView {
  readonly fileObjectId: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly checksumSha256: string;
  readonly scanStatus: ScanStatusKey;
  readonly thumbnailFileObjectId: string | null;
}

export interface MetadataView {
  readonly fieldId: string;
  readonly key: string;
  readonly name: string;
  readonly dataType: MetadataDataTypeKey;
  readonly isRequired: boolean;
  readonly columns: MetadataColumns;
}

export interface DocumentListRequest extends PageRequest {
  readonly search?: string | undefined;
  readonly deleted: 'live' | 'deleted' | 'all';
  readonly sortBy?: string | undefined;
  readonly sortDirection: 'asc' | 'desc';
  readonly folderId?: string | undefined;
  /** Everything beneath this folder, by materialised path — what "include subfolders" means. */
  readonly underFolderId?: string | undefined;
  readonly libraryId?: string | undefined;
  readonly documentTypeId?: string | undefined;
  readonly categoryId?: string | undefined;
  readonly confidentialityId?: string | undefined;
  readonly status?: DocumentStatusKey | undefined;
  readonly ownerUserId?: string | undefined;
  readonly favorite?: boolean | undefined;
}

export interface NewDocument {
  readonly id: string;
  readonly folderId: string;
  readonly documentTypeId: string;
  readonly categoryId: string | null;
  readonly confidentialityId: string;
  readonly retentionPolicyId: string | null;
  readonly title: string;
  readonly description: string | null;
  readonly origin: DocumentOriginKey;
  readonly ownerUserId: string;
}

export interface DocumentRepository {
  findById(id: DocumentId, includeDeleted: boolean): Promise<DocumentRow | null>;
  list(request: DocumentListRequest): Promise<Page<DocumentRow>>;
  insert(document: NewDocument): Promise<void>;
  update(
    id: DocumentId,
    expectedVersion: number,
    patch: {
      title?: string;
      description?: string | null;
      categoryId?: string | null;
      confidentialityId?: string;
    },
  ): Promise<void>;
  move(id: DocumentId, expectedVersion: number, folderId: string): Promise<void>;
  /**
   * Moves the document's lifecycle status.
   *
   * Its own method rather than a field on `update`, because a status is never something a caller
   * sets while editing a title: every transition is checked against the table in
   * `domain/lifecycle.ts` and audited with both halves of the pair. A `status` that could arrive in
   * a patch would be a way to publish a document by including a field in a form post.
   */
  setStatus(id: DocumentId, expectedVersion: number, status: DocumentStatusKey): Promise<void>;
  setDeleted(id: DocumentId, expectedVersion: number, deleted: boolean): Promise<void>;
  /** Called by the revision writer's caller once the first revision exists. */
  attachLatestRevision(id: DocumentId, revisionId: string): Promise<void>;
  replaceMetadata(id: DocumentId, values: ReadonlyMap<string, MetadataColumns>): Promise<void>;

  /** The library's own read of the folder tree: how many documents sit beneath a folder. */
  countUnderFolderPath(path: string): Promise<number>;

  /**
   * Documents whose latest revision is exactly these bytes.
   *
   * The duplicate warning, and the reason it costs nothing: content addressing already made
   * identical files one blob, so "is this a duplicate" is a lookup by file object rather than a
   * comparison of anything.
   */
  findByFileObject(fileObjectId: string): Promise<readonly DuplicateMatchRow[]>;
}

export interface DuplicateMatchRow {
  readonly documentId: string;
  readonly title: string;
  readonly documentNumber: string | null;
  readonly folderName: string;
  readonly folderPath: string;
  readonly createdAt: Date;
}

/** Favourites and recents: two lists that are one person's, not the tenant's. */
export const DOCUMENT_ACTIVITY_REPOSITORY = Symbol('DocumentActivityRepository');

export interface DocumentActivityRepository {
  addFavorite(userId: string, documentId: string): Promise<void>;
  removeFavorite(userId: string, documentId: string): Promise<void>;
  isFavorite(userId: string, documentId: string): Promise<boolean>;
  /** One row per (user, document), moved forward rather than appended. */
  recordView(userId: string, documentId: string, at: Date): Promise<void>;
  listRecent(userId: string, request: PageRequest): Promise<Page<RecentRow>>;
}

export interface RecentRow {
  readonly document: DocumentRow;
  readonly viewedAt: Date;
}

/**
 * What Document needs from Revision, in Document's own words.
 *
 * Implemented in the Revision module, which owns `document_revision` and everything that will
 * later be done to one. Phase 3 needs exactly one operation — create the first revision — because
 * check-out, check-in, compare and restore are Phase 6's and publishing is Phase 4's.
 */
export interface RevisionWriter {
  createInitial(input: {
    documentId: string;
    fileObjectId: string;
    filename: string;
    changeNote: string | null;
    labelStyle: string;
  }): Promise<{ readonly revisionId: string; readonly label: string }>;
}

/**
 * What Document needs from Storage, in Document's own words.
 *
 * Deliberately narrower than `StorageService`: Document may ask whether a blob is attachable, take
 * a reference on it, give one back, and get a link to it. It may not create an upload, complete
 * one, or delete a blob — those belong to the module that owns the bytes, and a document use case
 * that could delete a blob is a document use case that can delete another document's content.
 */
export interface DocumentContentGate {
  describe(fileObjectId: string): Promise<AttachableFile | null>;
  reference(fileObjectId: string): Promise<void>;
  dereference(fileObjectId: string): Promise<void>;
  downloadUrl(
    fileObjectId: string,
    filename: string,
    options?: { inline?: boolean },
  ): Promise<{ url: string; expiresAt: Date }>;
}

export interface AttachableFile {
  readonly fileObjectId: string;
  readonly checksumSha256: string;
  readonly sizeBytes: number;
  readonly mimeType: string;
  readonly scanStatus: ScanStatusKey;
}

export const DOCUMENT_SERVICE = Symbol('DocumentService');

/** What other modules may ask of Document. They never touch its repositories. */
export interface DocumentService {
  get(id: DocumentId): Promise<DocumentRecord | null>;
  exists(id: DocumentId): Promise<boolean>;
  /** The transitions this caller may perform right now, computed server-side. */
  availableTransitions(id: DocumentId): Promise<readonly DocumentStatusKey[]>;
}
