import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Optional,
  Param,
  Post,
  Query,
} from '@nestjs/common';

import {
  type AddWorkflowCommentBody,
  type ApprovalInboxItem,
  type ApprovalTask,
  type Collection,
  type DecideTaskBody,
  type DocumentWorkflow,
  type PauseWorkflowBody,
  type SubmitDocumentBody,
  type WithdrawSubmissionBody,
  type WorkflowInstance as WorkflowInstanceView,
  addWorkflowCommentSchema,
  approvalInboxQuerySchema,
  decideTaskSchema,
  pauseWorkflowSchema,
  submitDocumentSchema,
  withdrawSubmissionSchema,
} from '@edms/contracts';
import {
  ApprovalTaskState,
  type ApprovalTaskId,
  type DocumentId,
  Permission,
  TaskDecision,
  type UserId,
  WorkflowCancellationReason,
  type WorkflowInstanceId,
  asId,
} from '@edms/domain';

import { RequirePermission } from '../../../core/authorization/permission.decorator';
import { ForbiddenError } from '../../../core/errors/application-errors';
import { ZodValidationPipe } from '../../../core/http/zod-validation.pipe';
import { requireContext } from '../../../core/tenancy/tenant-context';
import { DOCUMENT_SERVICE } from '../../document/application/ports';
import type { DefaultDocumentService } from '../../document/application/document.service';
import { actionableTasks, approvalsRequired } from '../domain/completion';
import { ApprovalService } from '../application/approval.service';
import {
  WORKFLOW_DELEGATION_GATE,
  type ApprovalInboxRow,
  type ApprovalTaskRecord,
  type WorkflowInstanceView as InstanceView,
  type WorkflowDelegationGate,
  type WorkflowStageRecord,
} from '../application/ports';
import { WorkflowEngine } from '../application/workflow-engine.service';

/**
 * Approval, on the API.
 *
 * Permissions are per operation rather than per controller, for the same reason the document
 * library's are: `document:submit`, `document:approve` and `document:reject` are three separate keys
 * in the catalogue with three separate rows in the matrix, and a class-level gate would have to be
 * the loosest of them. An author who may submit must not thereby be able to approve.
 *
 * Two shapes here are worth a sentence.
 *
 * **A decision is one request.** The decision and its comment arrive together, because they are one
 * act — a rejection whose reason came in a second call is a rejection that existed for a moment with
 * no reason, and that moment is what somebody reads years later.
 *
 * **`GET /documents/{id}/workflow` answers the whole approval area.** The live attempt, every ended
 * one, the available transitions and whether this kind of document needs approving at all. A
 * timeline is one instance rendered forwards and a history is the list of them, so serving them from
 * two endpoints would be two projections of one aggregate to keep in step.
 */
@Controller({ version: '1' })
export class ApprovalController {
  constructor(
    private readonly engine: WorkflowEngine,
    private readonly approvals: ApprovalService,
    @Inject(DOCUMENT_SERVICE) private readonly documents: DefaultDocumentService,
    /**
     * `@Optional` for the same reason the engine's is: a composition without delegation bound
     * serves every inbox exactly as Phase 4 did. The seam degrades to the narrower list.
     */
    @Optional()
    @Inject(WORKFLOW_DELEGATION_GATE)
    private readonly delegations: WorkflowDelegationGate | null = null,
  ) {}

  // --- The inbox ----------------------------------------------------------------------------

  /**
   * What needs a decision.
   *
   * Defaults to the caller's own tasks. Naming somebody else requires `delegation:manage` — a
   * delegate has to see what they may act on, and a manager reviewing a backlog has to see their
   * team's — and without that permission asking for another person's inbox is refused rather than
   * quietly answered with your own.
   */
  @Get('approval-tasks')
  @RequirePermission(Permission.DOCUMENT_VIEW)
  async inbox(
    @Query(new ZodValidationPipe(approvalInboxQuerySchema))
    query: ReturnType<typeof approvalInboxQuerySchema.parse>,
  ): Promise<Collection<ApprovalInboxItem>> {
    const caller = this.caller();
    if (query.assigneeId !== undefined && query.assigneeId !== caller) {
      throw new ForbiddenError('read somebody else’s approval inbox');
    }

    /**
     * Whom this caller is covering — Phase 11, and the reason the check above did not have to
     * change.
     *
     * Phase 4 wrote that refusal "for a delegate who has to see what they may act on", and the
     * shape it anticipated was a delegate asking for the *delegator's* inbox behind
     * `delegation:manage`. What was built instead is narrower and needs no permission at all: a
     * delegate's own inbox contains the delegator's tasks, because "what needs my decision" is one
     * question rather than two lists somebody has to know to ask for. Naming another person is
     * still refused, and still means what it meant.
     *
     * Resolved for the caller's own inbox only. An administrator reading somebody else's — which
     * this endpoint refuses today — would need *that* person's cover, not their own, and silently
     * mixing the two is the defect this comment exists to prevent.
     */
    const cover =
      this.delegations === null || (query.assigneeId ?? caller) !== caller
        ? []
        : await this.delegations.coverFor({
            actorId: caller,
            // The inbox is what somebody may *act* on, and approving is the act it exists for. A
            // delegation covering only `document:reject` puts nothing here — which is right: there
            // is no such thing as a task you may only refuse.
            permission: Permission.DOCUMENT_APPROVE,
            at: new Date(),
          });

    const page = await this.approvals.inbox({
      page: query.page,
      pageSize: query.pageSize,
      assigneeId: query.assigneeId ?? caller,
      cover,
      ...(query.state !== undefined && { state: query.state }),
      ...(query.sortBy !== undefined && { sortBy: query.sortBy }),
      ...(query.overdue !== undefined && { overdue: query.overdue === 'true' }),
      sortDirection: query.sortDirection,
    });
    const now = new Date();
    const names = await this.approvals.namesOf(cover.map((entry) => entry.delegatorId));
    return {
      data: page.data.map((row) => toInboxItem(row, now, names)),
      meta: page.meta,
    };
  }

  // --- A document's approval ----------------------------------------------------------------

  @Get('documents/:id/workflow')
  @RequirePermission(Permission.DOCUMENT_VIEW)
  async forDocument(@Param('id') id: string): Promise<DocumentWorkflow> {
    const documentId = asId<DocumentId>(id);
    const [approval, context, transitions] = await Promise.all([
      this.approvals.forDocument(documentId),
      this.documents.approvalContext(id),
      this.documents.availableTransitions(id),
    ]);

    return {
      documentId: id,
      status: context?.status ?? 'DRAFT',
      current: approval.current === null ? null : toInstance(approval.current),
      history: approval.history.map(toInstance),
      availableTransitions: [...transitions],
      // False for a type that names no definition, which is legitimate — a reference document needs
      // no approval — and is why the client hides "submit" rather than offering one that refuses.
      requiresApproval: context?.workflowDefinitionId !== null,
    };
  }

  @Post('documents/:id/submit')
  @RequirePermission(Permission.DOCUMENT_SUBMIT)
  async submit(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(submitDocumentSchema)) body: SubmitDocumentBody,
  ): Promise<DocumentWorkflow> {
    await this.engine.submit(asId<DocumentId>(id), body.comment ?? null);
    return this.forDocument(id);
  }

  /**
   * The author taking a document back.
   *
   * `document:submit` rather than a permission of its own: withdrawing is the inverse of submitting
   * and the engine refuses it once anybody has decided — at which point the document is no longer
   * the author's to take back, and cancelling it is an administrative act with its own gate.
   */
  @Post('documents/:id/withdraw')
  @RequirePermission(Permission.DOCUMENT_SUBMIT)
  async withdraw(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(withdrawSubmissionSchema)) body: WithdrawSubmissionBody,
  ): Promise<DocumentWorkflow> {
    await this.engine.withdraw(asId<DocumentId>(id), body.reason ?? null);
    return this.forDocument(id);
  }

  // --- Deciding -----------------------------------------------------------------------------

  /**
   * One approver's decision.
   *
   * Gated on `document:approve`, and a rejection additionally needs `document:reject`. Two keys
   * because the matrix has two: a reviewer who may agree is not necessarily one who may refuse and
   * send a document back, and collapsing them would grant the second to everybody holding the first.
   */
  @Post('approval-tasks/:id/decision')
  @RequirePermission(Permission.DOCUMENT_APPROVE)
  async decide(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(decideTaskSchema)) body: DecideTaskBody,
  ): Promise<WorkflowInstanceView> {
    if (body.decision === TaskDecision.REJECTED) {
      this.requirePermission(Permission.DOCUMENT_REJECT, 'reject a document');
    }
    const instanceId = await this.engine.decide({
      taskId: asId<ApprovalTaskId>(id),
      decision: body.decision,
      comment: body.comment ?? null,
    });
    return this.requireInstance(instanceId);
  }

  // --- The conversation ---------------------------------------------------------------------

  @Post('workflow-instances/:id/comments')
  @RequirePermission(Permission.DOCUMENT_VIEW)
  @HttpCode(HttpStatus.NO_CONTENT)
  async comment(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(addWorkflowCommentSchema)) body: AddWorkflowCommentBody,
  ): Promise<void> {
    await this.engine.comment(asId<WorkflowInstanceId>(id), body.body);
  }

  // --- Holding and ending -------------------------------------------------------------------

  /**
   * Stops an approval's clocks, and starts them again.
   *
   * `workflow:manage`, because holding somebody's approval is an administrative act rather than a
   * participant's. Phase 4 exposes it directly; the legal hold that will call it is Phase 9's, and
   * it calls exactly this — which is why the pause takes a stated reason rather than free text.
   */
  @Post('workflow-instances/:id/pause')
  @RequirePermission(Permission.WORKFLOW_MANAGE)
  async pause(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(pauseWorkflowSchema)) body: PauseWorkflowBody,
  ): Promise<WorkflowInstanceView> {
    const instanceId = asId<WorkflowInstanceId>(id);
    await this.engine.pause(instanceId, body.reason, body.note ?? null);
    return this.requireInstance(instanceId);
  }

  @Post('workflow-instances/:id/resume')
  @RequirePermission(Permission.WORKFLOW_MANAGE)
  async resume(@Param('id') id: string): Promise<WorkflowInstanceView> {
    const instanceId = asId<WorkflowInstanceId>(id);
    await this.engine.resume(instanceId);
    return this.requireInstance(instanceId);
  }

  @Post('workflow-instances/:id/cancel')
  @RequirePermission(Permission.WORKFLOW_MANAGE)
  @HttpCode(HttpStatus.NO_CONTENT)
  async cancel(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(withdrawSubmissionSchema)) body: WithdrawSubmissionBody,
  ): Promise<void> {
    await this.engine.cancel(
      asId<WorkflowInstanceId>(id),
      WorkflowCancellationReason.ADMINISTRATIVE,
      body.reason ?? null,
    );
  }

  // --- Internals ----------------------------------------------------------------------------

  private async requireInstance(id: WorkflowInstanceId): Promise<WorkflowInstanceView> {
    const view = await this.approvals.instance(id);
    if (view === null) {
      throw new ForbiddenError('read this approval');
    }
    return toInstance(view);
  }

  private caller(): UserId {
    const { userId } = requireContext();
    if (userId === null) {
      throw new ForbiddenError('read an approval inbox without a signed-in user');
    }
    return userId;
  }

  /**
   * A second permission check, inside a handler.
   *
   * Unusual and justified: `RequirePermission` gates a route, and rejecting is a different grant
   * from approving on the *same* route — the two arrive in one body because they are one act. The
   * alternative is two endpoints for one decision, which would let a client take the approve path
   * and put `REJECTED` in the body.
   */
  private requirePermission(permission: string, action: string): void {
    const { permissions } = requireContext();
    if (!permissions.includes(permission as never)) {
      throw new ForbiddenError(action);
    }
  }
}

// --- Mappers ---------------------------------------------------------------------------------

function toInboxItem(
  row: ApprovalInboxRow,
  now: Date,
  delegatorNames: ReadonlyMap<string, string>,
): ApprovalInboxItem {
  return {
    ...toTask(row.task, row.stage, new Map([[row.task.assigneeId, row.assigneeName ?? '']]), true),
    documentId: row.documentId,
    documentTitle: row.documentTitle,
    documentNumber: row.documentNumber,
    documentTypeName: row.documentTypeName,
    // Computed server-side, so two clients in two timezones cannot disagree about "overdue".
    overdue: row.task.dueAt !== null && row.task.dueAt.getTime() < now.getTime(),
    // Present only when this row is here because of a delegation. The task's `assigneeId` is
    // unchanged beside it, which is the routing overlay visible on the wire.
    onBehalfOf:
      row.onBehalfOf === undefined
        ? null
        : {
            delegationId: row.onBehalfOf.delegationId,
            delegatorId: row.onBehalfOf.delegatorId,
            delegatorName: delegatorNames.get(row.onBehalfOf.delegatorId) ?? null,
          },
  };
}

function toInstance(view: InstanceView): WorkflowInstanceView {
  return {
    id: view.instance.id,
    documentId: view.instance.documentId,
    revisionId: view.instance.revisionId,
    revisionLabel: view.revisionLabel,
    definitionId: view.instance.definitionId,
    definitionKey: view.definitionKey,
    definitionName: view.definitionName,
    workflowVersionId: view.instance.workflowVersionId,
    workflowVersion: view.workflowVersion,
    status: view.instance.status,
    currentStageIndex: view.instance.currentStageIndex,
    startedAt: view.instance.startedAt.toISOString(),
    startedBy: view.instance.startedBy,
    endedAt: view.instance.endedAt?.toISOString() ?? null,
    endReason: view.instance.endReason,
    pausedAt: view.instance.pausedAt?.toISOString() ?? null,
    pauseReason: view.instance.pauseReason,
    escalationCount: view.instance.escalationCount,
    numberAssigned: view.instance.numberAssigned,
    version: view.instance.version,
    stages: view.stages.map((stage) => {
      const tasks = view.tasks.filter((task) => task.stageId === stage.id);
      const decidable = new Set(actionableTasks(stage.ordered, tasks).map((task) => task.id));
      return {
        id: stage.id,
        index: stage.index,
        name: stage.name,
        completionRule: stage.completionRule,
        threshold: stage.threshold,
        ordered: stage.ordered,
        status: stage.status,
        // Computed with the same function the engine completes the stage with, so "2 of 3" on a
        // screen and the rule that ends the stage can never disagree about what `PERCENT` rounds to.
        approvalsRequired: approvalsRequired(
          { rule: stage.completionRule, threshold: stage.threshold },
          tasks.length,
        ),
        approvalsGiven: tasks.filter((task) => task.decision === TaskDecision.APPROVED).length,
        activatedAt: stage.activatedAt?.toISOString() ?? null,
        completedAt: stage.completedAt?.toISOString() ?? null,
        dueAt: stage.dueAt?.toISOString() ?? null,
        skipReason: stage.skipReason,
        tasks: tasks.map((task) => toTask(task, stage, view.people, decidable.has(task.id))),
      };
    }),
    comments: view.comments.map((comment) => ({
      id: comment.id,
      authorId: comment.authorId,
      authorName: comment.authorName,
      stageId: comment.stageId,
      taskId: comment.taskId,
      body: comment.body,
      decision: comment.decision,
      createdAt: comment.createdAt.toISOString(),
    })),
  };
}

/**
 * One task, as both the inbox row and the timeline entry render it.
 *
 * One mapper rather than two, because they are the same object seen from two screens — an inbox row
 * is a task plus enough of its document to decide whether to open it, and the contract says so by
 * extending rather than restating.
 */
function toTask(
  task: ApprovalTaskRecord,
  stage: WorkflowStageRecord,
  people: ReadonlyMap<string, string>,
  actionable: boolean,
): ApprovalTask {
  return {
    id: task.id,
    workflowInstanceId: task.instanceId,
    stageId: task.stageId,
    stageIndex: stage.index,
    stageName: stage.name,
    assigneeId: task.assigneeId,
    assigneeName: people.get(task.assigneeId) ?? null,
    resolvedBy: task.resolvedBy,
    sequence: task.sequence,
    state: task.state,
    decision: task.decision,
    decidedById: task.decidedById,
    decidedByName: task.decidedById === null ? null : (people.get(task.decidedById) ?? null),
    onBehalfOfId: task.onBehalfOfId,
    delegationId: task.delegationId,
    decidedAt: task.decidedAt?.toISOString() ?? null,
    comment: task.comment,
    dueAt: task.dueAt?.toISOString() ?? null,
    autoDecided: task.autoDecided,
    // False for a later step of an ordered stage: the task exists so the whole routing is visible,
    // and only the earliest outstanding one may be decided.
    actionable: actionable && task.state === ApprovalTaskState.PENDING,
    createdAt: task.createdAt.toISOString(),
  };
}
