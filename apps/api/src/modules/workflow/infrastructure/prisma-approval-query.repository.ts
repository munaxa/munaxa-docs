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
  type WorkflowInstanceId,
  asId,
} from '@edms/domain';
import { type Page, toPage } from '@edms/utils';

import { RecordStamps, orderByFor, pageArgs } from '../../../core/persistence';
import { requireTransaction } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';
import type {
  ApprovalInboxRequest,
  ApprovalInboxRow,
  ApprovalQueryRepository,
  ApprovalTaskRecord,
  WorkflowCommentRow,
  WorkflowInstanceView,
  WorkflowStageRecord,
} from '../application/ports';

/**
 * The approval screens' reads.
 *
 * Separate from the engine's repository and read-only. The engine loads an instance with every
 * stage and every task because it is about to change all three; a dashboard rendering forty inbox
 * rows would be loading forty aggregates to draw forty lines
 * (`02-backend-architecture.md` §5).
 *
 * The inbox is the busiest read in the module and is served by the partial index on undecided
 * tasks, so the index holds work in flight rather than every decision ever taken. Its joins are the
 * ones a row actually renders — the stage it belongs to, the document it is about, and the two
 * names — and they are one query rather than a lookup per row, which is the shape that makes a
 * document system feel fast at the scale customers reach.
 */
@Injectable()
export class PrismaApprovalQueryRepository implements ApprovalQueryRepository {
  constructor(private readonly stamps: RecordStamps) {}

  async inbox(request: ApprovalInboxRequest): Promise<Page<ApprovalInboxRow>> {
    const tx = requireTransaction();

    /**
     * Whose tasks. The caller's own, plus — Phase 11 — the tasks of everybody they are currently
     * covering for.
     *
     * `assigneeId` is matched with `in` rather than rewritten, and that is the routing overlay in
     * one line: the delegate's inbox contains the *delegator's* tasks, still assigned to the
     * delegator, rather than tasks that were moved to the delegate. Nothing in the database says
     * these are the delegate's work; the query says they may act on it.
     *
     * The set is exactly what Identity authorised — one entry per delegation in force, whose
     * period covers now and whose delegator still holds the permission — so "exactly what they may
     * act on and nothing more" is a property of the `IN` list rather than a filter applied after.
     */
    const cover = request.cover ?? [];
    const assigneeIds = [request.assigneeId, ...cover.map((entry) => entry.delegatorId as string)];

    const where: Prisma.ApprovalTaskWhereInput = {
      tenantId: this.tenantId(),
      assigneeId: assigneeIds.length === 1 ? request.assigneeId : { in: assigneeIds },
      // Defaults to what is waiting, because that is what "my approvals" means. A caller asking for
      // a decided state gets their history from the same endpoint rather than a second one.
      state: request.state ?? ApprovalTaskState.PENDING,
      ...(request.overdue === true && { dueAt: { lt: this.stamps.now() } }),
      ...(request.overdue === false && {
        OR: [{ dueAt: null }, { dueAt: { gte: this.stamps.now() } }],
      }),
    };

    /** Which delegation put a covered row in this list, keyed by the delegator it covers. */
    const coverByDelegator = new Map(cover.map((entry) => [entry.delegatorId as string, entry]));

    const [rows, total] = await Promise.all([
      tx.approvalTask.findMany({
        where,
        include: INBOX_INCLUDE,
        // Soonest due first, and a task with no deadline last rather than first: `nulls: 'last'` is
        // the difference between "nothing is urgent" and "everything without a deadline is".
        orderBy:
          (request.sortBy ?? 'dueAt') === 'dueAt'
            ? [{ dueAt: { sort: request.sortDirection, nulls: 'last' } }, { id: 'asc' }]
            : orderByFor(request.sortBy as never, request.sortDirection, 'createdAt' as never),
        ...pageArgs(request),
      }),
      tx.approvalTask.count({ where }),
    ]);

    return toPage(
      rows.map((row) => {
        const covered = coverByDelegator.get(row.assigneeId);
        return {
          ...toInboxRow(row),
          // Absent for the caller's own tasks. Present for a covered one, so the screen renders
          // "on behalf of" from the row rather than by comparing the assignee to the signed-in
          // user — which is the comparison that would silently be wrong for an administrator
          // reading somebody else's inbox.
          ...(covered !== undefined && {
            onBehalfOf: {
              delegationId: covered.delegationId,
              delegatorId: covered.delegatorId,
            },
          }),
        };
      }),
      total,
      request,
    );
  }

  async instancesForDocument(documentId: DocumentId): Promise<readonly WorkflowInstanceView[]> {
    const rows = await requireTransaction().workflowInstance.findMany({
      where: { documentId, tenantId: this.tenantId() },
      include: VIEW_INCLUDE,
      orderBy: { startedAt: 'desc' },
    });
    return rows.map(toView);
  }

  async instance(id: WorkflowInstanceId): Promise<WorkflowInstanceView | null> {
    const row = await requireTransaction().workflowInstance.findFirst({
      where: { id, tenantId: this.tenantId() },
      include: VIEW_INCLUDE,
    });
    return row === null ? null : toView(row);
  }

  /** Display names for the people a screen names — the inbox's delegators, Phase 11. */
  async displayNames(userIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
    if (userIds.length === 0) {
      return new Map();
    }
    const rows = await requireTransaction().user.findMany({
      where: { tenantId: this.tenantId(), id: { in: [...userIds] } },
      select: { id: true, displayName: true },
    });
    return new Map(rows.map((row) => [row.id, row.displayName]));
  }

  /**
   * How many approvals are bound to each of these versions.
   *
   * The count Phase 2 left at zero on every row, with a comment saying the immutability rule would
   * read the same way once Phase 4 filled it in from `workflow_instance`. This is that fill-in, and
   * nothing else about the administration side changed.
   */
  async countInstancesByVersion(
    versionIds: readonly string[],
  ): Promise<ReadonlyMap<string, number>> {
    if (versionIds.length === 0) {
      return new Map();
    }
    const rows = await requireTransaction().workflowInstance.groupBy({
      by: ['workflowVersionId'],
      where: { tenantId: this.tenantId(), workflowVersionId: { in: [...versionIds] } },
      _count: { _all: true },
    });
    return new Map(rows.map((row) => [row.workflowVersionId, row._count._all]));
  }

  private tenantId(): string {
    return requireContext().tenantId;
  }
}

const INBOX_INCLUDE = {
  stage: true,
  assignee: { select: { displayName: true } },
  instance: {
    select: {
      document: {
        select: {
          id: true,
          title: true,
          documentNumber: true,
          documentType: { select: { name: true } },
        },
      },
    },
  },
} as const satisfies Prisma.ApprovalTaskInclude;

const VIEW_INCLUDE = {
  stages: { orderBy: { index: 'asc' } },
  tasks: {
    orderBy: [{ sequence: 'asc' }, { createdAt: 'asc' }],
    include: {
      assignee: { select: { displayName: true } },
    },
  },
  comments: {
    orderBy: { createdAt: 'asc' },
    include: { author: { select: { displayName: true } } },
  },
  revision: { select: { label: true } },
  definition: { select: { key: true, name: true } },
  workflowVersion: { select: { version: true } },
} as const satisfies Prisma.WorkflowInstanceInclude;

type InboxRow = Prisma.ApprovalTaskGetPayload<{ include: typeof INBOX_INCLUDE }>;
type ViewRow = Prisma.WorkflowInstanceGetPayload<{ include: typeof VIEW_INCLUDE }>;

function toInboxRow(row: InboxRow): ApprovalInboxRow {
  return {
    task: toTask(row),
    stage: toStage(row.stage),
    documentId: row.instance.document.id,
    documentTitle: row.instance.document.title,
    documentNumber: row.instance.document.documentNumber,
    documentTypeName: row.instance.document.documentType.name,
    assigneeName: row.assignee.displayName,
    decidedByName: null,
  };
}

function toView(row: ViewRow): WorkflowInstanceView {
  // One map for every name the timeline renders, built from the rows already loaded rather than
  // from a second query. A timeline shows the same handful of people repeatedly, so a lookup per
  // task would be the same name fetched five times.
  const people = new Map<string, string>();
  for (const task of row.tasks) {
    people.set(task.assigneeId, task.assignee.displayName);
  }
  for (const comment of row.comments) {
    people.set(comment.authorId, comment.author.displayName);
  }

  return {
    instance: {
      id: asId(row.id),
      documentId: asId(row.documentId),
      revisionId: asId(row.revisionId),
      definitionId: asId(row.definitionId),
      workflowVersionId: asId(row.workflowVersionId),
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
    },
    revisionLabel: row.revision.label,
    definitionKey: row.definition.key,
    definitionName: row.definition.name,
    workflowVersion: row.workflowVersion.version,
    stages: row.stages.map(toStage),
    tasks: row.tasks.map(toTask),
    people,
    comments: row.comments.map((comment): WorkflowCommentRow => ({
      id: comment.id,
      authorId: comment.authorId,
      authorName: comment.author.displayName,
      stageId: comment.stageId,
      taskId: comment.taskId,
      body: comment.body,
      decision: comment.decision,
      createdAt: comment.createdAt,
    })),
  };
}

function toStage(row: ViewRow['stages'][number]): WorkflowStageRecord {
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

function toTask(row: {
  id: string;
  instanceId: string;
  stageId: string;
  assigneeId: string;
  resolvedBy: string;
  sequence: number;
  state: string;
  decision: string | null;
  decidedById: string | null;
  onBehalfOfId: string | null;
  delegationId: string | null;
  decidedAt: Date | null;
  comment: string | null;
  dueAt: Date | null;
  escalatedFromId: string | null;
  autoDecided: boolean;
  createdAt: Date;
}): ApprovalTaskRecord {
  return {
    id: asId(row.id),
    instanceId: asId(row.instanceId),
    stageId: asId(row.stageId),
    assigneeId: asId<UserId>(row.assigneeId),
    resolvedBy: row.resolvedBy,
    sequence: row.sequence,
    state: row.state as ApprovalTaskStateKey,
    decision: row.decision as TaskDecisionKey | null,
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
