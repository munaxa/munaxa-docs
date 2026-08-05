/**
 * Background work dispatch.
 *
 * The API never enqueues inside a transaction: it writes an outbox row, and the dispatcher
 * enqueues after commit (`docs/architecture/02-backend-architecture.md` §6). This port is
 * what the dispatcher and the schedulers speak to.
 */
export const QUEUE_PORT = Symbol('QueuePort');

export interface JobOptions {
  /** Deterministic per unit of work; makes at-least-once delivery harmless. */
  readonly jobId: string;
  readonly delayMs?: number;
  readonly attempts?: number;
  readonly backoff?: { readonly type: 'exponential' | 'fixed'; readonly delayMs: number };
  readonly priority?: number;
}

export interface EnqueuedJob {
  readonly queue: string;
  readonly jobId: string;
  readonly availableAt: Date;
}

export interface QueueDepth {
  readonly queue: string;
  readonly waiting: number;
  readonly active: number;
  readonly delayed: number;
  readonly failed: number;
}

export interface QueuePort {
  enqueue<TPayload extends object>(
    queue: string,
    payload: TPayload,
    options: JobOptions,
  ): Promise<EnqueuedJob>;
  /** Cancels a scheduled job — a deadline that moved, a document that was withdrawn. */
  cancel(queue: string, jobId: string): Promise<boolean>;
  depth(queue: string): Promise<QueueDepth>;
  /**
   * Declares recurring work: this payload, on this lane, on this cron expression, forever.
   *
   * Named rather than identified by payload, and upserted rather than added, because every
   * instance that boots declares the same schedule and there must be one firing rather than
   * one per instance. That is what `ScheduledJob.lockKey` in `@edms/domain` describes, and
   * expressing it as a *named* schedule in the broker is stronger than a lock around a timer:
   * a lock keeps two processes from running the same pass at the same moment, while a named
   * schedule means there was only ever one pass to run (`02-backend-architecture.md` §8).
   *
   * The cron expression is the catalogue's, in the catalogue's five-field form, evaluated in
   * UTC — the same instant everywhere, which is the only reading that survives a deployment
   * spanning regions.
   */
  schedule<TPayload extends object>(
    queue: string,
    name: string,
    cron: string,
    payload: TPayload,
  ): Promise<void>;
  /** Removes a schedule this process previously declared — for a lane that lost its handler. */
  unschedule(queue: string, name: string): Promise<void>;
}

/**
 * The other half of the port: receiving.
 *
 * Declared separately from `QueuePort` because the two have different holders. Every module that
 * schedules work injects the producer; exactly one class per lane consumes it, and giving the
 * consumer's interface to everything that enqueues would let a use case start pulling jobs off a
 * queue in the middle of a request.
 *
 * Phase 4 is what binds both — nothing had ever run a background job before it — and the shape is
 * deliberately minimal: a handler, registered at boot, that either returns or throws. Retries,
 * backoff and dead-lettering are the adapter's, from the lane's own definition in `@edms/domain`,
 * because a handler that had to know its own retry policy would be a handler that can disagree with
 * the catalogue.
 */
export const QUEUE_CONSUMER = Symbol('QueueConsumer');

export interface JobEnvelope<TPayload extends object = object> {
  readonly jobId: string;
  readonly attempt: number;
  readonly payload: TPayload;
}

export interface QueueConsumer {
  /**
   * Registers a handler for a lane.
   *
   * A throw is a failure and is retried per the lane's policy; a return is success. Nothing else
   * is signalled, because "succeeded but do not retry" and "failed but do not retry" are the same
   * outcome to a queue and distinguishing them in a return value invites a handler to swallow a
   * failure quietly.
   */
  subscribe<TPayload extends object>(
    queue: string,
    handle: (job: JobEnvelope<TPayload>) => Promise<void>,
  ): Promise<void>;
}
