import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { USAGE_BATCH_MAX, usagePath, type UsageBatch } from '@munaxa/licensing';

import {
  type TenantId,
  ActorChannel,
  DOCS_PRODUCT_KEY,
  QueueName,
  SCHEDULE,
  asId,
} from '@edms/domain';

import { APP_CONFIG, type AppConfig } from '../config';
import { LOGGER, type Logger } from '../observability/logger';
import { UNIT_OF_WORK, type UnitOfWork } from '../prisma/unit-of-work';
import { type RequestContext, runWithContext } from '../tenancy/tenant-context';
import { TENANT_REGISTRY, type TenantRegistry } from '../tenancy/tenant-registry.port';
import { CLOCK_PORT, type ClockPort } from '../../ports/clock.port';
import { OUTBOUND_HTTP_PORT, type OutboundHttpPort } from '../../ports/outbound-http.port';
import {
  QUEUE_CONSUMER,
  QUEUE_PORT,
  type JobEnvelope,
  type QueueConsumer,
  type QueuePort,
} from '../../ports/queue.port';
import { UsageMeters } from './usage-meters';

const SCHEDULE_NAME = 'licensing.report-usage';
const FANOUT = `${SCHEDULE_NAME}-fanout`;
const PER_TENANT = 'licensing.report-usage-tenant';
const TIMEOUT_MS = 5_000;
const HOUR_MS = 3_600_000;

/**
 * The `licensing.usage` lane: each tenant's metered levels, reported to the central subscription
 * service every hour — ADR-0026.
 *
 * Consumed only under `LICENSING_MODE=CONTROL_PLANE` and only by a process with consumers enabled;
 * anywhere else it declares nothing, so an on-premises or unmetered deployment never sends a byte.
 * The shape is the webhook lane's: a broker-held schedule fans out one job per tenant from
 * `TENANT_REGISTRY.all()`, and each job measures inside that tenant's unit of work.
 *
 * Each report is a level at **the hour the firing belongs to**, carried on the job, so a retried or
 * redelivered job reports the same point and the service's `(tenant, metric, instant)` key keeps
 * one. Through the outbound port, so the service's host must be on the allow-list like any other
 * destination. A refusal is thrown so the lane retries it; three failures end in the dead-letter
 * queue, and change no access — the report is informational there.
 */
@Injectable()
export class UsageLaneConsumer implements OnApplicationBootstrap {
  constructor(
    @Inject(QUEUE_CONSUMER) private readonly consumer: QueueConsumer,
    @Inject(QUEUE_PORT) private readonly queue: QueuePort,
    @Inject(TENANT_REGISTRY) private readonly tenants: TenantRegistry,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK_PORT) private readonly clock: ClockPort,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(OUTBOUND_HTTP_PORT) private readonly http: OutboundHttpPort,
    @Inject(UsageMeters) private readonly meters: UsageMeters,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.queue.consumersEnabled || this.config.licensing.controlPlane === null) {
      return;
    }
    await this.consumer.subscribe(QueueName.LICENSING_USAGE, (job) => this.handle(job));
    const scheduled = SCHEDULE.find((entry) => entry.name === SCHEDULE_NAME);
    if (scheduled === undefined) {
      this.logger.warn('The usage schedule is not in the catalogue', { name: SCHEDULE_NAME });
      return;
    }
    await this.queue.schedule(scheduled.queue, scheduled.name, scheduled.cron, { kind: FANOUT });
  }

  async handle(job: JobEnvelope): Promise<void> {
    const payload = job.payload as Record<string, unknown>;
    if (payload['kind'] === FANOUT) {
      const hour = new Date(Math.floor(this.clock.now().getTime() / HOUR_MS) * HOUR_MS);
      for (const placement of await this.tenants.all()) {
        await this.queue.enqueue(
          QueueName.LICENSING_USAGE,
          { kind: PER_TENANT, tenantId: placement.id, measuredAt: hour.toISOString() },
          // Keyed by tenant and hour, so a redelivered fan-out coalesces rather than running twice.
          { jobId: `${PER_TENANT}:${placement.id}:${hour.toISOString()}` },
        );
      }
      return;
    }
    const tenantId = typeof payload['tenantId'] === 'string' ? payload['tenantId'] : null;
    const measuredAt = typeof payload['measuredAt'] === 'string' ? payload['measuredAt'] : null;
    if (payload['kind'] !== PER_TENANT || tenantId === null || measuredAt === null) {
      this.logger.warn('Dropped a usage job with an unrecognised shape', { jobId: job.jobId });
      return;
    }
    await this.report(tenantId, measuredAt);
  }

  private async report(tenantId: string, measuredAt: string): Promise<void> {
    const settings = this.config.licensing.controlPlane;
    if (settings === null) return;
    const levels = await runWithContext(workerContext(tenantId), () =>
      this.unitOfWork.run(() =>
        Promise.all(
          this.meters.all().map(async (meter) => ({
            metric: meter.metric,
            value: Math.max(0, Math.trunc(await meter.measure())),
          })),
        ),
      ),
    );
    if (levels.length === 0) return;
    const batch: UsageBatch = {
      reports: levels
        .slice(0, USAGE_BATCH_MAX)
        .map((level) => ({ tenantId, metric: level.metric, value: level.value, measuredAt })),
    };
    const result = await this.http.send({
      url: `${settings.url}${usagePath(DOCS_PRODUCT_KEY)}`,
      method: 'POST',
      headers: {
        authorization: `Bearer ${settings.token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(batch),
      timeoutMs: TIMEOUT_MS,
    });
    if (!result.ok || result.response.status >= 300) {
      // Thrown so the lane retries it. The credential never appears in the message.
      throw new Error(
        `Usage report refused: ${result.ok ? `HTTP ${String(result.response.status)}` : result.failure.kind}`,
      );
    }
  }
}

function workerContext(tenantId: string): RequestContext {
  return {
    tenantId: asId<TenantId>(tenantId),
    userId: null,
    roles: [],
    permissions: [],
    sessionId: null,
    correlationId: `licensing:usage:${tenantId}`,
    permissionVersion: 0,
    locale: 'en',
    channel: ActorChannel.WORKER,
  };
}
