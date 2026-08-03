import type { DocumentId, FileObjectId, RevisionId, RevisionStatusKey, UserId } from '@edms/domain';

/**
 * Revisions are inserted, never updated once published.
 *
 * Restoring an old revision creates a **new** revision carrying the old content, with
 * `restoredFromRevisionId` recorded. History is never rewritten
 * (`docs/architecture/10-revision-architecture.md`).
 */
export const REVISION_REPOSITORY = Symbol('RevisionRepository');

export interface RevisionRecord {
  readonly id: RevisionId;
  readonly documentId: DocumentId;
  /** Strictly increasing per document. The label is presentation; the ordinal is truth. */
  readonly ordinal: number;
  readonly label: string;
  readonly status: RevisionStatusKey;
  readonly fileObjectId: FileObjectId | null;
  readonly authorId: UserId;
  readonly publishedAt: Date | null;
  readonly restoredFromRevisionId: RevisionId | null;
  readonly changeSummary: string | null;
}

export interface RevisionRepository {
  findById(id: RevisionId): Promise<RevisionRecord | null>;
  findByOrdinal(documentId: DocumentId, ordinal: number): Promise<RevisionRecord | null>;
  listForDocument(documentId: DocumentId): Promise<readonly RevisionRecord[]>;
  /** Exactly one revision may be PUBLISHED at a time; enforced in the same transaction. */
  findPublished(documentId: DocumentId): Promise<RevisionRecord | null>;
  append(revision: RevisionRecord): Promise<void>;
  updateStatus(id: RevisionId, status: RevisionStatusKey): Promise<void>;
}

export const REVISION_SERVICE = Symbol('RevisionService');

export interface RevisionDiff {
  readonly metadataChanges: readonly { field: string; from: string | null; to: string | null }[];
  readonly textChanged: boolean;
  readonly pageCountDelta: number;
}

export interface RevisionService {
  get(id: RevisionId): Promise<RevisionRecord | null>;
  history(documentId: DocumentId): Promise<readonly RevisionRecord[]>;
  compare(from: RevisionId, to: RevisionId): Promise<RevisionDiff>;
}
