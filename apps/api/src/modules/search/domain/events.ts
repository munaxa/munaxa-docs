import { type DomainEventDraft, defineEvent } from '@edms/domain';

/**
 * Search's domain events.
 *
 * An event is a fact in the past tense, its payload shape never changes once shipped, and
 * delivery is at least once — so every handler is idempotent on `eventId`
 * (`docs/architecture/02-backend-architecture.md` §6).
 *
 * The payloads are deliberately thin: an event carries identifiers and the facts a consumer
 * cannot derive, never a copy of the aggregate. A fat event becomes a second schema that
 * nobody migrates.
 */
export const SEARCH_AGGREGATE = 'search';

/** The read model reflects the document as of a point in time. */
export const DOCUMENT_INDEXED = 'search.document-indexed' as const;

export interface DocumentIndexedPayload {
  readonly documentId: string;
  readonly aclHash: string;
  readonly indexedAt: string;
}

export const documentIndexedEvent = defineEvent<typeof DOCUMENT_INDEXED, DocumentIndexedPayload>(
  DOCUMENT_INDEXED,
  1,
  SEARCH_AGGREGATE,
);

/** A full projection pass finished; carries the count. */
export const INDEX_REBUILD_COMPLETED = 'search.rebuild-completed' as const;

export interface IndexRebuildCompletedPayload {
  readonly documentsIndexed: number;
  readonly durationMs: number;
}

export const indexRebuildCompletedEvent = defineEvent<
  typeof INDEX_REBUILD_COMPLETED,
  IndexRebuildCompletedPayload
>(INDEX_REBUILD_COMPLETED, 1, SEARCH_AGGREGATE);

/** Every event type this module publishes, for the outbox's routing table. */
export const SEARCH_EVENT_TYPES: readonly string[] = Object.freeze([
  DOCUMENT_INDEXED,
  INDEX_REBUILD_COMPLETED,
]);

export type SearchEvent = DomainEventDraft;
