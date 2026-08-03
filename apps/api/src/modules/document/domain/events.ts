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

/** Retired from active use, still readable. */
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
  DOCUMENT_DELETED,
  DOCUMENT_RESTORED,
  NUMBER_ASSIGNED,
]);

export type DocumentEvent = DomainEventDraft;
