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
import { RETENTION_SERVICE, type RetentionService } from '../application/ports';

/** The two schedule entries this consumer answers for. Declared in Phase 0.5, fired here. */
const SWEEP_SCHEDULE = 'retention.sweep';
const UPLOAD_SCHEDULE = 'storage.sweep-upload-sessions';
/** Phase 18's rolling integrity verifier, the third schedule on this lane. */
const INTEGRITY_SCHEDULE = 'storage.verify-integrity';
/** Phase 6.1's effective-window sweep, the fourth. */
const EXPIRY_SCHEDULE = 'documents.expire-effective';

/** How many due schedules one tenant's nightly pass settles. Bounded by the lane's budget. */
const SWEEP_BATCH = 500;

/**
 * How many documents one tenant's hourly expiry pass settles.
 *
 * Smaller than `SWEEP_BATCH` because this pass runs twenty-four times a day rather than once, and
 * because a backlog is self-clearing: candidates are ordered by how long ago their window closed,
 * so a tenant that publishes five hundred documents with the same expiry date works through them
 * over a few hours rather than holding the lane for one long pass. The steady state is zero.
 */
const EXPIRY_BATCH = 200;

/**
 * The `retention.run` lane's first consumer — the last declared lane in the product to gain one.
 *
 * The shape is `AuditLaneConsumer`'s, followed exactly, because Phase 9 already argued each piece:
 * it runs in the **API process** behind `queue.consumersEnabled` (every consumer since Phase 4
 * lives there; `apps/worker` composes none of the domain modules, so moving destruction there
 * would mean composing them twice); the schedules are **declared, named and upserted** in the
 * broker rather than timed, so ten instances booting produce one firing; and each firing is
 * tenant-less and fans out one job per tenant from `TENANT_REGISTRY.all()`, because under
 * ADR-0015 there is no "all tenants" pass this product's data model can make.
 *
 * ## One lane, four schedules
 *
 * `retention.sweep` (nightly), `storage.sweep-upload-sessions` (every fifteen minutes),
 * `storage.verify-integrity` (nightly) and `documents.expire-effective` (hourly) all land here,
 * and sharing the lane is the catalogue's own decision, worth restating: the lane's
 * concurrency is 1 because *destruction is never run concurrently with itself*, and the upload
 * sweep belongs behind that same gate — it deletes staged objects, which is destruction too, just
 * of bytes nobody had finished claiming. If the fifteen-minute sweep ever queues behind a long
 * nightly run, that is the lane doing its job, not a defect: an expired upload session expires
 * just as well a few minutes later.
 *
 * ## Idempotency lives below this class
 *
 * Redelivery of a sweep job re-reads `listDue`, and a purge removes its schedule in the same
 * transaction as the document — so the second delivery finds nothing live and does nothing. The
 * fan-out job ids carry the firing's own id, so one night's fan-out redelivered coalesces rather
 * than sweeping twice, exactly as the audit verification's do.
 */
@Injectable()
export class RetentionLaneConsumer implements OnApplicationBootstrap {
  constructor(
    @Inject(QUEUE_CONSUMER) private readonly consumer: QueueConsumer,
    @Inject(QUEUE_PORT) private readonly queue: QueuePort,
    @Inject(TENANT_REGISTRY) private readonly tenants: TenantRegistry,
    @Inject(RETENTION_SERVICE) private readonly retention: RetentionService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.queue.consumersEnabled) {
      this.logger.info('The retention lane is not consumed by this process', {
        queues: [QueueName.RETENTION_RUN],
      });
      return;
    }
    await this.consumer.subscribe(QueueName.RETENTION_RUN, async (job) => {
      await this.handle(job);
    });

    for (const name of [SWEEP_SCHEDULE, UPLOAD_SCHEDULE, INTEGRITY_SCHEDULE, EXPIRY_SCHEDULE]) {
      const scheduled = SCHEDULE.find((entry) => entry.name === name);
      if (scheduled === undefined) {
        // The catalogue is the single source of the cron expression; an entry removed from it must
        // not be resurrected by a literal here.
        this.logger.warn('A retention schedule is not in the catalogue', { name });
        continue;
      }
      await this.queue.schedule(scheduled.queue, scheduled.name, scheduled.cron, {
        kind: `${name}-fanout`,
      });
      this.logger.info('A retention schedule is declared', {
        name: scheduled.name,
        cron: scheduled.cron,
        queue: scheduled.queue,
      });
    }
  }

  private async handle(job: JobEnvelope): Promise<void> {
    const payload = job.payload as Record<string, unknown>;
    switch (payload['kind']) {
      case `${SWEEP_SCHEDULE}-fanout`:
        return this.fanOut(job, 'retention.sweep-tenant');
      case `${UPLOAD_SCHEDULE}-fanout`:
        return this.fanOut(job, 'retention.expire-uploads-tenant');
      case `${INTEGRITY_SCHEDULE}-fanout`:
        return this.fanOut(job, 'storage.verify-integrity-tenant');
      case `${EXPIRY_SCHEDULE}-fanout`:
        return this.fanOut(job, 'documents.expire-effective-tenant');
      case 'retention.sweep-tenant':
        return this.sweepTenant(job, payload);
      case 'retention.expire-uploads-tenant':
        return this.expireUploads(job, payload);
      case 'storage.verify-integrity-tenant':
        return this.verifyIntegrity(job, payload);
      case 'documents.expire-effective-tenant':
        return this.expireDocuments(job, payload);
      default:
        // Unretryable: the payload will not grow a recognisable shape on a fifth attempt. Logged
        // and dropped, as every consumer since Phase 7 treats a malformed job.
        this.logger.warn('Dropped a retention lane job with an unrecognised shape', {
          jobId: job.jobId,
        });
        return;
    }
  }

  /** A schedule fired. One job per tenant this deployment serves. */
  private async fanOut(job: JobEnvelope, kind: string): Promise<void> {
    const placements = await this.tenants.all();
    for (const placement of placements) {
      await this.queue.enqueue(
        QueueName.RETENTION_RUN,
        { kind, tenantId: placement.id },
        // Keyed by the firing, so a redelivered fan-out coalesces instead of running twice.
        { jobId: `${kind}:${placement.id}:${job.jobId}` },
      );
    }
    this.logger.info('Retention work fanned out', { kind, tenants: placements.length });
  }

  private async sweepTenant(job: JobEnvelope, payload: Record<string, unknown>): Promise<void> {
    const tenantId = asString(payload['tenantId']);
    if (tenantId === null) {
      this.logger.warn('Dropped a retention sweep job with no tenant', { jobId: job.jobId });
      return;
    }
    await runWithContext(systemContext(tenantId, job.jobId), async () => {
      await this.retention.executeDue(SWEEP_BATCH);
    });
  }

  private async expireUploads(job: JobEnvelope, payload: Record<string, unknown>): Promise<void> {
    const tenantId = asString(payload['tenantId']);
    if (tenantId === null) {
      this.logger.warn('Dropped an upload sweep job with no tenant', { jobId: job.jobId });
      return;
    }
    await runWithContext(systemContext(tenantId, job.jobId), async () => {
      const expired = await this.retention.expireUploadSessions();
      if (expired > 0) {
        this.logger.info('Expired abandoned upload sessions', { tenantId, expired });
      }
    });
  }

  /**
   * One tenant's pass of the rolling integrity verifier — Phase 18.
   *
   * Always logged, including the quiet case, because "the sweep ran and found nothing" and "the
   * sweep did not run" are the two states an operator most needs to tell apart — and a verifier
   * that only speaks when something is wrong is indistinguishable from one that has stopped.
   */
  private async verifyIntegrity(job: JobEnvelope, payload: Record<string, unknown>): Promise<void> {
    const tenantId = asString(payload['tenantId']);
    if (tenantId === null) {
      this.logger.warn('Dropped an integrity sweep job with no tenant', { jobId: job.jobId });
      return;
    }
    await runWithContext(systemContext(tenantId, job.jobId), async () => {
      const pass = await this.retention.verifyStoredIntegrity();
      const context = { tenantId, ...pass };
      if (pass.mismatched > 0 || pass.unreadable > 0) {
        // At error, not warn: 17 §9 lists a checksum mismatch as an immediate alert, and the
        // `INTEGRITY_MISMATCH` rows and the outbox events the sweep already wrote are the
        // evidence behind this line rather than a substitute for it.
        this.logger.error('The integrity sweep found stored bytes it cannot vouch for', context);
        return;
      }
      this.logger.info('The integrity sweep verified stored blobs', context);
    });
  }

  /**
   * One tenant's pass of the effective-window sweep — Phase 6.1.
   *
   * Logged only when it expired something, which is the opposite of `verifyIntegrity` above and
   * deliberately so. That sweep is a *verifier*, and "it ran and found nothing" is the reassurance
   * an operator needs; this one is an ordinary state change that fires hourly across every tenant,
   * and a line per tenant per hour saying "nothing expired" would be twenty-four thousand lines a
   * day drowning the ones that matter. Its steady state is silence.
   */
  private async expireDocuments(job: JobEnvelope, payload: Record<string, unknown>): Promise<void> {
    const tenantId = asString(payload['tenantId']);
    if (tenantId === null) {
      this.logger.warn('Dropped a document expiry job with no tenant', { jobId: job.jobId });
      return;
    }
    await runWithContext(systemContext(tenantId, job.jobId), async () => {
      const pass = await this.retention.expireEffectiveDocuments(EXPIRY_BATCH);
      if (pass.expired > 0) {
        this.logger.info('Documents reached the end of their effective window', {
          tenantId,
          ...pass,
        });
      }
    });
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function systemContext(tenantId: string, correlationId: string): RequestContext {
  return {
    tenantId: asId<TenantId>(tenantId),
    // The system acted alone. Every actor column is nullable for exactly this case, and a purge
    // attributed to a person would be a false statement in the trail — the approver is recorded
    // on the schedule, which is a different fact.
    userId: null,
    roles: [],
    permissions: [],
    sessionId: null,
    correlationId,
    permissionVersion: 0,
    locale: 'en',
  };
}
