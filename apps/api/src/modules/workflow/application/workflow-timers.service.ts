import { Inject, Injectable } from '@nestjs/common';

import {
  type Duration,
  QueueName,
  type WorkflowInstanceId,
  type WorkflowStageId,
  WorkflowTimerKind,
  WorkflowTimerState,
  deadlineFor,
  parseDuration,
  queueDefinition,
  type WorkingCalendarView,
} from '@edms/domain';

import { LOGGER, type Logger } from '../../../core/observability/logger';
import { requireContext } from '../../../core/tenancy/tenant-context';
import { RecordStamps } from '../../../core/persistence/record-stamps';
import { QUEUE_PORT, type QueuePort } from '../../../ports/queue.port';
import {
  type NewTimer,
  WORKFLOW_ENGINE_REPOSITORY,
  type WorkflowEngineRepository,
  type WorkflowTimerRecord,
} from './ports';

/**
 * Deadlines, reminders and the pause that stops them.
 *
 * `07-workflow-architecture.md` §3 says timers are BullMQ delayed jobs "not polling", and §6 says a
 * paused instance resumes with the *remaining* duration rather than restarting the clock. Both are
 * satisfied by the same arrangement, and the arrangement is the reason `workflow_timer` is a table:
 * **the queue holds the job and the database holds what the job is for.**
 *
 * A queue alone cannot answer three questions the engine has to answer:
 *
 *  - *Which timers belong to this stage?* Cancelling a stage cancels its timers (§3), and BullMQ
 *    has no index from a stage to the jobs somebody scheduled for it.
 *  - *What did this timer have left?* Pausing means storing the remainder. A delayed job that is
 *    removed takes its remaining delay with it.
 *  - *Has this reminder already fired?* Delivery is at least once, so a job that arrives twice must
 *    do its work once — and "fired" is a fact about the timer, not about the delivery.
 *
 * The job identifier is derived from the timer row's identifier, which makes at-least-once delivery
 * harmless: two deliveries carry one job id, resolve to one row, and the second finds it already
 * `FIRED`.
 *
 * **Nothing here enqueues inside a transaction.** Scheduling writes the rows in the caller's
 * transaction and the enqueue happens after it commits, which is the whole of ADR-0011: a reminder
 * enqueued inside a transaction that then rolls back is a reminder for something that never
 * happened. The engine collects the schedule, commits, and hands it here.
 */
@Injectable()
export class WorkflowTimers {
  constructor(
    @Inject(WORKFLOW_ENGINE_REPOSITORY) private readonly repository: WorkflowEngineRepository,
    @Inject(QUEUE_PORT) private readonly queue: QueuePort,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly stamps: RecordStamps,
  ) {}

  /**
   * The rows a stage's deadline and reminders need, computed but not enqueued.
   *
   * Returned rather than scheduled, because this runs inside the transaction that activates the
   * stage and the enqueue must not. The caller writes the rows here and calls `enqueue` afterwards.
   */
  plan(input: {
    readonly instanceId: string;
    readonly stageId: string;
    readonly taskIds: readonly string[];
    readonly deadline: { readonly duration: string; readonly calendar: string } | null;
    readonly reminders: readonly { readonly before: string }[];
    readonly from: Date;
    readonly calendar: WorkingCalendarView;
  }): { readonly dueAt: Date | null; readonly timers: readonly NewTimer[] } {
    if (input.deadline === null) {
      // A stage with no deadline has no reminders either — the version validator refuses a reminder
      // without one, because a reminder is an offset measured *from* a deadline.
      return { dueAt: null, timers: [] };
    }

    const duration = parseDuration(input.deadline.duration);
    if (duration === null) {
      // The wire schema and the publish validator both refuse an unparseable duration, so this is a
      // stored version written by something else. The stage runs without a deadline rather than
      // failing the submission: an approval that cannot start is worse than one nobody is chased on.
      this.logger.warn('A stage deadline could not be parsed; the stage runs without one', {
        stageId: input.stageId,
        duration: input.deadline.duration,
      });
      return { dueAt: null, timers: [] };
    }

    const dueAt = deadlineFor(
      input.from,
      duration,
      input.deadline.calendar as never,
      input.calendar,
    );

    const timers: NewTimer[] = [
      this.timer(input.instanceId, input.stageId, null, WorkflowTimerKind.DEADLINE, dueAt, null),
    ];

    for (const reminder of input.reminders) {
      const before = parseDuration(reminder.before);
      if (before === null) {
        continue;
      }
      const fireAt = this.remindAt(dueAt, before, input.from);
      if (fireAt === null) {
        // An offset longer than the deadline itself would fire before the stage began. Skipped
        // rather than clamped to "now": a reminder that arrives in the same second as the task is
        // noise, and the definition's author meant a warning, not a duplicate notification.
        continue;
      }
      for (const taskId of input.taskIds) {
        timers.push(
          this.timer(
            input.instanceId,
            input.stageId,
            taskId,
            WorkflowTimerKind.REMINDER,
            fireAt,
            reminder.before,
          ),
        );
      }
    }

    return { dueAt, timers };
  }

  /**
   * Hands the planned timers to the queue. Called **after** the transaction commits.
   *
   * A failure to enqueue is logged and swallowed rather than propagated, and that is a considered
   * trade rather than laziness. The approval has already committed; throwing here would report a
   * failure for something that succeeded, and the caller would have no way to undo it. The rows are
   * durable, which is what makes this recoverable: a timer whose job never reached Redis is a row
   * in `SCHEDULED` with a `fire_at` in the past, and it is visible to anybody looking.
   */
  async enqueue(timers: readonly NewTimer[]): Promise<void> {
    for (const timer of timers) {
      try {
        const { tenantId, correlationId } = requireContext();
        await this.queue.enqueue(
          QueueName.WORKFLOW_TIMERS,
          // The tenant travels with the job because a job has no request behind it, and
          // `UnitOfWork` needs one to decide which database to open ([ADR-0015]). The correlation
          // identifier travels for the opposite reason: a deadline that fires three days later
          // still has to tie back to the submission that set it.
          { timerId: timer.id, jobId: timer.jobId, tenantId, correlationId },
          {
            jobId: timer.jobId,
            delayMs: Math.max(0, timer.fireAt.getTime() - this.stamps.now().getTime()),
            attempts: queueDefinition(QueueName.WORKFLOW_TIMERS).retry.attempts,
          },
        );
      } catch (error) {
        this.logger.error('A workflow timer could not be enqueued; its row is still scheduled', {
          timerId: timer.id,
          reason: error instanceof Error ? error.message : 'unknown',
        });
      }
    }
  }

  /** Cancels a stage's timers, in the database and in the queue. */
  async cancelStage(stageId: WorkflowStageId): Promise<void> {
    await this.dropJobs(await this.repository.cancelTimersForStage(stageId));
  }

  async cancelInstance(instanceId: WorkflowInstanceId): Promise<void> {
    await this.dropJobs(await this.repository.cancelTimersForInstance(instanceId));
  }

  /**
   * Stops an instance's timers and records what each had left.
   *
   * The remainder is `fire_at - now`, floored at zero: a timer that was already overdue when the
   * pause landed resumes immediately, which is the honest answer — the deadline passed, and the
   * hold did not un-pass it.
   */
  async pause(instanceId: WorkflowInstanceId): Promise<void> {
    await this.dropJobs(await this.repository.pauseTimers(instanceId, this.stamps.now()));
  }

  /**
   * Restarts an instance's timers from the durations they were holding.
   *
   * `fire_at` is recomputed as `now + remaining`, never re-derived from the original duration. That
   * is the whole of §6's rule: an approval held for a week does not get its three days back, it
   * gets back exactly what was left of them.
   */
  async resume(instanceId: WorkflowInstanceId): Promise<void> {
    const resumed = await this.repository.resumeTimers(instanceId, this.stamps.now());
    await this.enqueue(
      resumed.map((timer) => ({
        id: timer.id,
        instanceId: timer.instanceId,
        stageId: timer.stageId,
        taskId: timer.taskId,
        kind: timer.kind,
        fireAt: timer.fireAt,
        offset: timer.offset,
        jobId: timer.jobId,
      })),
    );
  }

  /**
   * Removes a job that will never be wanted.
   *
   * Best effort, for the same reason `enqueue` is: the rows are already `CANCELLED`, so a job that
   * survives in Redis fires against a timer the engine will find is not scheduled and will ignore.
   * A failure to tidy up is not a reason to fail an approval decision that has already committed.
   */
  private async dropJobs(timers: readonly WorkflowTimerRecord[]): Promise<void> {
    for (const timer of timers) {
      if (timer.state === WorkflowTimerState.FIRED) {
        continue;
      }
      try {
        await this.queue.cancel(QueueName.WORKFLOW_TIMERS, timer.jobId);
      } catch (error) {
        this.logger.warn('A cancelled workflow timer could not be removed from the queue', {
          timerId: timer.id,
          reason: error instanceof Error ? error.message : 'unknown',
        });
      }
    }
  }

  private timer(
    instanceId: string,
    stageId: string,
    taskId: string | null,
    kind: (typeof WorkflowTimerKind)[keyof typeof WorkflowTimerKind],
    fireAt: Date,
    offset: string | null,
  ): NewTimer {
    const id = this.stamps.nextId();
    // Derived from the row's identifier, so a job identifier can never address two timers and a
    // duplicate delivery is one unit of work rather than two.
    return { id, instanceId, stageId, taskId, kind, fireAt, offset, jobId: `wf-timer:${id}` };
  }

  /**
   * When a reminder fires: the deadline, less the offset.
   *
   * Counted back in plain time rather than against the working calendar. A reminder is "warn me a
   * day before", and a person reading that means twenty-four hours, not "the previous working day"
   * — and counting it against the calendar would put a Monday deadline's warning on the Friday,
   * which is three days of notice for a one-day offset.
   */
  private remindAt(dueAt: Date, before: Duration, from: Date): Date | null {
    const fireAt = new Date(
      dueAt.getTime() - (before.days * 86_400_000 + before.hours * 3_600_000),
    );
    return fireAt.getTime() <= from.getTime() ? null : fireAt;
  }
}
