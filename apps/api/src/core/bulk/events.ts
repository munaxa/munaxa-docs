import { type DomainEventDraft, defineEvent } from '@edms/domain';

/**
 * The one event a bulk operation publishes — Phase 16.
 *
 * Its aggregate is `bulk`, which is what makes the outbox's prefix table route it: Phase 11 and
 * Phase 14 each shipped an event family whose prefix no branch matched and which accumulated
 * unrouted for a phase, so the `bulk.` line goes into `routesFor` in the same commit as this file
 * and the integration suite asserts the routing rather than the comment.
 *
 * **The operation publishes exactly one event; its objects publish their own.** A bulk restore over
 * four hundred documents produces four hundred `document.restored` events, from inside each
 * document's own transaction, exactly as four hundred single restores would — so the search index
 * re-projects each one and every existing consumer behaves identically. This event is *about the
 * act*, and its only consumer is the notification lane, where it becomes the one summary 18 §7 has
 * required since Phase 0 and nothing had ever produced.
 *
 * The payload carries counts and no identifier list. 13 §3 requires a minimised payload, and five
 * thousand UUIDs in one `jsonb` would be a second copy of the operation with no retention policy —
 * which objects were touched is `bulk_operation_item`, a table, indexed and pageable.
 */
export const BULK_AGGREGATE = 'bulk';

export const BULK_OPERATION_COMPLETED = 'bulk.operation-completed' as const;

export interface BulkOperationCompletedPayload {
  readonly operationId: string;
  readonly kind: string;
  /** Who asked for it. The only recipient — see the notification type's own reasoning. */
  readonly requestedById: string;
  readonly requested: number;
  readonly applied: number;
  readonly refused: number;
  readonly blocked: number;
  readonly failed: number;
}

export const bulkOperationCompletedEvent = defineEvent<
  typeof BULK_OPERATION_COMPLETED,
  BulkOperationCompletedPayload
>(BULK_OPERATION_COMPLETED, 1, BULK_AGGREGATE);

export type BulkOperationCompletedDraft = DomainEventDraft<
  typeof BULK_OPERATION_COMPLETED,
  BulkOperationCompletedPayload
>;
