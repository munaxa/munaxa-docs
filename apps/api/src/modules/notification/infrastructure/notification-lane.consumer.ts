import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';

import {
  type DigestFrequencyKey,
  type TenantId,
  DigestFrequency,
  NotificationChannel,
  QueueName,
  SCHEDULE,
  asId,
} from '@edms/domain';

import { APP_CONFIG, type AppConfig } from '../../../core/config';
import { LOGGER, type Logger } from '../../../core/observability/logger';
import { TENANT_REGISTRY, type TenantRegistry } from '../../../core/tenancy/tenant-registry.port';
import { type RequestContext, runWithContext } from '../../../core/tenancy/tenant-context';
import {
  QUEUE_CONSUMER,
  QUEUE_PORT,
  type JobEnvelope,
  type QueueConsumer,
  type QueuePort,
} from '../../../ports/queue.port';
import { DeliveryService } from '../application/delivery.service';
import { DigestService } from '../application/digest.service';
import { NotificationEventService } from '../application/notification-event.service';

/** The five schedule entries this consumer answers for. */
const DELIVER_SCHEDULE = 'notifications.deliver';
const DIGEST_HOURLY_SCHEDULE = 'notifications.digest-hourly';
const DIGEST_DAILY_SCHEDULE = 'notifications.digest-daily';
const DIGEST_WEEKLY_SCHEDULE = 'notifications.digest-weekly';
const RELEASE_SCHEDULE = 'notifications.release-batches';

const SCHEDULES: readonly string[] = Object.freeze([
  DELIVER_SCHEDULE,
  DIGEST_HOURLY_SCHEDULE,
  DIGEST_DAILY_SCHEDULE,
  DIGEST_WEEKLY_SCHEDULE,
  RELEASE_SCHEDULE,
]);

/** How many closed coalescing windows one release pass settles. */
const RELEASE_BATCH = 200;

/**
 * The `notifications.deliver` lane's first consumer — **the last declared lane in the product to
 * gain one**.
 *
 * Everything structural was argued by Phase 9, repeated by Phase 10 and repeated again by Phase
 * 11, so it is stated rather than re-argued: it runs in the **API process** behind
 * `queue.consumersEnabled` (every consumer since Phase 4 lives there; `apps/worker` composes none
 * of the domain modules); the schedules are **declared, named and upserted** in the broker rather
 * than timed, so ten instances booting produce one firing; and each scheduled firing is
 * tenant-less and fans out one job per tenant from `TENANT_REGISTRY.all()`, because under
 * ADR-0015 there is no "all tenants" pass this product's data model can make.
 *
 * The constraint Phase 11 recorded holds here too and is the reason five schedules share one
 * lane: `BullMqAdapter.subscribe` constructs one `Worker` per call, so two subscribers on one
 * lane race each other for its jobs. **One consumer per lane**, and a consumer that answers for
 * everything on it.
 *
 * ## Two kinds of job, on one lane
 *
 * **Outbox events** arrive because the dispatcher routed them here — every `workflow.*`,
 * `document.*`, `delegation.*`, `retention.*`, `audit.*` and `storage.*` — and are handed
 * straight to `NotificationEventService`, which decides who hears about each and whether it is
 * one of the bulk families that must be coalesced.
 *
 * **Scheduled jobs** drain what those produced: the delivery pass, the three digest collections
 * and the coalescing-window release.
 *
 * They are not separated into two lanes, which is the shape Phase 7 chose for preview and OCR.
 * The argument there was *cost* — a slow job starving a fast one — and it does not apply: an
 * outbox translation and a delivery pass are both a handful of queries, and the lane's
 * concurrency of 8 means neither waits behind the other in the first place.
 *
 * ## Why delivery is a schedule and not a job per message
 *
 * Because a provider is either reachable or it is not. Fifty delayed jobs discovering an outage
 * separately produce fifty backoff curves where one belongs, and the retry policy this lane
 * already declares would apply to each of them independently. A minute of added latency is the
 * cost, and it is paid only by email: in-app is delivered by being written and never reaches
 * this lane at all.
 */
@Injectable()
export class NotificationLaneConsumer implements OnApplicationBootstrap {
  constructor(
    @Inject(QUEUE_CONSUMER) private readonly consumer: QueueConsumer,
    @Inject(QUEUE_PORT) private readonly queue: QueuePort,
    @Inject(TENANT_REGISTRY) private readonly tenants: TenantRegistry,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly events: NotificationEventService,
    private readonly delivery: DeliveryService,
    private readonly digests: DigestService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.queue.consumersEnabled) {
      this.logger.info('The notification lane is not consumed by this process', {
        queues: [QueueName.NOTIFICATIONS_DELIVER],
      });
      return;
    }
    await this.consumer.subscribe(QueueName.NOTIFICATIONS_DELIVER, async (job) => {
      await this.handle(job);
    });

    for (const name of SCHEDULES) {
      const scheduled = SCHEDULE.find((entry) => entry.name === name);
      if (scheduled === undefined) {
        // The catalogue is the single source of the cron expression; an entry removed from it
        // must not be resurrected by a literal here.
        this.logger.warn('A notification schedule is not in the catalogue', { name });
        continue;
      }
      await this.queue.schedule(scheduled.queue, scheduled.name, scheduled.cron, {
        kind: `${name}-fanout`,
      });
      this.logger.info('A notification schedule is declared', {
        name: scheduled.name,
        cron: scheduled.cron,
        queue: scheduled.queue,
      });
    }
  }

  private async handle(job: JobEnvelope): Promise<void> {
    const payload = job.payload as Record<string, unknown>;
    const kind = payload['kind'];

    switch (kind) {
      case `${DELIVER_SCHEDULE}-fanout`:
        return this.fanOut(job, 'notifications.deliver-tenant');
      case `${DIGEST_HOURLY_SCHEDULE}-fanout`:
        return this.fanOut(job, 'notifications.digest-tenant', DigestFrequency.HOURLY);
      case `${DIGEST_DAILY_SCHEDULE}-fanout`:
        return this.fanOut(job, 'notifications.digest-tenant', DigestFrequency.DAILY);
      case `${DIGEST_WEEKLY_SCHEDULE}-fanout`:
        return this.fanOut(job, 'notifications.digest-tenant', DigestFrequency.WEEKLY);
      case `${RELEASE_SCHEDULE}-fanout`:
        return this.fanOut(job, 'notifications.release-tenant');

      case 'notifications.deliver-tenant':
        return this.deliverTenant(job, payload);
      case 'notifications.digest-tenant':
        return this.digestTenant(job, payload);
      case 'notifications.release-tenant':
        return this.releaseTenant(job, payload);

      default:
        // Anything without a `kind` is an outbox event, which is what the dispatcher enqueues.
        return this.consumeEvent(job, payload);
    }
  }

  /** A schedule fired. One job per tenant this deployment serves. */
  private async fanOut(
    job: JobEnvelope,
    kind: string,
    frequency?: DigestFrequencyKey,
  ): Promise<void> {
    const placements = await this.tenants.all();
    for (const placement of placements) {
      await this.queue.enqueue(
        QueueName.NOTIFICATIONS_DELIVER,
        { kind, tenantId: placement.id, ...(frequency ? { frequency } : {}) },
        // Keyed by the firing, so a redelivered fan-out coalesces instead of running twice.
        { jobId: `${kind}:${frequency ?? 'all'}:${placement.id}:${job.jobId}` },
      );
    }
  }

  /**
   * One outbox event, translated.
   *
   * Idempotency lives below this class: `notify` keys on `(eventId, recipient, channel)` and the
   * event id is the outbox row's own, so a redelivered job finds every message already written
   * and creates none.
   */
  private async consumeEvent(job: JobEnvelope, payload: Record<string, unknown>): Promise<void> {
    const tenantId = asString(payload['tenantId']);
    const eventType = asString(payload['eventType']);
    const eventId = asString(payload['eventId']);
    if (tenantId === null || eventType === null || eventId === null) {
      // Unretryable: the payload will not grow a recognisable shape on a fifth attempt. Logged
      // and dropped, as every consumer since Phase 7 treats a malformed job.
      this.logger.warn('Dropped a notification lane job with an unrecognised shape', {
        jobId: job.jobId,
      });
      return;
    }
    const correlationId = asString(payload['correlationId']) ?? job.jobId;
    const eventPayload = (payload['payload'] ?? {}) as Record<string, unknown>;

    await runWithContext(systemContext(tenantId, correlationId), async () => {
      const created = await this.events.handle({ eventId, eventType, payload: eventPayload });
      if (created > 0) {
        this.logger.debug('An event produced notifications', { eventType, created });
      }
    });
  }

  private async deliverTenant(job: JobEnvelope, payload: Record<string, unknown>): Promise<void> {
    const tenantId = asString(payload['tenantId']);
    if (tenantId === null) {
      this.logger.warn('Dropped a delivery job with no tenant', { jobId: job.jobId });
      return;
    }
    await runWithContext(systemContext(tenantId, job.jobId), async () => {
      // Quiet hours first: a message whose window closed this minute should go out in this pass
      // rather than wait for the next one.
      const released = await this.delivery.releaseHeld();
      const outcome = await this.delivery.deliverBatch(NotificationChannel.EMAIL);
      if (outcome.attempted > 0 || released > 0) {
        this.logger.info('A notification delivery pass ran', {
          tenantId,
          released,
          ...outcome,
        });
      }
    });
  }

  private async digestTenant(job: JobEnvelope, payload: Record<string, unknown>): Promise<void> {
    const tenantId = asString(payload['tenantId']);
    const frequency = asDigestFrequency(payload['frequency']);
    if (tenantId === null || frequency === null) {
      this.logger.warn('Dropped a digest job with no tenant or frequency', { jobId: job.jobId });
      return;
    }
    await runWithContext(systemContext(tenantId, job.jobId), async () => {
      const produced = await this.digests.collect(frequency);
      if (produced > 0) {
        this.logger.info('Digests were collected', { tenantId, frequency, produced });
      }
    });
  }

  private async releaseTenant(job: JobEnvelope, payload: Record<string, unknown>): Promise<void> {
    const tenantId = asString(payload['tenantId']);
    if (tenantId === null) {
      this.logger.warn('Dropped a batch release job with no tenant', { jobId: job.jobId });
      return;
    }
    await runWithContext(systemContext(tenantId, job.jobId), async () => {
      const sent = await this.events.releaseBatches(RELEASE_BATCH);
      if (sent > 0) {
        this.logger.info('Coalesced notification summaries were sent', { tenantId, sent });
      }
    });
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function asDigestFrequency(value: unknown): DigestFrequencyKey | null {
  return typeof value === 'string' &&
    (Object.values(DigestFrequency) as readonly string[]).includes(value)
    ? (value as DigestFrequencyKey)
    : null;
}

function systemContext(tenantId: string, correlationId: string): RequestContext {
  return {
    tenantId: asId<TenantId>(tenantId),
    // A clock or a committed event acted, not a person. Every actor column is nullable for
    // exactly this case, and attributing a notification to whoever caused the event it describes
    // would be a false statement: they did the thing, they did not send the mail.
    userId: null,
    roles: [],
    permissions: [],
    sessionId: null,
    correlationId,
    permissionVersion: 0,
    locale: 'en',
  };
}
