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

/**
 * The operation was accepted and handed to the lane — Phase 6.2.
 *
 * **An outbox event rather than a direct `enqueue`, and that is not a style choice.**
 * `ports/queue.port.ts` opens with the rule: *"The API never enqueues inside a transaction: it
 * writes an outbox row, and the dispatcher enqueues after commit."* A job enqueued before commit
 * can be delivered against a transaction that then rolls back — here that would mean a worker
 * looking for an operation row that does not exist. Publishing from inside the transaction that
 * opened the operation makes the job's existence and the record's existence the same fact.
 *
 * The payload is the operation identifier and nothing else. The targets and the plan input live on
 * the row, which the consumer reads under the tenant's own context — so a queue payload cannot
 * carry another tenant's identifiers, and a five-thousand-object import is not five thousand UUIDs
 * in Redis.
 */
export const BULK_OPERATION_QUEUED = 'bulk.operation-queued' as const;

export interface BulkOperationQueuedPayload {
  readonly operationId: string;
  readonly kind: string;
  readonly requestedById: string;
  readonly requested: number;
}

export const bulkOperationQueuedEvent = defineEvent<
  typeof BULK_OPERATION_QUEUED,
  BulkOperationQueuedPayload
>(BULK_OPERATION_QUEUED, 1, BULK_AGGREGATE);
