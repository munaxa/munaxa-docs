import { type DomainEventDraft, defineEvent } from '@edms/domain';

/**
 * Document's domain events.
 *
 * An event is a fact in the past tense, its payload shape never changes once shipped, and
 * delivery is at least once — so every handler is idempotent on `eventId`
 * (`docs/architecture/02-backend-architecture.md` §6).
 *
 * The payloads are deliberately thin: an event carries identifiers and the facts a consumer
 * cannot derive, never a copy of the aggregate. A fat event becomes a second schema that
 * nobody migrates.
 */
export const DOCUMENT_AGGREGATE = 'document';

/** A controlled record exists in DRAFT; it has no number yet. */
export const DOCUMENT_CREATED = 'document.created' as const;

export interface DocumentCreatedPayload {
  readonly documentId: string;
  readonly folderId: string;
  readonly documentTypeId: string;
  readonly ownerUserId: string;
  /**
   * The initial revision and its blob. Added in Phase 7 — a compatible widening — because
   * ordinal zero publishes no `revision.created` (`createInitial` predates the revision
   * cycle), so this event is where the preview pipeline hears about a new document's content.
   */
  readonly revisionId: string;
  readonly fileObjectId: string;
}

export const documentCreatedEvent = defineEvent<typeof DOCUMENT_CREATED, DocumentCreatedPayload>(
  DOCUMENT_CREATED,
  1,
  DOCUMENT_AGGREGATE,
);

/** Handed to the workflow; content is frozen from here. */
export const DOCUMENT_SUBMITTED = 'document.submitted' as const;

export interface DocumentSubmittedPayload {
  readonly documentId: string;
  readonly revisionId: string;
  readonly workflowVersionId: string;
}

export const documentSubmittedEvent = defineEvent<
  typeof DOCUMENT_SUBMITTED,
  DocumentSubmittedPayload
>(DOCUMENT_SUBMITTED, 1, DOCUMENT_AGGREGATE);

/** All stages passed and the number was assigned in the same transaction. */
export const DOCUMENT_APPROVED = 'document.approved' as const;

export interface DocumentApprovedPayload {
  readonly documentId: string;
  readonly revisionId: string;
  readonly documentNumber: string;
  readonly workflowInstanceId: string;
}

export const documentApprovedEvent = defineEvent<typeof DOCUMENT_APPROVED, DocumentApprovedPayload>(
  DOCUMENT_APPROVED,
  1,
  DOCUMENT_AGGREGATE,
);

/** This revision is the effective one; the previous one is superseded. */
export const DOCUMENT_PUBLISHED = 'document.published' as const;

export interface DocumentPublishedPayload {
  readonly documentId: string;
  readonly revisionId: string;
  readonly supersededRevisionId: string | null;
  readonly effectiveFrom: string | null;
}

export const documentPublishedEvent = defineEvent<
  typeof DOCUMENT_PUBLISHED,
  DocumentPublishedPayload
>(DOCUMENT_PUBLISHED, 1, DOCUMENT_AGGREGATE);

/** Terminal for this attempt; no number was issued. */
export const DOCUMENT_REJECTED = 'document.rejected' as const;

export interface DocumentRejectedPayload {
  readonly documentId: string;
  readonly revisionId: string;
  readonly decidedBy: string;
  readonly comment: string;
}

export const documentRejectedEvent = defineEvent<typeof DOCUMENT_REJECTED, DocumentRejectedPayload>(
  DOCUMENT_REJECTED,
  1,
  DOCUMENT_AGGREGATE,
);

/** Exclusively locked for the next revision. */
export const DOCUMENT_CHECKED_OUT = 'document.checked-out' as const;

export interface DocumentCheckedOutPayload {
  readonly documentId: string;
  readonly lockedBy: string;
  readonly expiresAt: string;
}

export const documentCheckedOutEvent = defineEvent<
  typeof DOCUMENT_CHECKED_OUT,
  DocumentCheckedOutPayload
>(DOCUMENT_CHECKED_OUT, 1, DOCUMENT_AGGREGATE);

/** A new draft revision exists beneath the published one. */
export const DOCUMENT_CHECKED_IN = 'document.checked-in' as const;

export interface DocumentCheckedInPayload {
  readonly documentId: string;
  readonly newRevisionId: string;
  readonly ordinal: number;
}

export const documentCheckedInEvent = defineEvent<
  typeof DOCUMENT_CHECKED_IN,
  DocumentCheckedInPayload
>(DOCUMENT_CHECKED_IN, 1, DOCUMENT_AGGREGATE);

/** Folder changed, so inherited permissions changed. */
export const DOCUMENT_MOVED = 'document.moved' as const;

export interface DocumentMovedPayload {
  readonly documentId: string;
  readonly fromFolderId: string;
  readonly toFolderId: string;
}

export const documentMovedEvent = defineEvent<typeof DOCUMENT_MOVED, DocumentMovedPayload>(
  DOCUMENT_MOVED,
  1,
  DOCUMENT_AGGREGATE,
);

/**
 * Retired from active use, still readable.
 *
 * Declared in Phase 3 and published for the first time in Phase 6.1 — the payload shape is
 * unchanged, because "its payload shape never changes once shipped" applies to a declared event
 * whether or not anything had emitted it yet, and widening it would have been the easier and
 * wronger move.
 */
export const DOCUMENT_ARCHIVED = 'document.archived' as const;

export interface DocumentArchivedPayload {
  readonly documentId: string;
  readonly reason: string | null;
}

export const documentArchivedEvent = defineEvent<typeof DOCUMENT_ARCHIVED, DocumentArchivedPayload>(
  DOCUMENT_ARCHIVED,
  1,
  DOCUMENT_AGGREGATE,
);

/**
 * Returned to the shelf from the archive — Phase 6.1.
 *
 * Distinct from `document.restored`, which reverses a *delete*. The search index has to re-project
 * on both and the two mean different things to a reader, so they are two events rather than one
 * with a discriminator.
 */
export const DOCUMENT_REINSTATED = 'document.reinstated' as const;

export interface DocumentReinstatedPayload {
  readonly documentId: string;
  readonly reason: string | null;
}

export const documentReinstatedEvent = defineEvent<
  typeof DOCUMENT_REINSTATED,
  DocumentReinstatedPayload
>(DOCUMENT_REINSTATED, 1, DOCUMENT_AGGREGATE);

/**
 * The effective window closed and the sweep noticed — Phase 6.1.
 *
 * Carries the revision whose window closed and the date it closed on, because the document's own
 * effectiveness is its current revision's (`10-revision-architecture.md` §6) and a consumer asking
 * "which revision expired" cannot derive it later: the next publication moves
 * `current_revision_id` on.
 */
export const DOCUMENT_EXPIRED = 'document.expired' as const;

export interface DocumentExpiredPayload {
  readonly documentId: string;
  readonly revisionId: string;
  /** The last day the revision was effective, as the calendar day it was stored as. */
  readonly effectiveTo: string;
}

export const documentExpiredEvent = defineEvent<typeof DOCUMENT_EXPIRED, DocumentExpiredPayload>(
  DOCUMENT_EXPIRED,
  1,
  DOCUMENT_AGGREGATE,
);

/** Soft-deleted and recoverable; the number stays reserved forever. */
export const DOCUMENT_DELETED = 'document.deleted' as const;

export interface DocumentDeletedPayload {
  readonly documentId: string;
  readonly deletedBy: string;
  readonly cascadeId: string | null;
  readonly previousStatus: string;
}

export const documentDeletedEvent = defineEvent<typeof DOCUMENT_DELETED, DocumentDeletedPayload>(
  DOCUMENT_DELETED,
  1,
  DOCUMENT_AGGREGATE,
);

/** Returned to the state it was deleted from, never a higher one. */
export const DOCUMENT_RESTORED = 'document.restored' as const;

export interface DocumentRestoredPayload {
  readonly documentId: string;
  readonly restoredTo: string;
  readonly renamedTo: string | null;
}

export const documentRestoredEvent = defineEvent<typeof DOCUMENT_RESTORED, DocumentRestoredPayload>(
  DOCUMENT_RESTORED,
  1,
  DOCUMENT_AGGREGATE,
);

/** Issued once, at approval, and never reused. */
export const NUMBER_ASSIGNED = 'document.number-assigned' as const;

export interface NumberAssignedPayload {
  readonly documentId: string;
  readonly documentNumber: string;
  readonly numberingRuleId: string;
  readonly sequenceValue: string;
}

export const numberAssignedEvent = defineEvent<typeof NUMBER_ASSIGNED, NumberAssignedPayload>(
  NUMBER_ASSIGNED,
  1,
  DOCUMENT_AGGREGATE,
);

/** Every event type this module publishes, for the outbox's routing table. */
export const DOCUMENT_EVENT_TYPES: readonly string[] = Object.freeze([
  DOCUMENT_CREATED,
  DOCUMENT_SUBMITTED,
  DOCUMENT_APPROVED,
  DOCUMENT_PUBLISHED,
  DOCUMENT_REJECTED,
  DOCUMENT_CHECKED_OUT,
  DOCUMENT_CHECKED_IN,
  DOCUMENT_MOVED,
  DOCUMENT_ARCHIVED,
  DOCUMENT_REINSTATED,
  DOCUMENT_EXPIRED,
  DOCUMENT_DELETED,
  DOCUMENT_RESTORED,
  NUMBER_ASSIGNED,
]);

export type DocumentEvent = DomainEventDraft;
