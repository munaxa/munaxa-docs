import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';

import { QueueName, type QueueNameKey } from '@edms/domain';

import { APP_CONFIG, type AppConfig } from '../config';
import { OUTBOX_DISPATCHER, type OutboxDispatcher } from '../outbox/outbox.port';
import { QUEUE_PORT, type QueuePort } from '../../ports/queue.port';
import { LOGGER, type Logger } from './logger';
import { METRICS, MetricName, type Metrics } from './metrics';

/**
 * The two gauges nothing else can produce — Phase 18.
 *
 * ## Why a sampler rather than a call site
 *
 * Eight of the ten names in `MetricName` are recorded where the thing happens: a request finishes,
 * a message is handled, a job fails, a refusal is written. Two cannot be, because they are
 * *levels* rather than events — how deep each lane is, and how far behind the outbox is — and
 * nothing in the product naturally passes a point where that number is known. A dispatcher pass
 * knows how many rows it claimed, which is not the same question: a stalled dispatcher claims
 * nothing at all, so a gauge derived from its passes reads zero exactly when the backlog is
 * unbounded.
 *
 * ## Why it costs nothing when metrics are off
 *
 * Reading eleven lanes' depths and counting each tenant's unprocessed rows is real work — a Redis
 * round trip per lane and a bounded query per tenant database. It is therefore **not started at
 * all** unless an exporter is configured, which is the property that lets the interval be short
 * enough to be useful without imposing it on a deployment that scrapes nothing. `NONE` costs one
 * `if` at boot.
 *
 * It also only runs where the consumers do. Every instance in a horizontally scaled deployment
 * would otherwise report the same lane depths, which is not wrong but is N times the queries for
 * one number — and `QUEUE_CONSUMERS_ENABLED` already names the instance that does the queue's
 * housekeeping.
 */
@Injectable()
export class MetricsSampler implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(METRICS) private readonly metrics: Metrics,
    @Inject(QUEUE_PORT) private readonly queue: QueuePort,
    @Inject(OUTBOX_DISPATCHER) private readonly outbox: OutboxDispatcher,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.observability.metricsDriver === 'NONE') {
      return;
    }
    if (!this.config.queue.consumersEnabled) {
      this.logger.info('Queue and outbox depth are not sampled by this process');
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

  /** One sample, exposed so a test can drive it without waiting for an interval. */
  async sample(): Promise<void> {
    for (const queue of Object.values(QueueName) as QueueNameKey[]) {
      const depth = await this.queue.depth(queue);
      this.metrics.gauge(MetricName.QUEUE_DEPTH, depth.waiting, { queue, state: 'waiting' });
      this.metrics.gauge(MetricName.QUEUE_DEPTH, depth.active, { queue, state: 'active' });
      this.metrics.gauge(MetricName.QUEUE_DEPTH, depth.delayed, { queue, state: 'delayed' });
      this.metrics.gauge(MetricName.QUEUE_DEPTH, depth.failed, { queue, state: 'failed' });
    }
    this.metrics.gauge(MetricName.OUTBOX_PENDING, await this.outbox.pending());
  }

  private schedule(delayMs: number): void {
    if (!this.running) {
      return;
    }
    this.timer = setTimeout(() => {
      void this.sample()
        .catch((error: unknown) => {
          // A sampler that stopped on the first error would take the deployment's monitoring with
          // it during exactly the incident it exists for, so the loop always continues.
          this.logger.warn('A metrics sample failed', {
            reason: error instanceof Error ? error.message : 'unknown',
          });
        })
        .finally(() => {
          // Measured from the *end* of a sample, so a slow one cannot overlap the next — the same
          // property the outbox scheduler holds, and for the same reason.
          this.schedule(this.config.observability.metricsSampleIntervalMs);
        });
    }, delayMs);
    // A monitoring timer must never be the reason a container refuses to exit.
    this.timer.unref();
  }
}
