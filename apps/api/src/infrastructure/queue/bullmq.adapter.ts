import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Queue, Worker, type JobsOptions } from 'bullmq';
import Redis from 'ioredis';

import { deadLetterQueueFor, queueDefinition, type QueueNameKey } from '@edms/domain';

import { APP_CONFIG, type AppConfig } from '../../core/config';
import { LOGGER, type Logger } from '../../core/observability/logger';
import type {
  EnqueuedJob,
  JobEnvelope,
  JobOptions,
  QueueConsumer,
  QueueDepth,
  QueuePort,
} from '../../ports/queue.port';

/**
 * BullMQ, over the Redis this deployment already runs.
 *
 * The first adapter in the product to actually run a background job. `QUEUE_PORT` was declared in
 * Phase 0.5, the lanes and their retry policies were written down beside it, and nothing had ever
 * been bound to it — so events accumulated in the outbox, the deadline half of the workflow
 * architecture did not exist, and `apps/worker` printed a line saying no consumers were registered.
 * Phase 4 is where the async half of the architecture starts existing, because a workflow without
 * timers is a workflow that never chases anybody.
 *
 * ### Two Redis connections, not one
 *
 * BullMQ requires `maxRetriesPerRequest: null` on the connection a *worker* blocks on, because a
 * blocking `BRPOPLPUSH` that gives up after three retries is a consumer that silently stops
 * consuming. The cache's connection has the opposite requirement — a cache read that hangs forever
 * is worse than one that fails — so this owns its own connections rather than sharing
 * `RedisCacheAdapter`'s.
 *
 * ### Everything about failure comes from the catalogue
 *
 * Attempts, backoff and concurrency are read from `queueDefinition` in `@edms/domain` rather than
 * passed in per job. A caller that could choose its own retry policy is a caller that can disagree
 * with the lane's — and the lane is where the reasoning lives about what the work costs. A job that
 * exhausts its attempts is copied to `<lane>.dead` with the reason, so a permanent failure is
 * visible rather than gone.
 *
 * ### A job identifier is a claim, not a name
 *
 * BullMQ de-duplicates on `jobId` while a job is waiting or delayed, which is what makes
 * at-least-once delivery harmless for the callers here: a workflow timer's identifier is derived
 * from its row, so re-enqueuing after a pause replaces rather than duplicates. Once a job has
 * completed the identifier is free again, which is why idempotency is *also* enforced in the
 * database by the handler — this is a convenience, not the guarantee.
 */
@Injectable()
export class BullMqQueueAdapter implements QueuePort, QueueConsumer, OnModuleDestroy {
  private readonly producers = new Map<string, Queue>();
  private readonly workers: Worker[] = [];
  private readonly connection: Redis;
  private readonly blocking: Redis;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {
    this.connection = new Redis(config.redis.url, { maxRetriesPerRequest: 3, lazyConnect: true });
    this.blocking = new Redis(config.redis.url, { maxRetriesPerRequest: null, lazyConnect: true });
  }

  async onModuleDestroy(): Promise<void> {
    // Workers first, so in-flight jobs are allowed to finish before the connections they need go
    // away. Killing a retention purge or an escalation halfway is how a queue system loses work it
    // has already reported as started.
    await Promise.all(this.workers.map((worker) => worker.close()));
    await Promise.all([...this.producers.values()].map((queue) => queue.close()));
    this.connection.disconnect();
    this.blocking.disconnect();
  }

  async enqueue<TPayload extends object>(
    queue: string,
    payload: TPayload,
    options: JobOptions,
  ): Promise<EnqueuedJob> {
    const lane = this.producer(queue);
    const definition = queueDefinition(queue as QueueNameKey);
    const jobOptions: JobsOptions = {
      jobId: options.jobId,
      delay: options.delayMs ?? 0,
      attempts: options.attempts ?? definition.retry.attempts,
      backoff: {
        type: options.backoff?.type ?? definition.retry.backoff,
        delay: options.backoff?.delayMs ?? definition.retry.backoffMs,
      },
      ...(options.priority !== undefined && { priority: options.priority }),
      // Completed jobs are kept briefly so a support question about "did that reminder fire" has an
      // answer, and failed ones longer because they are the ones somebody investigates. Neither is
      // the record — that is the outbox row and the timer row — so both are bounded.
      removeOnComplete: { age: 3_600, count: 1_000 },
      removeOnFail: { age: 86_400 },
    };
    await lane.add(queue, payload, jobOptions);
    return {
      queue,
      jobId: options.jobId,
      availableAt: new Date(Date.now() + (options.delayMs ?? 0)),
    };
  }

  /**
   * Removes a scheduled job.
   *
   * Returns false rather than throwing when the job is gone or already running: a cancelled
   * deadline whose job has just started is a race the caller cannot win, and the handler's own
   * idempotency check is what makes losing it harmless — it finds the timer row is no longer
   * `SCHEDULED` and does nothing.
   */
  async cancel(queue: string, jobId: string): Promise<boolean> {
    const job = await this.producer(queue).getJob(jobId);
    if (job === undefined) {
      return false;
    }
    try {
      await job.remove();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Declares recurring work, once for the whole deployment.
   *
   * A *scheduler* rather than a delayed job re-enqueuing itself: the schedule lives in Redis
   * under its name, so every instance that boots upserts the same declaration and there is one
   * firing rather than one per instance. That is the property `ScheduledJob.lockKey` describes,
   * obtained without a lock — there was only ever one pass to run.
   *
   * UTC, explicitly. A cron expression evaluated in the process's local zone fires at different
   * instants on differently configured hosts, and "the daily verification ran twice on the day
   * the clocks changed" is a defect nobody finds by reading code.
   */
  async schedule<TPayload extends object>(
    queue: string,
    name: string,
    cron: string,
    payload: TPayload,
  ): Promise<void> {
    const definition = queueDefinition(queue as QueueNameKey);
    await this.producer(queue).upsertJobScheduler(
      name,
      { pattern: cron, tz: 'UTC' },
      {
        name: queue,
        data: payload,
        opts: {
          attempts: definition.retry.attempts,
          backoff: { type: definition.retry.backoff, delay: definition.retry.backoffMs },
          removeOnComplete: { age: 604_800, count: 100 },
          removeOnFail: { age: 2_592_000 },
        },
      },
    );
  }

  async unschedule(queue: string, name: string): Promise<void> {
    await this.producer(queue).removeJobScheduler(name);
  }

  async depth(queue: string): Promise<QueueDepth> {
    const counts = await this.producer(queue).getJobCounts(
      'waiting',
      'active',
      'delayed',
      'failed',
    );
    return {
      queue,
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      delayed: counts.delayed ?? 0,
      failed: counts.failed ?? 0,
    };
  }

  subscribe<TPayload extends object>(
    queue: string,
    handle: (job: JobEnvelope<TPayload>) => Promise<void>,
  ): Promise<void> {
    const definition = queueDefinition(queue as QueueNameKey);
    const worker = new Worker(
      queue,
      async (job) => {
        await handle({
          jobId: job.id ?? '',
          attempt: job.attemptsMade + 1,
          payload: job.data as TPayload,
        });
      },
      {
        connection: this.blocking,
        concurrency: definition.concurrency,
        // The lane's wall-clock budget, so a handler that hangs releases its slot rather than
        // holding it forever. Enforced by stalling detection rather than by killing the promise,
        // which is the best a single-process runtime can do.
        stalledInterval: definition.timeoutMs,
        maxStalledCount: 1,
      },
    );

    worker.on('failed', (job, error) => {
      const exhausted = job !== undefined && job.attemptsMade >= (job.opts.attempts ?? 1);
      this.logger.error('A background job failed', {
        queue,
        jobId: job?.id ?? 'unknown',
        attempt: job?.attemptsMade ?? 0,
        exhausted,
        reason: error.message,
      });
      if (exhausted && job !== undefined) {
        // Copied to the dead letter lane rather than merely logged, so the work is recoverable: an
        // operator can inspect it, fix the cause and re-enqueue. A job that only produced a log
        // line is a job nobody can replay.
        void this.producer(deadLetterQueueFor(queue as QueueNameKey))
          .add(queue, {
            payload: job.data as unknown,
            reason: error.message,
            failedJobId: job.id,
          })
          .catch((deadLetterError: unknown) => {
            this.logger.error('A failed job could not be dead-lettered', {
              queue,
              reason: deadLetterError instanceof Error ? deadLetterError.message : 'unknown',
            });
          });
      }
    });

    this.workers.push(worker);
    this.logger.info('Queue consumer registered', {
      queue,
      concurrency: definition.concurrency,
    });
    // Registration is synchronous — BullMQ's `Worker` starts consuming from its constructor — and
    // the port returns a promise because a different queue implementation might not. Nothing is
    // awaited here, and pretending otherwise would be an `await` on a resolved value.
    return Promise.resolve();
  }

  private producer(queue: string): Queue {
    const existing = this.producers.get(queue);
    if (existing !== undefined) {
      return existing;
    }
    const created = new Queue(queue, { connection: this.connection });
    this.producers.set(queue, created);
    return created;
  }
}
