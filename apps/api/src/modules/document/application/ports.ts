import type {
  CategoryId,
  DocumentId,
  DocumentLockReleaseReasonKey,
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
  /** When the number was assigned. Set with `documentNumber` and only with it. */
  readonly numberedAt: Date | null;
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
  /** The published revision, when one exists — what a reader is reading. */
  readonly currentRevision: RevisionView | null;
  /** The live check-out lock, so a screen can say who holds it without a second call. */
  readonly liveLock: LockView | null;
  readonly metadata: readonly MetadataView[];
}

export interface LockView {
  readonly id: string;
  readonly lockedBy: UserId;
  readonly lockedByName: string | null;
  readonly acquiredAt: Date;
  readonly expiresAt: Date;
  /** Set once a check-in kept the lock: the working draft a cancel would discard. */
  readonly draftRevisionId: string | null;
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
  /**
   * Documents the *acting caller* holds a live check-out lock on — Phase 13's "Checked Out".
   *
   * A flag rather than a `lockedByUserId`, and the asymmetry with `ownerUserId` beside it is the
   * decision rather than an oversight. `DocumentRow.liveLock` already names the holder on every
   * row, so this is not a secrecy argument; it is a scope one. "What have I got checked out" is a
   * navigation question and the schema anticipated it — `ix_document_lock_holder` is indexed
   * `(tenant_id, locked_by)` and commented "What do I have checked out". "What has Bob got checked
   * out" is a *report* on a person's work in progress, and reports are Phase 15's, with their own
   * permission and their own export. Adding the identifier here would have shipped the second
   * question as a side effect of needing the first.
   *
   * "Live" means unexpired as well as unreleased: an expired lock excludes nobody and the next
   * operation on the document sweeps it aside (`10-revision-architecture.md`), so counting one
   * would tell somebody they still hold a claim the product has already let go of.
   */
  readonly lockedByMe?: boolean | undefined;
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
  /**
   * Writes the document's number, once.
   *
   * `document_number IS NULL` sits in the `WHERE`, so this is the write-once path rather than a
   * check that ran a moment earlier: zero rows matched means the document is already numbered —
   * or gone — and the caller refuses. There is no update path; the column is written here and
   * nowhere else, and never rewritten (`09-numbering-architecture.md` §5).
   */
  assignNumber(id: DocumentId, documentNumber: string, at: Date): Promise<boolean>;
  /**
   * Soft-deletes or restores the row.
   *
   * `marks` carries what Phase 10 added to the delete: the mandatory reason and the cascade
   * identifier that makes the restore exact. Both are cleared by the restore, exactly as the
   * folder repository clears its own cascade identifier.
   */
  setDeleted(
    id: DocumentId,
    expectedVersion: number,
    deleted: boolean,
    marks?: { readonly reason: string | null; readonly cascadeId: string | null },
  ): Promise<void>;
  /**
   * Soft-deletes every live document in the named folder and under its subtree path, stamped with
   * one cascade identifier — the folder delete's half of `DOCUMENT_DELETION_RULES`. Answers the
   * documents it took, so the caller can cascade their revisions and write their schedules.
   */
  cascadeDeleteUnderFolder(input: {
    readonly folderId: string;
    readonly path: string;
    readonly cascadeId: string;
  }): Promise<readonly CascadedDocument[]>;
  /** The documents one cascade took — exactly what its restore puts back. */
  listCascade(cascadeId: string): Promise<readonly CascadedDocument[]>;
  /** The cascade a document was removed by, or null if it was deleted before the mark existed. */
  cascadeIdOf(id: DocumentId): Promise<string | null>;
  /** Restores exactly the documents one cascade removed. */
  restoreCascade(cascadeId: string): Promise<number>;
  /** Called by the revision writer's caller once the first revision exists. */
  attachLatestRevision(id: DocumentId, revisionId: string): Promise<void>;
  /**
   * Points the document at its effective revision. Written by publication, inside the same
   * transaction that moved the revision to `PUBLISHED` — the two halves of "exactly one
   * published revision" commit together or not at all.
   */
  setCurrentRevision(id: DocumentId, revisionId: string): Promise<void>;
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

/** A document a cascade touched, with what its revisions and schedule need. */
export interface CascadedDocument {
  readonly id: string;
  readonly documentNumber: string | null;
  readonly retentionPolicyId: string | null;
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
 * Implemented in the Revision module, which owns `document_revision`. Phase 3 needed exactly one
 * operation — create the first revision — and Phase 6 is what the rest were waiting for: the next
 * revision at check-in, the status moves the two-machine model needs, publication with its
 * supersession, and the discard a cancelled check-out performs. Every operation joins the
 * caller's transaction, and the implementation publishes Revision's own events from inside it —
 * Document never has to know Revision's vocabulary to cause a fact in it.
 */
export interface RevisionWriter {
  createInitial(input: {
    documentId: string;
    fileObjectId: string;
    filename: string;
    changeNote: string | null;
    labelStyle: string;
  }): Promise<{ readonly revisionId: string; readonly label: string }>;

  /**
   * The next revision: ordinal max+1, `DRAFT`, labelled once in the type's style against the
   * document's real publication lineage. `restoredFromRevisionId` set when this is a restore —
   * the row that makes "a new revision carrying an older revision's content" provable.
   */
  createNext(input: {
    documentId: string;
    fileObjectId: string;
    filename: string;
    changeNote: string | null;
    labelStyle: string;
    restoredFromRevisionId: string | null;
  }): Promise<{ readonly revisionId: string; readonly ordinal: number; readonly label: string }>;

  /** One revision, described. Null when it does not exist or belongs to another document. */
  describe(documentId: string, revisionId: string): Promise<RevisionFacts | null>;

  /** The published revision of a document, or null. The one `uq_revision_published` allows. */
  describePublished(documentId: string): Promise<RevisionFacts | null>;

  /**
   * Moves a revision between the working states (`DRAFT` ↔ `IN_APPROVAL`), guarded by what it
   * currently is: a revision in neither named state is left alone rather than corrupted, which
   * is what makes the engine's repeated transitions harmless.
   */
  setWorkingStatus(input: {
    revisionId: string;
    from: readonly RevisionStatusKey[];
    to: RevisionStatusKey;
  }): Promise<void>;

  /**
   * Publication's revision half, in one call so it is one fact: the prior published revision —
   * if any — moves to `SUPERSEDED` first, then this one to `PUBLISHED` with its effective window
   * and the metadata snapshot that proves what the approver saw. The order matters:
   * `uq_revision_published` is not deferrable, and it is the constraint that decides a race.
   */
  publish(input: {
    documentId: string;
    revisionId: string;
    publishedAt: Date;
    effectiveFrom: Date;
    effectiveTo: Date | null;
    metadataSnapshot: Readonly<Record<string, unknown>>;
  }): Promise<{ readonly supersededRevisionId: string | null }>;

  /** A draft abandoned by cancel or replaced by a further check-in. Kept, marked, evented. */
  discard(input: { documentId: string; revisionId: string }): Promise<void>;
  /**
   * The delete cascade's revision half: soft-deletes every live revision of the document, stamped
   * with the delete's own cascade identifier, and answers which rows held a blob reference — a
   * revision in any status but `DISCARDED`, whose discard already gave its reference back.
   */
  cascadeDelete(documentId: string, cascadeId: string): Promise<readonly CascadedRevision[]>;
  /** Restores exactly the revisions one cascade removed, answering the same shape. */
  restoreCascade(documentId: string, cascadeId: string): Promise<readonly CascadedRevision[]>;
}

export interface CascadedRevision {
  readonly revisionId: string;
  readonly fileObjectId: string;
  /** True when the row held a reference — every status but DISCARDED. */
  readonly referenced: boolean;
}

export interface RevisionFacts {
  readonly id: RevisionId;
  readonly documentId: DocumentId;
  readonly ordinal: number;
  readonly label: string;
  readonly status: RevisionStatusKey;
  readonly fileObjectId: string;
  readonly filename: string;
  readonly changeNote: string | null;
  readonly publishedAt: Date | null;
  readonly restoredFromRevisionId: string | null;
}

/**
 * The check-out lock. Declared in Phase 0.5, bound in Phase 6.
 *
 * `acquire` is an insert against `uq_document_lock_live` and nothing else — never a read
 * followed by a check, because the check that ran a moment earlier is a moment old. Two
 * check-outs racing therefore produce one lock and one `DocumentLockedError`, decided by the
 * index, whatever both believed they had read.
 */
export interface DocumentLockRepository {
  /** Inserts the live lock. Throws `DocumentLockedError` when one already stands. */
  acquire(input: {
    id: string;
    documentId: string;
    lockedBy: string;
    checkedOutRevisionId: string | null;
    acquiredAt: Date;
    expiresAt: Date;
  }): Promise<LockRecord>;

  /** The live lock on a document, expired or not. Null when nobody holds one. */
  liveFor(documentId: DocumentId): Promise<LockRecord | null>;

  /**
   * Releases an expired live lock, if that is what stands, and says whose it was. Called at
   * the head of any operation that may sweep a lapsed claim aside; a live, unexpired lock is
   * left exactly as it is.
   */
  releaseExpired(documentId: DocumentId, now: Date): Promise<LockRecord | null>;

  /** Ends the lock with its reason. The row stays: lock history is the point of having rows. */
  release(input: {
    lockId: string;
    reason: DocumentLockReleaseReasonKey;
    releasedBy: string | null;
    releaseNote: string | null;
    at: Date;
  }): Promise<void>;

  /** Records the working draft a check-in created while keeping the lock. */
  attachDraft(lockId: string, revisionId: string | null): Promise<void>;
}

export interface LockRecord {
  readonly id: string;
  readonly documentId: DocumentId;
  readonly lockedBy: UserId;
  readonly checkedOutRevisionId: string | null;
  readonly draftRevisionId: string | null;
  readonly acquiredAt: Date;
  readonly expiresAt: Date;
  readonly releasedAt: Date | null;
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
  /**
   * Stores a manifest Document produced *about* documents — Phase 16's bulk export, and the one
   * addition to a four-method port that had been stable since Phase 3.
   *
   * The narrowing above still holds, and this does not widen it: Document still may not create an
   * upload, complete one, or delete a blob. What it may now do is write one derived artefact whose
   * content it composed itself, which is the same permission the preview pipeline has for a
   * thumbnail. The alternative was for the bulk export to reach `STORAGE_SERVICE` directly, which
   * would hand Document the whole surface — including `abandonUploadSession` — to obtain one call.
   */
  storeManifest(input: { readonly content: Buffer; readonly mimeType: string }): Promise<{
    readonly fileObjectId: string;
    readonly sizeBytes: number;
    readonly checksumSha256: string;
  }>;
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
  /**
   * Puts a deleted document back, with every rule Document owns: the folder must be live, the
   * revisions its delete took come back with it, and the audit event is this module's own. Added
   * for the recycle bin, which is a surface over this rather than a second implementation.
   */
  restore(id: string, expectedVersion: number | undefined): Promise<void>;
}

export const DOCUMENT_NUMBER_SERVICE = Symbol('DocumentNumberService');

/**
 * The one path onto `document.document_number` (`09-numbering-architecture.md`, ADR-0004).
 *
 * Declared here because the number is the document's: this module resolves the document's real
 * organisational codes — its library's scope chain, its department's branch — and hands them to
 * Administration's issuance service, which owns the rules, the counters and the reservations.
 * The engine reaches the first three methods through Workflow's `DOCUMENT_NUMBER_ALLOCATOR`
 * seam; the manual path is a controller behind `numbering:manage`.
 *
 * Everything joins the caller's transaction. The codes are always resolved server-side from the
 * document's own placement — never accepted from a client — which is what makes the schema's
 * promise that "the application builds the scope key" true.
 */
export interface DocumentNumberService {
  /**
   * Draws the pending number a submission shows reviewers, when the type's rule reserves at
   * submission. Null when the rule draws at approval instead — including gapless mode, which
   * collapses to the same path (§2).
   */
  reserveForSubmission(
    documentId: DocumentId,
    workflowInstanceId: string,
  ): Promise<{ readonly pendingNumber: string | null }>;
  /** Assigns the number — the reservation if one is live, a fresh draw if not. */
  assignAtApproval(
    documentId: DocumentId,
    workflowInstanceId: string,
  ): Promise<{ readonly documentNumber: string }>;
  /** Voids the approval's reservation, if it holds one. The value never returns to the pool. */
  voidReservation(
    documentId: DocumentId,
    workflowInstanceId: string,
    reason: string,
  ): Promise<void>;
  /** The pending number shown on a document under review, or null. */
  pendingNumberFor(documentId: DocumentId): Promise<string | null>;
  /** Manual assignment and legacy import (§3), behind `numbering:manage`. */
  assignManually(documentId: DocumentId, requested: string): Promise<string>;
}
