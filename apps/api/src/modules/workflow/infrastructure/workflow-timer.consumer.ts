import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';

import { QueueName, asId, type TenantId } from '@edms/domain';

import { APP_CONFIG, type AppConfig } from '../../../core/config';
import { LOGGER, type Logger } from '../../../core/observability/logger';
import { runWithContext } from '../../../core/tenancy/tenant-context';
import { QUEUE_CONSUMER, type QueueConsumer } from '../../../ports/queue.port';
import { WorkflowEngine } from '../application/workflow-engine.service';

/**
 * The half of the engine that runs without anybody clicking anything.
 *
 * A deadline that passes and a reminder that comes due are jobs, not polls — `07-workflow-architecture.md`
 * §3 is explicit that timers are BullMQ delayed jobs — and this is what receives them. It is a thin
 * wrapper around one use case, which is what every job handler in this architecture is: the same
 * `WorkflowEngine.onTimerFired` a test calls directly, so "what a passed deadline does" means one
 * thing whether a person, a test or a queue triggered it.
 *
 * ### Two things this has to do that a request does not
 *
 * **It establishes its own context.** A job arrives with no request behind it, so there is no
 * tenant, no correlation identifier and no actor in scope — and `UnitOfWork.run` needs a tenant to
 * decide which database to open ([ADR-0015]). The payload carries the tenant, and the engine's
 * writes are attributed to nobody: `userId` is null, which is a real answer rather than a gap. The
 * system acted alone, and the audit trail says so.
 *
 * **It is idempotent on the timer row rather than on the delivery.** Delivery is at least once and a
 * retry after a timeout is normal, so the handler claims the row — `SCHEDULED → FIRED`, conditional
 * — before it does anything. A duplicate delivery, a job that outlived the stage it belonged to, and
 * one that arrives while the instance is paused all find a row that is not claimable and do nothing.
 *
 * ### Where this runs
 *
 * In the API process, and the honest position on that is in the phase report. `apps/worker` is the
 * intended home and is still a skeleton; a consumer is a wrapper around a use case, and moving it is
 * a deployment change rather than a code one — the module that owns the use case is where it is
 * registered either way.
 */
@Injectable()
export class WorkflowTimerConsumer implements OnApplicationBootstrap {
  constructor(
    @Inject(QUEUE_CONSUMER) private readonly queue: QueueConsumer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly engine: WorkflowEngine,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.queue.consumersEnabled) {
      // A process that only serves requests — a second API instance behind a load balancer, or a
      // deployment that runs its consumers separately. Stated in configuration rather than inferred,
      // because "nobody is consuming this lane" must never be something a deployment discovers.
      this.logger.info('Workflow timers are not consumed by this process', {
        queue: QueueName.WORKFLOW_TIMERS,
      });
      return;
    }

    await this.queue.subscribe<TimerJob>(QueueName.WORKFLOW_TIMERS, async (job) => {
      const payload = job.payload;
      if (typeof payload.tenantId !== 'string' || typeof payload.jobId !== 'string') {
        // A malformed payload is not retryable — five more attempts reach the same conclusion — so
        // it is logged and dropped rather than thrown, which would send it round the backoff loop.
        this.logger.error('A workflow timer job carried an unusable payload', { jobId: job.jobId });
        return;
      }
      await runWithContext(
        {
          tenantId: asId<TenantId>(payload.tenantId),
          // The system acted alone. Every actor column in this product is nullable for exactly this
          // case, and the audit event that results names no person because none was involved.
          userId: null,
          roles: [],
          permissions: [],
          sessionId: null,
          // Carried from the request that scheduled the timer, so a deadline fired days later still
          // ties back to the submission that set it — across the API, the queue and the logs.
          correlationId: payload.correlationId ?? job.jobId,
          permissionVersion: 0,
          locale: 'en',
        },
        () => this.engine.onTimerFired(payload.jobId),
      );
    });
  }
}

interface TimerJob {
  readonly timerId: string;
  readonly jobId: string;
  readonly tenantId: string;
  readonly correlationId?: string;
}
