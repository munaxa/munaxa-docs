import type { DomainEventDraft } from '@edms/domain';

/**
 * The transactional outbox.
 *
 * A use case never enqueues a job. It writes an outbox row inside its own transaction, and
 * the dispatcher enqueues after commit. That single indirection removes both failure modes
 * of the obvious approach: a job that runs against a transaction that then rolled back, and
 * a change that commits while its notification is lost to a Redis blip
 * (`docs/architecture/adr/0011-transactional-outbox-for-async-work.md`).
 */
export const OUTBOX_WRITER = Symbol('OutboxWriter');

export interface OutboxWriter {
  /** Joins the caller's unit of work: the row and the change that caused it commit together.
   *  There is no other legal way in. */
  publish(events: readonly DomainEventDraft[]): Promise<void>;
}

export const OUTBOX_DISPATCHER = Symbol('OutboxDispatcher');

export interface DispatchResult {
  readonly claimed: number;
  readonly enqueued: number;
  readonly failed: number;
}

/**
 * Claims unsent rows with `FOR UPDATE SKIP LOCKED` and enqueues them, so several API
 * instances can dispatch concurrently without one blocking the others or double-sending.
 */
export interface OutboxDispatcher {
  dispatchBatch(batchSize: number): Promise<DispatchResult>;
}

/** Which queue an event type is dispatched to. Owned by the module that publishes the event. */
export interface EventRoute {
  readonly eventType: string;
  readonly queue: string;
  /** Deterministic per event, so at-least-once delivery is harmless. */
  readonly jobIdFor: (eventId: string) => string;
}
