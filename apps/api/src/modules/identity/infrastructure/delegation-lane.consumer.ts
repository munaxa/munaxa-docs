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
import { DELEGATION_SERVICE } from '../application/ports';
import type { DefaultDelegationService } from '../application/delegation.service';

/** The one schedule entry this consumer answers for. */
const EXPIRE_SCHEDULE = 'identity.expire-delegations';

/** How many ended delegations one tenant's nightly pass records. Bounded by the lane's budget. */
const EXPIRE_BATCH = 500;

/**
 * The `identity.delegation` lane's consumer — the third to follow `AuditLaneConsumer`'s shape.
 *
 * Everything structural here was argued by Phase 9 and repeated by Phase 10, so it is stated
 * rather than re-argued: it runs in the **API process** behind `queue.consumersEnabled` (every
 * consumer since Phase 4 lives there; `apps/worker` composes none of the domain modules); the
 * schedule is **declared, named and upserted** in the broker rather than timed, so ten instances
 * booting produce one firing; and the firing is tenant-less and fans out one job per tenant from
 * `TENANT_REGISTRY.all()`, because under ADR-0015 there is no "all tenants" pass this product's
 * data model can make.
 *
 * ## Why this lane exists at all
 *
 * Two questions had to be answered separately, and conflating them is the mistake this comment
 * exists to prevent.
 *
 * **What makes an expired delegation stop authorising?** A predicate, in
 * `DelegationRepository.listActiveFor`'s `WHERE` and in `delegationCoversInstant`. Not this job.
 * A delegation past its end date authorises nothing from the millisecond it passes, whether this
 * consumer ran last night, last week or never — so a stalled queue, a Redis outage or a
 * deployment that forgot to enable consumers can never leave an authority in place. That property
 * is worth more than anything a job could add, and it is why the job is allowed to be a plain
 * nightly sweep rather than a delayed job per delegation.
 *
 * **What writes `DELEGATION_EXPIRED`?** This. `13-audit-architecture.md` §2 lists the action and
 * §2's ownership table attributes it to this phase, so something has to write it. The alternative
 * — writing it lazily when somebody next looks at the delegation — would date the event to
 * whenever that happened, and for a delegation nobody looks at again, to never. "Which
 * delegations ended last quarter" would then be a question the trail answers wrongly, which is
 * worse than one it cannot answer at all.
 *
 * ## Why its own lane
 *
 * `retention.run` was the obvious home — a nightly, tenant-partitioned, cheap, idempotent pass is
 * cost-identical to `retention.sweep`, and the queue catalogue separates lanes by cost rather than
 * by module. It is not used, for a reason in the adapter rather than in the design:
 * `BullMqAdapter.subscribe` constructs one `Worker` per call, and two workers on one queue name
 * both pull from it. A second subscriber on `retention.run` would race `RetentionLaneConsumer` for
 * that lane's jobs, and each would see the other's payloads as unrecognised and drop them. One
 * consumer per lane is the invariant; a lane is the cheap thing to add.
 *
 * ## Idempotency lives below this class
 *
 * A redelivered sweep re-reads `listEndedButActive`, and `transition` carries the expected status
 * in its `WHERE` — so the second delivery finds the rows already `EXPIRED`, matches none of them
 * and writes nothing. The fan-out job ids carry the firing's own id, so one night's fan-out
 * redelivered coalesces rather than sweeping twice, exactly as the audit and retention ones do.
 */
@Injectable()
export class DelegationLaneConsumer implements OnApplicationBootstrap {
  constructor(
    @Inject(QUEUE_CONSUMER) private readonly consumer: QueueConsumer,
    @Inject(QUEUE_PORT) private readonly queue: QueuePort,
    @Inject(TENANT_REGISTRY) private readonly tenants: TenantRegistry,
    @Inject(DELEGATION_SERVICE) private readonly delegations: DefaultDelegationService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.queue.consumersEnabled) {
      this.logger.info('The delegation lane is not consumed by this process', {
        queues: [QueueName.IDENTITY_DELEGATION],
      });
      return;
    }
    await this.consumer.subscribe(QueueName.IDENTITY_DELEGATION, async (job) => {
      await this.handle(job);
    });

    const scheduled = SCHEDULE.find((entry) => entry.name === EXPIRE_SCHEDULE);
    if (scheduled === undefined) {
      // The catalogue is the single source of the cron expression; an entry removed from it must
      // not be resurrected by a literal here.
      this.logger.warn('The delegation expiry schedule is not in the catalogue', {
        name: EXPIRE_SCHEDULE,
      });
      return;
    }
    await this.queue.schedule(scheduled.queue, scheduled.name, scheduled.cron, {
      kind: `${EXPIRE_SCHEDULE}-fanout`,
    });
    this.logger.info('The delegation expiry schedule is declared', {
      name: scheduled.name,
      cron: scheduled.cron,
      queue: scheduled.queue,
    });
  }

  private async handle(job: JobEnvelope): Promise<void> {
    const payload = job.payload as Record<string, unknown>;
    switch (payload['kind']) {
      case `${EXPIRE_SCHEDULE}-fanout`:
        return this.fanOut(job);
      case 'identity.expire-delegations-tenant':
        return this.expireTenant(job, payload);
      default:
        // Unretryable: the payload will not grow a recognisable shape on a third attempt. Logged
        // and dropped, as every consumer since Phase 7 treats a malformed job.
        this.logger.warn('Dropped a delegation lane job with an unrecognised shape', {
          jobId: job.jobId,
        });
        return;
    }
  }

  /** The schedule fired. One job per tenant this deployment serves. */
  private async fanOut(job: JobEnvelope): Promise<void> {
    const placements = await this.tenants.all();
    const kind = 'identity.expire-delegations-tenant';
    for (const placement of placements) {
      await this.queue.enqueue(
        QueueName.IDENTITY_DELEGATION,
        { kind, tenantId: placement.id },
        // Keyed by the firing, so a redelivered fan-out coalesces instead of running twice.
        { jobId: `${kind}:${placement.id}:${job.jobId}` },
      );
    }
    this.logger.info('Delegation expiry fanned out', { tenants: placements.length });
  }

  private async expireTenant(job: JobEnvelope, payload: Record<string, unknown>): Promise<void> {
    const tenantId = asString(payload['tenantId']);
    if (tenantId === null) {
      this.logger.warn('Dropped a delegation expiry job with no tenant', { jobId: job.jobId });
      return;
    }
    await runWithContext(systemContext(tenantId, job.jobId), async () => {
      const recorded = await this.delegations.expireEnded(EXPIRE_BATCH);
      if (recorded > 0) {
        this.logger.info('Recorded delegations whose period had ended', { tenantId, recorded });
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
    // A clock acted, not a person. Every actor column is nullable for exactly this case, and
    // attributing an expiry to whoever created the delegation would be a false statement in the
    // trail — they arranged it; they did not end it.
    userId: null,
    roles: [],
    permissions: [],
    sessionId: null,
    correlationId,
    permissionVersion: 0,
    locale: 'en',
  };
}
