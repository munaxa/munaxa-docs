import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';

import { APP_CONFIG, type AppConfig } from '../config';
import { LOGGER, type Logger } from '../observability/logger';
import { OUTBOX_DISPATCHER, type OutboxDispatcher } from './outbox.port';

/**
 * What makes the dispatcher actually run.
 *
 * A timer rather than a queue, and that is not a contradiction of "timers are jobs, not polling":
 * the polling has to stop *somewhere*, and the outbox is where. A dispatcher triggered by a job
 * would need something to enqueue that job, which is the same problem one level up.
 *
 * Two properties keep it honest.
 *
 * **One pass at a time.** The interval is measured from the *end* of a pass rather than fired on a
 * fixed schedule, so a slow pass cannot overlap the next one and dispatch the same rows twice.
 * `SKIP LOCKED` would make that harmless, and not relying on it is cheaper than proving it.
 *
 * **It drains rather than sleeping on a full batch.** A pass that claimed a full batch goes again
 * immediately: a burst of a thousand events must not take a thousand divided by the batch size
 * intervals to clear, which at the default settings would be twenty seconds of latency on the last
 * notification of a bulk import.
 *
 * A failure never stops the loop. The rows are durable, the next pass finds them, and a dispatcher
 * that stopped on the first error would be a system that silently stopped delivering.
 */
@Injectable()
export class OutboxDispatchScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private running = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(OUTBOX_DISPATCHER) private readonly dispatcher: OutboxDispatcher,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.queue.consumersEnabled) {
      this.logger.info('The outbox is not dispatched by this process');
      return;
    }
    this.running = true;
    this.schedule(0);
  }

  onApplicationShutdown(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** One pass, exposed so a test can drive the dispatcher without waiting for an interval. */
  async pass(): Promise<void> {
    const result = await this.dispatcher.dispatchBatch(this.config.queue.outboxBatchSize);
    if (result.claimed > 0) {
      this.logger.debug('Outbox dispatched', {
        claimed: result.claimed,
        enqueued: result.enqueued,
        failed: result.failed,
      });
    }
    if (result.claimed >= this.config.queue.outboxBatchSize) {
      this.schedule(0);
      return;
    }
    this.schedule(this.config.queue.outboxPollIntervalMs);
  }

  private schedule(delayMs: number): void {
    if (!this.running) {
      return;
    }
    this.timer = setTimeout(() => {
      void this.pass().catch((error: unknown) => {
        this.logger.error('An outbox dispatch pass failed', {
          reason: error instanceof Error ? error.message : 'unknown',
        });
        this.schedule(this.config.queue.outboxPollIntervalMs);
      });
    }, delayMs);
    // A dispatcher that keeps a process alive is a process that will not shut down when its work is
    // done — which is exactly what a container orchestrator interprets as a hung pod.
    this.timer.unref();
  }
}
