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

/**
 * Rebuilding what the broker holds from what the database holds — RC validation, D-13.
 *
 * Redis is not a record (`docs/operations/backup-and-restore.md` §1), and that sentence is only
 * true if everything in it can be put back. Two things lived *only* there: the cron schedules each
 * lane declares at boot, and the delayed job behind every workflow timer. Lose Redis and the
 * schedules stayed gone until the next restart, and a timer's row sat `SCHEDULED` past its
 * `fire_at` with nothing left to fire it — an escalation that never happened, silently.
 *
 * This is the broker's half of putting them back. The durable half — which timers are still owed a
 * firing — belongs to the modules that own those rows, through `QueueRecoveryParticipant`.
 */
export const QUEUE_RECOVERY = Symbol('QueueRecovery');

export interface QueueRecovery {
  /**
   * Whether the broker still holds what this deployment put there. False after a flush, a failover
   * to an empty replica, or on a broker that has never been rebuilt — every case in which the
   * durable state has to be re-asserted.
   */
  brokerIntact(): Promise<boolean>;
  /** Records that the broker's state has been rebuilt, so the next check answers true. */
  markBrokerIntact(): Promise<void>;
  /**
   * Re-declares every schedule this process declared and has not withdrawn, where the broker no
   * longer holds it. Answers how many it put back. Upserted by name, so two processes doing it at
   * once still leave one schedule.
   */
  redeclareSchedules(): Promise<number>;
}

/** A module whose durable rows are owed queue entries — one participant per kind of row. */
export interface QueueRecoveryParticipant {
  readonly name: string;
  /**
   * Re-arms whatever the broker should hold for the rows this module owns, across every tenant.
   * Idempotent by construction: it must be safe to run twice, and from two processes at once.
   * Throws if anything could not be re-armed, so the broker is not marked intact over a gap.
   */
  recover(): Promise<number>;
}
