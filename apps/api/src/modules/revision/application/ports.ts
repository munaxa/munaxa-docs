import type { DocumentId, RevisionId, RevisionStatusKey, ScanStatusKey } from '@edms/domain';

/**
 * Revision's read side: the history and the comparison.
 *
 * Reads only. Every write onto `document_revision` goes through `RevisionWriter` — the port
 * Document declares and this module implements — because a revision is never a fact on its
 * own: it exists with the lock release, the status move and the audit event of the operation
 * that made it, all in one transaction that Document owns. Restoring is a write, so restore
 * lives there too; what this side owns is answering "what did it look like, when, and how do
 * these two differ".
 */
export const REVISION_QUERY = Symbol('RevisionQuery');

export interface RevisionHistoryRow {
  readonly id: RevisionId;
  readonly ordinal: number;
  readonly label: string;
  readonly status: RevisionStatusKey;
  readonly changeNote: string | null;
  readonly createdAt: Date;
  readonly createdBy: string | null;
  readonly createdByName: string | null;
  readonly publishedAt: Date | null;
  /** Calendar days, as stored: `YYYY-MM-DD`. */
  readonly effectiveFrom: string | null;
  readonly effectiveTo: string | null;
  readonly restoredFromRevisionId: string | null;
  readonly restoredFromLabel: string | null;
  readonly metadataSnapshot: Readonly<Record<string, SnapshotEntry>> | null;
  readonly file: RevisionFileRow;
}

export interface RevisionFileRow {
  readonly fileObjectId: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly checksumSha256: string;
  readonly scanStatus: ScanStatusKey;
}

/** One field in a published revision's metadata snapshot, as publication wrote it. */
export interface SnapshotEntry {
  readonly name: string;
  readonly dataType: string;
  readonly value: unknown;
}

export interface RevisionQuery {
  /** Every revision of a document, oldest first — the timeline reads downward. */
  historyFor(documentId: DocumentId): Promise<readonly RevisionHistoryRow[]>;
  /** One revision by its ordinal. Null when the ordinal was never issued. */
  byOrdinal(documentId: DocumentId, ordinal: number): Promise<RevisionHistoryRow | null>;
}
