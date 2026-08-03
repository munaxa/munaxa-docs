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
}
