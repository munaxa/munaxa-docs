import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';

import { QueueName, SCHEDULE, type TenantId, asId } from '@edms/domain';

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
import { AuditExportService } from '../application/audit-export.service';
import { AuditVerificationService } from '../application/audit-verification.service';

/** The schedule entry this consumer answers for; the rest of `SCHEDULE` belongs to later phases. */
const VERIFY_SCHEDULE = 'audit.verify-chain';

/**
 * The `audit.export` lane's first consumer, and the first thing in the product to consume a
 * *schedule*.
 *
 * ## Why it runs in the API process
 *
 * `apps/worker` has printed "No consumers are registered in Phase 0.5" since Phase 0.5, and every
 * consumer built since — Phase 4's timers, Phase 7's renderers, Phase 8's index — lives here,
 * behind `queue.consumersEnabled`. That is the precedent, and this phase follows it rather than
 * departing from it, for a reason worth stating: the worker composes none of the domain modules, so
 * moving audit verification there would mean either composing them twice or having a flag that
 * means "consume everything" in one process and "consume one lane" in another. A deployment that
 * wants the work elsewhere already has the switch — every instance enqueues, one consumes.
 *
 * ## One lane, two workloads
 *
 * The schedule catalogue puts `audit.verify-chain` on `audit.export`, which has concurrency 2 and a
 * fifteen-minute budget. So a nightly verification and an operator's evidence bundle can run at the
 * same time, and neither starves the other. They are genuinely different in cost — verification is
 * bounded by `AUDIT_VERIFY_MAX_EVENTS` and short, an export is bounded by the range somebody asked
 * for and is not — which is the argument for separating lanes "by cost, not by module". They share
 * one anyway because two audit lanes for two audit jobs at concurrency 1 each is the same capacity
 * with more configuration; if an export ever delays a night's verification, the fix is a lane, and
 * the report records that as the trigger.
 *
 * ## Why the schedule is declared rather than timed
 *
 * `QueuePort.schedule` upserts a *named* cron schedule in the broker, so every instance that boots
 * declares the same one and there is one firing rather than one per instance. `ScheduledJob.lockKey`
 * anticipated a lock around a timer; a named schedule is strictly stronger, because there was only
 * ever one pass to run rather than three that raced for a lease.
 *
 * The firing is tenant-less. Its handler fans out one job per tenant from `TENANT_REGISTRY.all()` —
 * the registry's own documented use, beside the migration runner and the health check — because
 * every tenant has its own database and its own chain, and one pass over "all tenants" is not a
 * thing this product's data model has.
 */
@Injectable()
export class AuditLaneConsumer implements OnApplicationBootstrap {
  constructor(
    @Inject(QUEUE_CONSUMER) private readonly consumer: QueueConsumer,
    @Inject(QUEUE_PORT) private readonly queue: QueuePort,
    @Inject(TENANT_REGISTRY) private readonly tenants: TenantRegistry,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly verification: AuditVerificationService,
    private readonly exports: AuditExportService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.queue.consumersEnabled) {
      this.logger.info('The audit export lane is not consumed by this process', {
        queues: [QueueName.AUDIT_EXPORT],
      });
      return;
    }
    await this.consumer.subscribe(QueueName.AUDIT_EXPORT, async (job) => {
      await this.handle(job);
    });

    const scheduled = SCHEDULE.find((entry) => entry.name === VERIFY_SCHEDULE);
    if (scheduled === undefined) {
      // The catalogue is the single source of the cron expression, so an entry that has been
      // removed from it must not be resurrected by a literal here.
      this.logger.warn('The audit verification schedule is not in the catalogue', {
        name: VERIFY_SCHEDULE,
      });
      return;
    }
    await this.queue.schedule(scheduled.queue, scheduled.name, scheduled.cron, {
      kind: 'audit.verify-fanout',
    });
    this.logger.info('The audit verification schedule is declared', {
      cron: scheduled.cron,
      queue: scheduled.queue,
    });
  }

  private async handle(job: JobEnvelope): Promise<void> {
    const payload = job.payload as Record<string, unknown>;
    switch (payload['kind']) {
      case 'audit.verify-fanout':
        return this.fanOutVerification(job);
      case 'audit.verify':
        return this.verifyTenant(job, payload);
      case 'audit.export':
        return this.runExport(job, payload);
      default:
        // Unretryable: the payload will not grow a recognisable shape on a fifth attempt. Logged
        // and dropped, exactly as the search and preview consumers treat a malformed job.
        this.logger.warn('Dropped an audit lane job with an unrecognised shape', {
          jobId: job.jobId,
        });
        return;
    }
  }

  /** The schedule fired. One verification job per tenant this deployment serves. */
  private async fanOutVerification(job: JobEnvelope): Promise<void> {
    const placements = await this.tenants.all();
    for (const placement of placements) {
      await this.queue.enqueue(
        QueueName.AUDIT_EXPORT,
        { kind: 'audit.verify', tenantId: placement.id },
        // Dated, so a redelivery of the same night's fan-out coalesces rather than verifying
        // twice. The date comes from the job rather than the clock for the same reason a
        // projection's debounce bucket does: two instances must compute the same identifier.
        { jobId: `audit:verify:${placement.id}:${job.jobId}` },
      );
    }
    this.logger.info('Audit verification fanned out', { tenants: placements.length });
  }

  private async verifyTenant(job: JobEnvelope, payload: Record<string, unknown>): Promise<void> {
    const tenantId = asString(payload['tenantId']);
    if (tenantId === null) {
      this.logger.warn('Dropped an audit verification job with no tenant', { jobId: job.jobId });
      return;
    }
    await runWithContext(systemContext(tenantId, job.jobId), async () => {
      await this.verification.verify();
    });
  }

  private async runExport(job: JobEnvelope, payload: Record<string, unknown>): Promise<void> {
    const tenantId = asString(payload['tenantId']);
    const exportId = asString(payload['exportId']);
    if (tenantId === null || exportId === null) {
      this.logger.warn('Dropped a malformed audit export job', { jobId: job.jobId });
      return;
    }
    await runWithContext(systemContext(tenantId, job.jobId), async () => {
      await this.exports.run(asId(exportId));
    });
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function systemContext(tenantId: string, correlationId: string): RequestContext {
  return {
    tenantId: asId<TenantId>(tenantId),
    // The system acted alone. Every actor column is nullable for exactly this case, and a
    // verification pass attributed to a person would be a false statement in the trail.
    userId: null,
    roles: [],
    permissions: [],
    sessionId: null,
    correlationId,
    permissionVersion: 0,
    locale: 'en',
  };
}
