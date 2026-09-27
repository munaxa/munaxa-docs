import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';

import { type TenantId, asId } from '@edms/domain';

import { UNIT_OF_WORK, type UnitOfWork } from '../../../core/prisma/unit-of-work';
import { QueueRecoveryRegistry } from '../../../core/queue-recovery/queue-recovery.registry';
import { TENANT_REGISTRY, type TenantRegistry } from '../../../core/tenancy/tenant-registry.port';
import { runWithContext } from '../../../core/tenancy/tenant-context';
import type { QueueRecoveryParticipant } from '../../../ports/queue.port';
import { WORKFLOW_ENGINE_REPOSITORY, type WorkflowEngineRepository } from '../application/ports';
import { WorkflowTimers } from '../application/workflow-timers.service';

/** Rows re-armed per read: bounded, so one tenant's backlog is never one query held open. */
const PAGE = 500;

/**
 * Re-arms the workflow timers a lost Redis took with it — RC validation, D-13.
 *
 * The row is the timer; the delayed job is only how it gets delivered. So after a flush or a
 * failover to an empty replica, every row that is still owed a firing — `SCHEDULED`, on a running
 * instance, in an active stage — is put back on the queue under its own `job_id`, through the same
 * `WorkflowTimers` path that armed it in the first place. A timer whose `fire_at` passed while it
 * was lost is due now and fires straight away; one still in the future waits out what is left.
 *
 * Nothing here decides whether a timer fires. `onTimerFired` claims the row `SCHEDULED → FIRED`
 * under the instance lock and re-checks the instance and the stage, so a timer re-armed twice —
 * by two processes recovering at once, or over a job the broker still had — fires once and the
 * other delivery is the ordinary no-op a duplicate has always been.
 */
@Injectable()
export class WorkflowTimerRecovery implements QueueRecoveryParticipant, OnModuleInit {
  readonly name = 'workflow.timers';

  constructor(
    private readonly registry: QueueRecoveryRegistry,
    @Inject(TENANT_REGISTRY) private readonly tenants: TenantRegistry,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(WORKFLOW_ENGINE_REPOSITORY) private readonly repository: WorkflowEngineRepository,
    private readonly timers: WorkflowTimers,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async recover(): Promise<number> {
    let rearmed = 0;
    for (const placement of await this.tenants.all()) {
      rearmed += await this.recoverTenant(asId<TenantId>(placement.id));
    }
    return rearmed;
  }

  /** One tenant, a page at a time. Exposed so a suite can recover the tenant it created. */
  recoverTenant(tenantId: TenantId): Promise<number> {
    return runWithContext(
      {
        tenantId,
        // The system acted alone, as it does when the timer itself fires.
        userId: null,
        roles: [],
        permissions: [],
        sessionId: null,
        correlationId: `queue-recovery:${tenantId}`,
        permissionVersion: 0,
        locale: 'en',
      },
      async () => {
        let rearmed = 0;
        let after: string | null = null;
        for (;;) {
          const page = await this.unitOfWork.run(() =>
            this.repository.listArmableTimers(after, PAGE),
          );
          if (page.length === 0) {
            return rearmed;
          }
          rearmed += await this.timers.rearm(page);
          after = page[page.length - 1]?.id ?? null;
          if (page.length < PAGE) {
            return rearmed;
          }
        }
      },
    );
  }
}
