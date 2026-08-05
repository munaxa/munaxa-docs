import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import {
  ApprovalTaskState,
  type ApprovalTaskId,
  type ApprovalTaskStateKey,
  type DocumentId,
  type StageCompletionRuleKey,
  type StageSkipReasonKey,
  type TaskDecisionKey,
  type UserId,
  WorkflowInstanceStatus,
  type WorkflowInstanceId,
  type WorkflowInstanceStatusKey,
  type WorkflowPauseReasonKey,
  WorkflowStageStatus,
  type WorkflowStageId,
  type WorkflowTimerKindKey,
  WorkflowTimerState,
  type WorkflowTimerStateKey,
  type WorkflowVersionId,
  asId,
} from '@edms/domain';

import { RecordStamps } from '../../../core/persistence';
import { requireTransaction } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';
import type {
  ApprovalTaskRecord,
  NewInstance,
  NewStage,
  NewTask,
  NewTimer,
  WorkflowAggregate,
  WorkflowEngineRepository,
  WorkflowInstanceRecord,
  WorkflowStageRecord,
  WorkflowTimerRecord,
} from '../application/ports';

/**
 * The engine's writes.
 *
 * Two statements in this file carry the engine's correctness, and neither is a Prisma convenience.
 *
 * **`decideIfPending` is a conditional update, not a read followed by a write.** The `WHERE` names
 * `decision: null` and `state: PENDING`, and a count of zero is returned to the caller as "somebody
 * decided first". A read-then-write leaves a window however short the transaction is, and two
 * decisions on one task make a quorum count report something that never happened — which §8 lists
 * as one of the things the engine must never do. The integration suite decides one task from two
 * transactions concurrently and asserts exactly one of them wins.
 *
 * **`resumeTimers` recomputes `fire_at` from `remaining_ms`, never from the original duration.**
 * That is the whole of §6: an approval held for a week gets back what was left of its three days,
 * not three fresh ones. The pairing that makes it hard to get wrong is a check constraint — a timer
 * cannot be `PAUSED` without a remainder, and cannot carry one in any other state.
 *
 * Everything is filtered by tenant explicitly even though each tenant has its own database under
 * ADR-0015. The filter costs nothing on an indexed column and it is what keeps a single-database
 * on-premise installation with two tenants honest — the same reasoning that keeps row-level
 * security in place inside every tenant database.
 */
@Injectable()
export class PrismaWorkflowEngineRepository implements WorkflowEngineRepository {
  constructor(private readonly stamps: RecordStamps) {}

  // --- Loading ------------------------------------------------------------------------------

  /**
   * `SELECT … FOR UPDATE` on the instance row.
   *
   * Raw SQL because Prisma has no expression for a row lock, and there is no substitute for one
   * here: the completion rule is arithmetic over rows two transactions are writing at once, and
   * under `READ COMMITTED` each would count only its own. The lock is what turns "two approvals
   * arrived at the same instant" into "the second one waits, re-reads, and completes the stage".
   *
   * Taken before anything else on every write path, so the acquisition order is the same everywhere
   * and two decisions on one approval cannot deadlock against each other.
   */
  async lockInstance(id: WorkflowInstanceId): Promise<boolean> {
    const rows = await requireTransaction().$queryRaw<{ id: string }[]>`
      SELECT id FROM workflow_instance
      WHERE id = ${id}::uuid AND tenant_id = ${this.tenantId()}::uuid
      FOR UPDATE`;
    return rows.length > 0;
  }

  async instanceIdOfTask(taskId: ApprovalTaskId): Promise<WorkflowInstanceId | null> {
    const task = await requireTransaction().approvalTask.findFirst({
      where: { id: taskId, tenantId: this.tenantId() },
      select: { instanceId: true },
    });
    return task === null ? null : asId<WorkflowInstanceId>(task.instanceId);
  }

  async load(id: WorkflowInstanceId): Promise<WorkflowAggregate | null> {
    const row = await requireTransaction().workflowInstance.findFirst({
      where: { id, tenantId: this.tenantId() },
      include: AGGREGATE,
    });
    return row === null ? null : toAggregate(row);
  }

  async loadByTask(taskId: ApprovalTaskId): Promise<WorkflowAggregate | null> {
    const task = await requireTransaction().approvalTask.findFirst({
      where: { id: taskId, tenantId: this.tenantId() },
      select: { instanceId: true },
    });
    return task === null ? null : this.load(asId<WorkflowInstanceId>(task.instanceId));
  }

  async loadLiveForDocument(documentId: DocumentId): Promise<WorkflowAggregate | null> {
    const row = await requireTransaction().workflowInstance.findFirst({
      where: {
        documentId,
        tenantId: this.tenantId(),
        // The same pair the partial unique index is built on, so this read and that constraint can
        // never disagree about what "live" means.
        state: { in: [WorkflowInstanceStatus.RUNNING, WorkflowInstanceStatus.PAUSED] },
      },
      include: AGGREGATE,
    });
    return row === null ? null : toAggregate(row);
  }

  // --- Creating -----------------------------------------------------------------------------

  async createInstance(instance: NewInstance): Promise<void> {
    await requireTransaction().workflowInstance.create({
      data: {
        id: instance.id,
        tenantId: this.tenantId(),
        documentId: instance.documentId,
        revisionId: instance.revisionId,
        definitionId: instance.definitionId,
        workflowVersionId: instance.workflowVersionId,
        startedAt: instance.startedAt,
        startedBy: this.actorId(),
        ...this.stamps.creation(),
      },
    });
  }

  async createStages(stages: readonly NewStage[]): Promise<void> {
    if (stages.length === 0) {
      return;
    }
    const at = this.stamps.now();
    await requireTransaction().workflowStage.createMany({
      data: stages.map((stage) => ({
        id: stage.id,
        tenantId: this.tenantId(),
        instanceId: stage.instanceId,
        index: stage.index,
        name: stage.name,
        completionRule: stage.completionRule,
        threshold: stage.threshold,
        ordered: stage.ordered,
        createdAt: at,
        updatedAt: at,
      })),
    });
  }

  async createTasks(tasks: readonly NewTask[]): Promise<void> {
    if (tasks.length === 0) {
      return;
    }
    const at = this.stamps.now();
    await requireTransaction().approvalTask.createMany({
      data: tasks.map((task) => ({
        id: task.id,
        tenantId: this.tenantId(),
        instanceId: task.instanceId,
        stageId: task.stageId,
        assigneeId: task.assigneeId,
        resolvedBy: task.resolvedBy,
        sequence: task.sequence,
        dueAt: task.dueAt,
        escalatedFromId: task.escalatedFromId,
        createdAt: at,
        updatedAt: at,
      })),
    });
  }

  // --- Stages -------------------------------------------------------------------------------

  async activateStage(stageId: WorkflowStageId, at: Date, dueAt: Date | null): Promise<void> {
    await requireTransaction().workflowStage.updateMany({
      where: { id: stageId, tenantId: this.tenantId() },
      data: { state: WorkflowStageStatus.ACTIVE, activatedAt: at, dueAt, updatedAt: at },
    });
  }

  async completeStage(stageId: WorkflowStageId, at: Date): Promise<void> {
    await requireTransaction().workflowStage.updateMany({
      where: { id: stageId, tenantId: this.tenantId() },
      data: { state: WorkflowStageStatus.COMPLETED, completedAt: at, updatedAt: at },
    });
  }

  async skipStage(stageId: WorkflowStageId, reason: StageSkipReasonKey, at: Date): Promise<void> {
    await requireTransaction().workflowStage.updateMany({
      where: { id: stageId, tenantId: this.tenantId() },
      data: {
        state: WorkflowStageStatus.SKIPPED,
        skipReason: reason,
        completedAt: at,
        updatedAt: at,
      },
    });
  }

  /**
   * Ends the stages an abandoned instance never reached.
   *
   * `CANCELLED` rather than `SKIPPED`: a skipped stage is one whose condition scoped it away, which
   * is a statement about the document, and a cancelled one is a stage that would have run. A report
   * asking "which controls did not apply to this document" must not be handed both.
   */
  async cancelRemainingStages(instanceId: WorkflowInstanceId, fromIndex: number): Promise<void> {
    await requireTransaction().workflowStage.updateMany({
      where: {
        instanceId,
        tenantId: this.tenantId(),
        index: { gte: fromIndex },
        state: { in: [WorkflowStageStatus.PENDING, WorkflowStageStatus.ACTIVE] },
      },
      data: { state: WorkflowStageStatus.CANCELLED, updatedAt: this.stamps.now() },
    });
  }

  // --- Tasks --------------------------------------------------------------------------------

  async decideIfPending(input: {
    readonly taskId: ApprovalTaskId;
    readonly decision: TaskDecisionKey;
    readonly decidedById: string;
    readonly onBehalfOfId: string | null;
    readonly delegationId: string | null;
    readonly comment: string | null;
    readonly at: Date;
    readonly autoDecided: boolean;
  }): Promise<boolean> {
    const { count } = await requireTransaction().approvalTask.updateMany({
      where: {
        id: input.taskId,
        tenantId: this.tenantId(),
        // The claim. Both clauses are load-bearing: `decision: null` stops a second decision, and
        // `state: PENDING` stops one on a task that a completed stage already superseded.
        decision: null,
        state: ApprovalTaskState.PENDING,
      },
      data: {
        state: ApprovalTaskState.DECIDED,
        decision: input.decision,
        decidedById: input.decidedById,
        onBehalfOfId: input.onBehalfOfId,
        delegationId: input.delegationId,
        decidedAt: input.at,
        comment: input.comment,
        autoDecided: input.autoDecided,
        updatedAt: input.at,
        version: { increment: 1 },
      },
    });
    return count > 0;
  }

  async closePendingTasks(stageId: WorkflowStageId, state: ApprovalTaskStateKey): Promise<number> {
    const { count } = await requireTransaction().approvalTask.updateMany({
      where: {
        stageId,
        tenantId: this.tenantId(),
        // Never a decided one. A decision is evidence, and a stage ending does not un-take it.
        state: ApprovalTaskState.PENDING,
        decision: null,
      },
      data: { state, updatedAt: this.stamps.now(), version: { increment: 1 } },
    });
    return count;
  }

  // --- The instance -------------------------------------------------------------------------

  async endInstance(input: {
    readonly instanceId: WorkflowInstanceId;
    readonly status: WorkflowInstanceStatusKey;
    readonly reason: string | null;
    readonly at: Date;
    readonly numberAssigned: boolean;
  }): Promise<void> {
    await requireTransaction().workflowInstance.updateMany({
      where: {
        id: input.instanceId,
        tenantId: this.tenantId(),
        state: { in: [WorkflowInstanceStatus.RUNNING, WorkflowInstanceStatus.PAUSED] },
      },
      data: {
        state: input.status,
        endReason: input.reason,
        endedAt: input.at,
        // Cleared with the end, because the check constraint pairs `PAUSED` with a paused instant
        // and an ended instance is not paused.
        pausedAt: null,
        pauseReason: null,
        numberAssigned: input.numberAssigned,
        currentStageIndex: -1,
        ...this.stamps.update(),
        version: { increment: 1 },
      },
    });
  }

  async moveToStage(instanceId: WorkflowInstanceId, index: number): Promise<void> {
    await requireTransaction().workflowInstance.updateMany({
      where: { id: instanceId, tenantId: this.tenantId() },
      data: { currentStageIndex: index, ...this.stamps.update(), version: { increment: 1 } },
    });
  }

  async setPaused(input: {
    readonly instanceId: WorkflowInstanceId;
    readonly paused: boolean;
    readonly reason: WorkflowPauseReasonKey | null;
    readonly at: Date;
  }): Promise<void> {
    await requireTransaction().workflowInstance.updateMany({
      where: { id: input.instanceId, tenantId: this.tenantId() },
      data: {
        state: input.paused ? WorkflowInstanceStatus.PAUSED : WorkflowInstanceStatus.RUNNING,
        pausedAt: input.paused ? input.at : null,
        pauseReason: input.paused ? input.reason : null,
        ...this.stamps.update(),
        version: { increment: 1 },
      },
    });
  }

  /**
   * Counts one escalation against the instance's cap, and returns the new total.
   *
   * An increment rather than a read-then-write, so two deadline jobs firing at once against two
   * stages of one instance cannot both read the same count and both write the same successor —
   * which is how an escalation cap silently becomes twice what a definition asked for.
   */
  async recordEscalation(instanceId: WorkflowInstanceId): Promise<number> {
    const row = await requireTransaction().workflowInstance.update({
      where: { id: instanceId },
      data: { escalationCount: { increment: 1 }, ...this.stamps.update() },
      select: { escalationCount: true },
    });
    return row.escalationCount;
  }

  async addComment(input: {
    readonly id: string;
    readonly instanceId: string;
    readonly documentId: string;
    readonly stageId: string | null;
    readonly taskId: string | null;
    readonly authorId: string;
    readonly body: string;
    readonly decision: TaskDecisionKey | null;
    readonly at: Date;
  }): Promise<void> {
    await requireTransaction().workflowComment.create({
      data: {
        id: input.id,
        tenantId: this.tenantId(),
        instanceId: input.instanceId,
        documentId: input.documentId,
        stageId: input.stageId,
        taskId: input.taskId,
        authorId: input.authorId,
        body: input.body,
        decision: input.decision,
        createdAt: input.at,
      },
    });
  }

  // --- Timers -------------------------------------------------------------------------------

  async createTimers(timers: readonly NewTimer[]): Promise<void> {
    if (timers.length === 0) {
      return;
    }
    const at = this.stamps.now();
    await requireTransaction().workflowTimer.createMany({
      data: timers.map((timer) => ({
        id: timer.id,
        tenantId: this.tenantId(),
        instanceId: timer.instanceId,
        stageId: timer.stageId,
        taskId: timer.taskId,
        kind: timer.kind,
        fireAt: timer.fireAt,
        offset: timer.offset,
        jobId: timer.jobId,
        createdAt: at,
        updatedAt: at,
      })),
    });
  }

  async timersFor(
    instanceId: WorkflowInstanceId,
    states: readonly WorkflowTimerStateKey[],
  ): Promise<readonly WorkflowTimerRecord[]> {
    const rows = await requireTransaction().workflowTimer.findMany({
      where: {
        instanceId,
        tenantId: this.tenantId(),
        state: { in: states as Prisma.WorkflowTimerWhereInput['state'][] as never },
      },
    });
    return rows.map(toTimer);
  }

  async findTimerByJobId(jobId: string): Promise<WorkflowTimerRecord | null> {
    const row = await requireTransaction().workflowTimer.findFirst({
      where: { jobId, tenantId: this.tenantId() },
    });
    return row === null ? null : toTimer(row);
  }

  /**
   * Claims a timer.
   *
   * Conditional on `SCHEDULED`, which makes the whole firing path idempotent: a duplicate delivery,
   * a job that outlived the stage it belonged to, and one that arrives while the instance is paused
   * all find a row that is not schedulable and do nothing. Delivery is at least once, so this is
   * the only place that can make the work happen exactly once.
   */
  async markTimerFired(id: string, at: Date): Promise<boolean> {
    const { count } = await requireTransaction().workflowTimer.updateMany({
      where: { id, tenantId: this.tenantId(), state: WorkflowTimerState.SCHEDULED },
      data: { state: WorkflowTimerState.FIRED, firedAt: at, updatedAt: at },
    });
    return count > 0;
  }

  cancelTimersForStage(stageId: WorkflowStageId): Promise<readonly WorkflowTimerRecord[]> {
    return this.cancelTimers({ stageId, tenantId: this.tenantId() });
  }

  cancelTimersForInstance(instanceId: WorkflowInstanceId): Promise<readonly WorkflowTimerRecord[]> {
    return this.cancelTimers({ instanceId, tenantId: this.tenantId() });
  }

  /**
   * Stops an instance's timers, recording what each had left.
   *
   * The remainder is floored at zero: a timer already overdue when the hold landed resumes
   * immediately, which is the honest answer — the deadline passed, and the hold did not un-pass it.
   */
  async pauseTimers(
    instanceId: WorkflowInstanceId,
    now: Date,
  ): Promise<readonly WorkflowTimerRecord[]> {
    const tx = requireTransaction();
    const live = await tx.workflowTimer.findMany({
      where: { instanceId, tenantId: this.tenantId(), state: WorkflowTimerState.SCHEDULED },
    });
    for (const timer of live) {
      await tx.workflowTimer.update({
        where: { id: timer.id },
        data: {
          state: WorkflowTimerState.PAUSED,
          remainingMs: Math.max(0, timer.fireAt.getTime() - now.getTime()),
          updatedAt: now,
        },
      });
    }
    return live.map(toTimer);
  }

  /**
   * Starts them again from the durations they were holding.
   *
   * `fire_at = now + remaining_ms`. Never re-derived from the definition's duration, which is the
   * one implementation of "resume" that would look right and be wrong: a stage held for a week
   * would come back with its full three days rather than with the two it had left.
   */
  async resumeTimers(
    instanceId: WorkflowInstanceId,
    now: Date,
  ): Promise<readonly WorkflowTimerRecord[]> {
    const tx = requireTransaction();
    const held = await tx.workflowTimer.findMany({
      where: { instanceId, tenantId: this.tenantId(), state: WorkflowTimerState.PAUSED },
    });
    const resumed: WorkflowTimerRecord[] = [];
    for (const timer of held) {
      const fireAt = new Date(now.getTime() + (timer.remainingMs ?? 0));
      await tx.workflowTimer.update({
        where: { id: timer.id },
        data: {
          state: WorkflowTimerState.SCHEDULED,
          fireAt,
          remainingMs: null,
          updatedAt: now,
        },
      });
      resumed.push({
        ...toTimer(timer),
        state: WorkflowTimerState.SCHEDULED,
        fireAt,
        remainingMs: null,
      });
    }
    return resumed;
  }

  private async cancelTimers(
    where: Prisma.WorkflowTimerWhereInput,
  ): Promise<readonly WorkflowTimerRecord[]> {
    const tx = requireTransaction();
    const live = await tx.workflowTimer.findMany({
      where: {
        ...where,
        state: { in: [WorkflowTimerState.SCHEDULED, WorkflowTimerState.PAUSED] },
      },
    });
    if (live.length === 0) {
      return [];
    }
    await tx.workflowTimer.updateMany({
      where: { id: { in: live.map((timer) => timer.id) } },
      data: {
        state: WorkflowTimerState.CANCELLED,
        remainingMs: null,
        updatedAt: this.stamps.now(),
      },
    });
    return live.map(toTimer);
  }

  private tenantId(): string {
    return requireContext().tenantId;
  }

  private actorId(): string | null {
    return requireContext().userId;
  }
}

const AGGREGATE = {
  stages: { orderBy: { index: 'asc' } },
  tasks: { orderBy: [{ sequence: 'asc' }, { createdAt: 'asc' }] },
} as const satisfies Prisma.WorkflowInstanceInclude;

type InstanceWithChildren = Prisma.WorkflowInstanceGetPayload<{ include: typeof AGGREGATE }>;

function toAggregate(row: InstanceWithChildren): WorkflowAggregate {
  return {
    instance: toInstance(row),
    stages: row.stages.map(toStage),
    tasks: row.tasks.map(toTask),
  };
}

function toInstance(row: InstanceWithChildren): WorkflowInstanceRecord {
  return {
    id: asId(row.id),
    documentId: asId(row.documentId),
    revisionId: asId(row.revisionId),
    definitionId: asId(row.definitionId),
    workflowVersionId: asId<WorkflowVersionId>(row.workflowVersionId),
    status: row.state,
    currentStageIndex: row.currentStageIndex,
    startedAt: row.startedAt,
    startedBy: row.startedBy,
    endedAt: row.endedAt,
    endReason: row.endReason,
    pausedAt: row.pausedAt,
    pauseReason: row.pauseReason,
    escalationCount: row.escalationCount,
    numberAssigned: row.numberAssigned,
    version: row.version,
  };
}

function toStage(row: InstanceWithChildren['stages'][number]): WorkflowStageRecord {
  return {
    id: asId(row.id),
    instanceId: asId(row.instanceId),
    index: row.index,
    name: row.name,
    completionRule: row.completionRule as StageCompletionRuleKey,
    threshold: row.threshold,
    ordered: row.ordered,
    status: row.state,
    activatedAt: row.activatedAt,
    completedAt: row.completedAt,
    dueAt: row.dueAt,
    skipReason: row.skipReason as StageSkipReasonKey | null,
  };
}

function toTask(row: InstanceWithChildren['tasks'][number]): ApprovalTaskRecord {
  return {
    id: asId(row.id),
    instanceId: asId(row.instanceId),
    stageId: asId(row.stageId),
    assigneeId: asId<UserId>(row.assigneeId),
    resolvedBy: row.resolvedBy,
    sequence: row.sequence,
    state: row.state,
    decision: row.decision,
    decidedById: row.decidedById === null ? null : asId<UserId>(row.decidedById),
    onBehalfOfId: row.onBehalfOfId === null ? null : asId<UserId>(row.onBehalfOfId),
    delegationId: row.delegationId,
    decidedAt: row.decidedAt,
    comment: row.comment,
    dueAt: row.dueAt,
    escalatedFromId:
      row.escalatedFromId === null ? null : asId<ApprovalTaskId>(row.escalatedFromId),
    autoDecided: row.autoDecided,
    createdAt: row.createdAt,
  };
}

function toTimer(row: {
  id: string;
  instanceId: string;
  stageId: string;
  taskId: string | null;
  kind: string;
  state: string;
  fireAt: Date;
  remainingMs: number | null;
  offset: string | null;
  jobId: string;
}): WorkflowTimerRecord {
  return {
    id: row.id,
    instanceId: asId(row.instanceId),
    stageId: asId(row.stageId),
    taskId: row.taskId === null ? null : asId<ApprovalTaskId>(row.taskId),
    kind: row.kind as WorkflowTimerKindKey,
    state: row.state as WorkflowTimerStateKey,
    fireAt: row.fireAt,
    remainingMs: row.remainingMs,
    offset: row.offset,
    jobId: row.jobId,
  };
}
