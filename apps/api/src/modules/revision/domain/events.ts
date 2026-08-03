import { type DomainEventDraft, defineEvent } from '@edms/domain';

/**
 * Revision's domain events.
 *
 * An event is a fact in the past tense, its payload shape never changes once shipped, and
 * delivery is at least once — so every handler is idempotent on `eventId`
 * (`docs/architecture/02-backend-architecture.md` §6).
 *
 * The payloads are deliberately thin: an event carries identifiers and the facts a consumer
 * cannot derive, never a copy of the aggregate. A fat event becomes a second schema that
 * nobody migrates.
 */
export const REVISION_AGGREGATE = 'revision';

/** A new draft revision exists beneath its document. */
export const REVISION_CREATED = 'revision.created' as const;

export interface RevisionCreatedPayload {
  readonly revisionId: string;
  readonly documentId: string;
  readonly ordinal: number;
  readonly authorId: string;
}

export const revisionCreatedEvent = defineEvent<typeof REVISION_CREATED, RevisionCreatedPayload>(
  REVISION_CREATED,
  1,
  REVISION_AGGREGATE,
);

/** This revision is effective; the previous one is superseded. */
export const REVISION_PUBLISHED = 'revision.published' as const;

export interface RevisionPublishedPayload {
  readonly revisionId: string;
  readonly documentId: string;
  readonly fileObjectId: string;
}

export const revisionPublishedEvent = defineEvent<
  typeof REVISION_PUBLISHED,
  RevisionPublishedPayload
>(REVISION_PUBLISHED, 1, REVISION_AGGREGATE);

/** No longer effective, still readable with history permission. */
export const REVISION_SUPERSEDED = 'revision.superseded' as const;

export interface RevisionSupersededPayload {
  readonly revisionId: string;
  readonly documentId: string;
  readonly supersededByRevisionId: string;
}

export const revisionSupersededEvent = defineEvent<
  typeof REVISION_SUPERSEDED,
  RevisionSupersededPayload
>(REVISION_SUPERSEDED, 1, REVISION_AGGREGATE);

/** A new revision was created carrying an older revision\u2019s content. */
export const REVISION_RESTORED = 'revision.restored' as const;

export interface RevisionRestoredPayload {
  readonly revisionId: string;
  readonly documentId: string;
  readonly restoredFromRevisionId: string;
}

export const revisionRestoredEvent = defineEvent<typeof REVISION_RESTORED, RevisionRestoredPayload>(
  REVISION_RESTORED,
  1,
  REVISION_AGGREGATE,
);

/** Every event type this module publishes, for the outbox's routing table. */
export const REVISION_EVENT_TYPES: readonly string[] = Object.freeze([
  REVISION_CREATED,
  REVISION_PUBLISHED,
  REVISION_SUPERSEDED,
  REVISION_RESTORED,
]);

export type RevisionEvent = DomainEventDraft;
