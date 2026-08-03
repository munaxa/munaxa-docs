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
