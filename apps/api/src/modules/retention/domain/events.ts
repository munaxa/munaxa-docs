import { type DomainEventDraft, defineEvent } from '@edms/domain';

/**
 * Retention's domain events.
 *
 * An event is a fact in the past tense, its payload shape never changes once shipped, and
 * delivery is at least once — so every handler is idempotent on `eventId`
 * (`docs/architecture/02-backend-architecture.md` §6).
 *
 * The payloads are deliberately thin: an event carries identifiers and the facts a consumer
 * cannot derive, never a copy of the aggregate. A fat event becomes a second schema that
 * nobody migrates.
 */
export const RETENTION_AGGREGATE = 'retention';

/** A disposition date is set for a document. */
export const RETENTION_SCHEDULED = 'retention.scheduled' as const;

export interface RetentionScheduledPayload {
  readonly documentId: string;
  readonly dueAt: string;
  readonly disposition: string;
  readonly policyId: string;
}

export const retentionScheduledEvent = defineEvent<
  typeof RETENTION_SCHEDULED,
  RetentionScheduledPayload
>(RETENTION_SCHEDULED, 1, RETENTION_AGGREGATE);

/** A schedule reached its date and needs review or execution. */
export const RETENTION_DUE = 'retention.due' as const;

export interface RetentionDuePayload {
  readonly documentId: string;
  readonly dueAt: string;
  readonly reviewRequired: boolean;
}

export const retentionDueEvent = defineEvent<typeof RETENTION_DUE, RetentionDuePayload>(
  RETENTION_DUE,
  1,
  RETENTION_AGGREGATE,
);

/** Disposition is suspended regardless of policy. */
export const LEGAL_HOLD_PLACED = 'retention.hold-placed' as const;

export interface LegalHoldPlacedPayload {
  readonly legalHoldId: string;
  readonly documentId: string;
  readonly placedBy: string;
  readonly reason: string;
}

export const legalHoldPlacedEvent = defineEvent<typeof LEGAL_HOLD_PLACED, LegalHoldPlacedPayload>(
  LEGAL_HOLD_PLACED,
  1,
  RETENTION_AGGREGATE,
);

/** The suspension ended; the schedule resumes. */
export const LEGAL_HOLD_RELEASED = 'retention.hold-released' as const;

export interface LegalHoldReleasedPayload {
  readonly legalHoldId: string;
  readonly documentId: string;
  readonly releasedBy: string;
}

export const legalHoldReleasedEvent = defineEvent<
  typeof LEGAL_HOLD_RELEASED,
  LegalHoldReleasedPayload
>(LEGAL_HOLD_RELEASED, 1, RETENTION_AGGREGATE);

/** Content destroyed. The audit trail and the number remain. */
export const DOCUMENT_PURGED = 'retention.document-purged' as const;

export interface DocumentPurgedPayload {
  readonly documentId: string;
  readonly documentNumber: string | null;
  readonly blobsDeleted: number;
}

export const documentPurgedEvent = defineEvent<typeof DOCUMENT_PURGED, DocumentPurgedPayload>(
  DOCUMENT_PURGED,
  1,
  RETENTION_AGGREGATE,
);

/** Every event type this module publishes, for the outbox's routing table. */
export const RETENTION_EVENT_TYPES: readonly string[] = Object.freeze([
  RETENTION_SCHEDULED,
  RETENTION_DUE,
  LEGAL_HOLD_PLACED,
  LEGAL_HOLD_RELEASED,
  DOCUMENT_PURGED,
]);

export type RetentionEvent = DomainEventDraft;
