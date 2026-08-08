import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';

import { BulkOperationState, type BulkTally, QueueName, type TenantId, asId } from '@edms/domain';

import { APP_CONFIG, type AppConfig } from '../config';
import { LOGGER, type Logger } from '../observability/logger';
import { UNIT_OF_WORK, type UnitOfWork } from '../prisma/unit-of-work';
import { type RequestContext, runWithContext } from '../tenancy/tenant-context';
import { QUEUE_CONSUMER, type JobEnvelope, type QueueConsumer } from '../../ports/queue.port';
import { DefaultBulkExecutor } from './bulk-executor';
import {
  BULK_OPERATION_REPOSITORY,
  BULK_PLAN_REGISTRY,
  BULK_REQUESTER_DIRECTORY,
  type BulkOperationRepository,
  type BulkPlanRegistry,
  type BulkRequesterDirectory,
} from './bulk.port';

/**
 * The `documents.bulk` lane's first consumer — Phase 6.2.
 *
 * The lane was declared in Phase 16 with a concurrency, a per-tenant cap, a retry policy and a
 * dead-letter queue, and had **no producer and no consumer** until this phase. That is what made
 * `bulk.synchronousLimit` decorative: there was nowhere for a large operation to go, so every one
 * of them ran inside the request that asked for it.
 *
 * The shape is `RetentionLaneConsumer`'s, followed deliberately: it runs in the **API process**
 * behind `queue.consumersEnabled` (every consumer since Phase 4 does; `apps/worker` composes none
 * of the domain modules, and the plan factories are module providers), and one `subscribe` per
 * lane, because the adapter builds one `Worker` per call and two on one name would race.
 *
 * ## Why it takes the operation identifier and reads everything else
 *
 * The job payload is `{ operationId }`. The targets and the plan input are on the row, read under
 * the tenant's own context. So a queue payload cannot carry another tenant's identifiers, a
 * five-thousand-object import is not five thousand UUIDs in Redis, and the tenant a job executes
 * in comes from the envelope the dispatcher stamped rather than from anything a document id could
 * be made to imply.
 *
 * ## Authority is read now, not copied then
 *
 * The requester's roles and permissions are resolved at execution time through
 * `BULK_REQUESTER_DIRECTORY`, never taken from the enqueue-time context. A person whose grant was
 * revoked while their import queued does not get to spend it: the per-object ACL resolution the
 * executor already does is then run against their *current* subject, and the objects it can no
 * longer reach come back `REFUSED` rather than applied.
 */
@Injectable()
export class BulkLaneConsumer implements OnApplicationBootstrap {
  constructor(
    @Inject(QUEUE_CONSUMER) private readonly consumer: QueueConsumer,
    @Inject(BULK_OPERATION_REPOSITORY) private readonly operations: BulkOperationRepository,
    @Inject(BULK_PLAN_REGISTRY) private readonly plans: BulkPlanRegistry,
    @Inject(BULK_REQUESTER_DIRECTORY) private readonly requesters: BulkRequesterDirectory,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    private readonly executor: DefaultBulkExecutor,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.queue.consumersEnabled) {
      this.logger.info('The bulk lane is not consumed by this process', {
        queues: [QueueName.DOCUMENTS_BULK],
      });
      return;
    }
    await this.consumer.subscribe(QueueName.DOCUMENTS_BULK, async (job) => {
      await this.handle(job);
    });
  }

  private async handle(job: JobEnvelope): Promise<void> {
    const payload = job.payload as Record<string, unknown>;
    const tenantId = asString(payload['tenantId']);
    const eventPayload = (payload['payload'] ?? {}) as Record<string, unknown>;
    const operationId = asString(eventPayload['operationId']);

    if (tenantId === null || operationId === null) {
      // Unretryable: the payload will not grow a recognisable shape on a fifth attempt. Logged and
      // dropped, as every consumer since Phase 7 treats a malformed job.
      this.logger.warn('Dropped a bulk lane job with an unrecognised shape', { jobId: job.jobId });
      return;
    }

    await runWithContext(baseContext(tenantId, job.jobId), async () => {
      await this.execute(tenantId, operationId, job.jobId);
    });
  }

  private async execute(tenantId: string, operationId: string, jobId: string): Promise<void> {
    const record = await this.unitOfWork.run(() => this.operations.findById(operationId));
    if (record === null) {
      // The tenant's own row is not there. Under ADR-0015 a tenant is a database, and this context
      // is that tenant's — so this is a purged operation rather than a cross-tenant read, and
      // there is nothing to run.
      this.logger.warn('A queued bulk operation no longer exists', { operationId });
      return;
    }
    if (record.state === BulkOperationState.COMPLETED) {
      // Already finished by an earlier delivery. The whole job is a no-op, which is the cheapest
      // and most common redelivery case.
      return;
    }

    const work = await this.unitOfWork.run(() => this.operations.payloadOf(operationId));
    if (work === null) {
      await this.fail(operationId, 'The operation carries no queued payload.');
      return;
    }

    const authority = await this.requesters.currentAuthority(work.requestedById);
    if (authority === null) {
      // The requester is gone or disabled. Failing is the safe direction: running under a subject
      // the product can no longer describe is exactly the privilege question this port exists to
      // answer honestly.
      await this.fail(operationId, 'The requester is no longer an active user.');
      return;
    }

    const settled = await this.unitOfWork.run(() => this.operations.settledTargets(operationId));
    if (settled.size > 0) {
      this.logger.info('Resuming a bulk operation that had already settled objects', {
        operationId,
        settled: settled.size,
        requested: work.targetIds.length,
      });
    }

    await runWithContext(
      requesterContext(tenantId, record.requestedById, authority, jobId),
      async () => {
        await this.unitOfWork.run(() => this.operations.start(operationId, this.executor.now()));
        try {
          const plan = this.plans.planFor(record.kind, work.payload);
          const { items } = await this.executor.process({
            operationId,
            plan,
            targetIds: work.targetIds,
            settled,
            onBatch: (tally) => this.publishProgress(operationId, settled.size, tally),
          });
          await this.executor.finalise(plan, operationId, items);
          await this.executor.complete(operationId, plan, record.requestedById);
        } catch (error) {
          // The *operation* did not finish — the lane died, a plan factory is missing, the
          // database went away. `FAILED` is reserved for exactly this, and it is what tells a
          // reader the per-object counts are incomplete rather than final.
          const reason = error instanceof Error ? error.message : 'unknown';
          this.logger.error('A bulk operation failed', { operationId, reason });
          await this.fail(operationId, reason);
          throw error;
        }
      },
    );
  }

  /**
   * The tally so far, written every batch.
   *
   * The counts are the objects settled by *earlier* deliveries plus the ones this pass has done,
   * so a resumed operation's progress does not appear to restart at zero.
   */
  private async publishProgress(
    operationId: string,
    alreadySettled: number,
    tally: BulkTally,
  ): Promise<void> {
    await this.unitOfWork.run(() =>
      this.operations.progress(operationId, {
        ...tally,
        requested: tally.requested + alreadySettled,
        applied: tally.applied + alreadySettled,
      }),
    );
  }

  private async fail(operationId: string, reason: string): Promise<void> {
    await this.unitOfWork.run(() =>
      this.operations.markFailed(operationId, reason, this.executor.now()),
    );
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Tenant only. Enough to read the operation row; not enough to act on anything. */
function baseContext(tenantId: string, correlationId: string): RequestContext {
  return {
    tenantId: asId<TenantId>(tenantId),
    userId: null,
    roles: [],
    permissions: [],
    sessionId: null,
    correlationId,
    permissionVersion: 0,
    locale: 'en',
  };
}

/**
 * The requester, as they stand now.
 *
 * Not a system context: a bulk operation is somebody's act, every object's reach is resolved
 * against them, and the audit rows the per-object use cases write name them. Running it as the
 * system would both over-authorise it and attribute four hundred document changes to nobody.
 */
function requesterContext(
  tenantId: string,
  userId: string,
  authority: {
    readonly roleIds: readonly string[];
    readonly permissions: readonly string[];
    readonly permissionVersion: number;
  },
  correlationId: string,
): RequestContext {
  return {
    ...baseContext(tenantId, correlationId),
    userId,
    // Role **identifiers**, because that is what the executor's ACL subject is built from:
    // `DefaultBulkExecutor.subject()` maps `context.roles` straight onto `roleIds`. Supplying keys
    // here would resolve every object to "no roles" and refuse the whole operation — which is
    // exactly what the integration suite caught on the first run of this consumer.
    roles: [...authority.roleIds],
    permissions: [...authority.permissions],
    permissionVersion: authority.permissionVersion,
  } as unknown as RequestContext;
}
