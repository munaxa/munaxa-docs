import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';

import { type TenantId, ActorChannel, QueueName, SCHEDULE, asId } from '@edms/domain';

import { APP_CONFIG, type AppConfig } from '../../../core/config';
import { LOGGER, type Logger } from '../../../core/observability/logger';
import { type RequestContext, runWithContext } from '../../../core/tenancy/tenant-context';
import { TENANT_REGISTRY, type TenantRegistry } from '../../../core/tenancy/tenant-registry.port';
import {
  QUEUE_CONSUMER,
  QUEUE_PORT,
  type JobEnvelope,
  type QueueConsumer,
  type QueuePort,
} from '../../../ports/queue.port';
import { CLOCK_PORT, type ClockPort } from '../../../ports/clock.port';
import { AuditSinkService } from '../application/audit-sink.service';
import { WEBHOOK_DELIVERY_SERVICE, type WebhookDeliveryService } from '../application/ports';

const RETRY_SCHEDULE = 'webhooks.retry-due';
const STREAM_SCHEDULE = 'audit.stream-sinks';

/**
 * The `webhooks.deliver` and `audit.stream` lanes.
 *
 * Everything structural is Phase 4's and has been repeated by every consumer since, so it is
 * stated rather than re-argued: it runs in the **API process** behind `queue.consumersEnabled`
 * (`apps/worker` composes none of the domain modules); the schedules are declared, named and
 * upserted in the broker rather than timed, so ten instances booting produce one firing; and each
 * scheduled firing is tenant-less and fans out one job per tenant from `TENANT_REGISTRY.all()`,
 * because under ADR-0015 there is no "all tenants" query this data model can make.
 *
 * Phase 11's constraint holds and is why one class answers for two lanes rather than two classes
 * answering for one each: `BullMqAdapter.subscribe` constructs one `Worker` per call, so two
 * subscribers on one lane race for its jobs. **One consumer per lane** — and one class may hold
 * two subscriptions.
 *
 * ## Why the first delivery attempt does not come from a schedule
 *
 * `fanOut` attempts each delivery immediately, inside the job that received the outbox event. The
 * retry *sweep* is the schedule. Had the first attempt been left to the sweep, every webhook in
 * the product would arrive up to a minute after the thing it describes, which for an integration
 * watching for "a document was published" is the difference between a webhook and a poll.
 *
 * ## Two lanes rather than one, and the reason is a cursor
 *
 * A webhook delivery is one event to one endpoint, independent of every other; the lane runs
 * twelve at a time. An audit-sink push is a **contiguous range of one tenant's hash chain**, and
 * the next push may not begin until the last one's cursor has advanced — two concurrent pushes for
 * one tenant would either send a range twice or advance past events nobody sent, and the gap-free
 * sequence that makes the stream worth trusting would stop being a guarantee this end can make.
 * `audit.stream` therefore declares `perTenantConcurrency: 1`, which is a property `webhooks.deliver`
 * must not have and which a shared lane could not express.
 */
@Injectable()
export class WebhookLaneConsumer implements OnApplicationBootstrap {
  constructor(
    @Inject(QUEUE_CONSUMER) private readonly consumer: QueueConsumer,
    @Inject(QUEUE_PORT) private readonly queue: QueuePort,
    @Inject(TENANT_REGISTRY) private readonly tenants: TenantRegistry,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK_PORT) private readonly clock: ClockPort,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(WEBHOOK_DELIVERY_SERVICE) private readonly deliveries: WebhookDeliveryService,
    private readonly sinks: AuditSinkService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.queue.consumersEnabled) {
      this.logger.info('The webhook and audit-stream lanes are not consumed by this process', {
        queues: [QueueName.WEBHOOKS_DELIVER, QueueName.AUDIT_STREAM],
      });
      return;
    }

    await this.consumer.subscribe(QueueName.WEBHOOKS_DELIVER, async (job) => {
      await this.handleWebhookJob(job);
    });
    await this.consumer.subscribe(QueueName.AUDIT_STREAM, async (job) => {
      await this.handleStreamJob(job);
    });

    for (const name of [RETRY_SCHEDULE, STREAM_SCHEDULE]) {
      const scheduled = SCHEDULE.find((entry) => entry.name === name);
      if (scheduled === undefined) {
        // The catalogue is the single source of the cron expression; an entry removed from it must
        // not be resurrected by a literal here.
        this.logger.warn('An integration schedule is not in the catalogue', { name });
        continue;
      }
      await this.queue.schedule(scheduled.queue, scheduled.name, scheduled.cron, {
        kind: `${name}-fanout`,
      });
      this.logger.info('An integration schedule is declared', {
        name: scheduled.name,
        cron: scheduled.cron,
        queue: scheduled.queue,
      });
    }
  }

  private async handleWebhookJob(job: JobEnvelope): Promise<void> {
    const payload = job.payload as Record<string, unknown>;
    if (payload['kind'] === `${RETRY_SCHEDULE}-fanout`) {
      return this.fanOut(QueueName.WEBHOOKS_DELIVER, 'webhooks.retry-tenant', job);
    }
    if (payload['kind'] === 'webhooks.retry-tenant') {
      return this.retryTenant(job, payload);
    }
    // No `kind` means an outbox event, which is what the dispatcher enqueues.
    return this.consumeEvent(job, payload);
  }

  private async handleStreamJob(job: JobEnvelope): Promise<void> {
    const payload = job.payload as Record<string, unknown>;
    if (payload['kind'] === `${STREAM_SCHEDULE}-fanout`) {
      return this.fanOut(QueueName.AUDIT_STREAM, 'audit.stream-tenant', job);
    }
    if (payload['kind'] === 'audit.stream-tenant') {
      return this.streamTenant(job, payload);
    }
    this.logger.warn('Dropped an audit-stream job with an unrecognised shape', {
      jobId: job.jobId,
    });
  }

  /** A schedule fired. One job per tenant this deployment serves. */
  private async fanOut(
    queue: typeof QueueName.WEBHOOKS_DELIVER | typeof QueueName.AUDIT_STREAM,
    kind: string,
    job: JobEnvelope,
  ): Promise<void> {
    for (const placement of await this.tenants.all()) {
      await this.queue.enqueue(
        queue,
        { kind, tenantId: placement.id },
        // Keyed by the firing, so a redelivered fan-out coalesces rather than running twice.
        { jobId: `${kind}:${placement.id}:${job.jobId}` },
      );
    }
  }

  /**
   * One outbox event, fanned out to whichever endpoints subscribe.
   *
   * Idempotency lives below this class: the delivery row's unique `(endpoint_id, event_id)` means
   * a redelivered job finds every delivery already recorded and sends nothing. That is what makes
   * the outbox's at-least-once safe here — without it, a dispatcher crashing between enqueue and
   * mark-processed would `POST` twice to somebody else's server.
   */
  private async consumeEvent(job: JobEnvelope, payload: Record<string, unknown>): Promise<void> {
    const tenantId = asString(payload['tenantId']);
    const eventId = asString(payload['eventId']);
    const eventType = asString(payload['eventType']);
    const aggregateType = asString(payload['aggregateType']);
    const aggregateId = asString(payload['aggregateId']);
    if (!tenantId || !eventId || !eventType || !aggregateType || !aggregateId) {
      // Unretryable: the payload will not grow a recognisable shape on a fifth attempt. Logged and
      // dropped, as every consumer since Phase 7 treats a malformed job.
      this.logger.warn('Dropped a webhook lane job with an unrecognised shape', {
        jobId: job.jobId,
      });
      return;
    }
    const correlationId = asString(payload['correlationId']) ?? job.jobId;

    await runWithContext(workerContext(tenantId, correlationId), async () => {
      const queued = await this.deliveries.fanOut({
        eventId: asId(eventId),
        tenantId: asId<TenantId>(tenantId),
        eventType,
        aggregateType,
        aggregateId,
        // The event's own instant is not on the job envelope, so the delivery is stamped now. The
        // difference is the dispatcher's poll interval — seconds — and the receiver has the
        // event's identifier, which is what it de-duplicates on.
        occurredAt: this.clock.now(),
        payload: payload['payload'],
        correlationId,
      });
      if (queued > 0) {
        this.logger.debug('An event was fanned out to webhook endpoints', { eventType, queued });
      }
    });
  }

  private async retryTenant(job: JobEnvelope, payload: Record<string, unknown>): Promise<void> {
    const tenantId = asString(payload['tenantId']);
    if (!tenantId) {
      this.logger.warn('Dropped a webhook retry job with no tenant', { jobId: job.jobId });
      return;
    }
    await runWithContext(workerContext(tenantId, job.jobId), async () => {
      const settled = await this.deliveries.retryDue(this.clock.now());
      if (settled > 0) {
        this.logger.info('A webhook retry sweep ran', { tenantId, settled });
      }
    });
  }

  private async streamTenant(job: JobEnvelope, payload: Record<string, unknown>): Promise<void> {
    const tenantId = asString(payload['tenantId']);
    if (!tenantId) {
      this.logger.warn('Dropped an audit-stream job with no tenant', { jobId: job.jobId });
      return;
    }
    await runWithContext(workerContext(tenantId, job.jobId), async () => {
      const outcome = await this.sinks.push();
      if (outcome.sent > 0) {
        this.logger.info('An audit sink push ran', { tenantId, sent: outcome.sent });
      }
    });
  }
}

/**
 * The context a lane job runs in.
 *
 * `channel: WORKER`, and Phase 17 is the phase in which that stopped being a lie. Every consumer
 * before this one ran with no channel and every audit write it caused recorded itself as `WEB` —
 * because the channel was a literal in four places rather than a fact in the context. It is a fact
 * now, and the three values that were never written — `API`, `WORKER` and `SYSTEM` — are written
 * by the API-key authenticator, by this, and by provisioning respectively.
 */
function workerContext(tenantId: string, correlationId: string): RequestContext {
  return {
    tenantId: asId<TenantId>(tenantId),
    // A committed event acted, not a person — and a webhook has no reach question to answer, so
    // there is nothing a subject would be used for. Every actor column is nullable for this case.
    userId: null,
    roles: [],
    permissions: [],
    sessionId: null,
    correlationId,
    permissionVersion: 0,
    locale: 'en',
    channel: ActorChannel.WORKER,
  };
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
