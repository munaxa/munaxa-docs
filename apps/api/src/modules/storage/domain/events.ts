import { type DomainEventDraft, defineEvent } from '@edms/domain';

/**
 * Storage's domain events.
 *
 * An event is a fact in the past tense, its payload shape never changes once shipped, and
 * delivery is at least once — so every handler is idempotent on `eventId`
 * (`docs/architecture/02-backend-architecture.md` §6).
 *
 * The payloads are deliberately thin: an event carries identifiers and the facts a consumer
 * cannot derive, never a copy of the aggregate. A fat event becomes a second schema that
 * nobody migrates.
 */
export const STORAGE_AGGREGATE = 'storage';

/** Bytes are stored and checksummed; scanning may still be pending. */
export const FILE_OBJECT_CREATED = 'storage.file-created' as const;

export interface FileObjectCreatedPayload {
  readonly fileObjectId: string;
  readonly checksumSha256: string;
  readonly sizeBytes: number;
  readonly mimeType: string;
  readonly deduplicated: boolean;
}

export const fileObjectCreatedEvent = defineEvent<
  typeof FILE_OBJECT_CREATED,
  FileObjectCreatedPayload
>(FILE_OBJECT_CREATED, 1, STORAGE_AGGREGATE);

/** Carries the verdict; only CLEAN makes content reachable. */
export const FILE_SCAN_COMPLETED = 'storage.scan-completed' as const;

export interface FileScanCompletedPayload {
  readonly fileObjectId: string;
  readonly status: string;
  readonly scanner: string;
}

export const fileScanCompletedEvent = defineEvent<
  typeof FILE_SCAN_COMPLETED,
  FileScanCompletedPayload
>(FILE_SCAN_COMPLETED, 1, STORAGE_AGGREGATE);

/** Infected content was isolated and an incident raised. */
export const FILE_QUARANTINED = 'storage.file-quarantined' as const;

export interface FileQuarantinedPayload {
  readonly fileObjectId: string;
  readonly threat: string;
  readonly uploadedBy: string;
}

export const fileQuarantinedEvent = defineEvent<typeof FILE_QUARANTINED, FileQuarantinedPayload>(
  FILE_QUARANTINED,
  1,
  STORAGE_AGGREGATE,
);

/** Stored bytes no longer match their recorded digest — highest severity. */
export const FILE_CHECKSUM_MISMATCH = 'storage.checksum-mismatch' as const;

export interface FileChecksumMismatchPayload {
  readonly fileObjectId: string;
  readonly expectedChecksum: string;
  readonly actualChecksum: string;
}

export const fileChecksumMismatchEvent = defineEvent<
  typeof FILE_CHECKSUM_MISMATCH,
  FileChecksumMismatchPayload
>(FILE_CHECKSUM_MISMATCH, 1, STORAGE_AGGREGATE);

/** Every event type this module publishes, for the outbox's routing table. */
export const STORAGE_EVENT_TYPES: readonly string[] = Object.freeze([
  FILE_OBJECT_CREATED,
  FILE_SCAN_COMPLETED,
  FILE_QUARANTINED,
  FILE_CHECKSUM_MISMATCH,
]);

export type StorageEvent = DomainEventDraft;

/**
 * The rolling verifier found a blob's bytes no longer hash to what was recorded — Phase 18.
 *
 * An event as well as an audit row, because the two have different readers. The audit row is the
 * evidence, immutable and hash-chained; the event is what reaches an operator — a webhook, a SIEM
 * sink, and 17 §9's "checksum mismatch: immediate" alert. Publishing one without the other would
 * mean either an incident nobody is told about or a notification with nothing behind it.
 *
 * The payload carries both digests, because "what should it have been and what is it now" is the
 * first question an investigation asks and neither is recoverable afterwards from the row alone.
 */
export const FILE_INTEGRITY_MISMATCH = 'storage.integrity-mismatch' as const;

export interface FileIntegrityMismatchPayload {
  readonly fileObjectId: string;
  readonly expectedSha256: string;
  /** Null when the object could not be read at all, which is the other half of the finding. */
  readonly actualSha256: string | null;
  readonly storageKey: string;
  readonly storageDriver: string;
}

export const fileIntegrityMismatchEvent = defineEvent<
  typeof FILE_INTEGRITY_MISMATCH,
  FileIntegrityMismatchPayload
>(FILE_INTEGRITY_MISMATCH, 1, STORAGE_AGGREGATE);
