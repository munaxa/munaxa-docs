import { Inject, Injectable, Optional } from '@nestjs/common';

import {
  type AnyId,
  ApprovalTaskState,
  type ApprovalTaskId,
  AuditSubjectType,
  type DocumentId,
  DocumentStatus,
  type DocumentStatusKey,
  OverdueAction,
  RejectBehaviour,
  StageSkipReason,
  TaskDecision,
  type PermissionKey,
  Permission,
  type TaskDecisionKey,
  type UserId,
  WorkflowCancellationReason,
  type WorkflowCancellationReasonKey,
  WorkflowInstanceStatus,
  type WorkflowInstanceId,
  type WorkflowPauseReasonKey,
  WorkflowStageStatus,
  WorkflowTimerKind,
  type WorkflowVersionId,
  asId,
} from '@edms/domain';
import type { WorkflowDefinitionBody, WorkflowStage } from '@edms/contracts';

import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
  VersionConflictError,
} from '../../../core/errors/application-errors';
import { LOGGER, type Logger } from '../../../core/observability/logger';
import { OUTBOX_WRITER, type OutboxWriter } from '../../../core/outbox/outbox.port';
import {
  AdministeredWriter,
  type AdministrativeChange,
  AdministrativeOperation,
} from '../../../core/persistence';
import { requireContext } from '../../../core/tenancy/tenant-context';
import { WorkflowAudit } from '../domain/audit-actions';
import {
  StageOutcome,
  type StageOutcomeKey,
  actionableTasks,
  evaluateStage,
} from '../domain/completion';
import { evaluateCondition } from '../domain/conditions';
import {
  approvalTaskDecidedEvent,
  approvalTaskEscalatedEvent,
  workflowCancelledEvent,
  workflowCompletedEvent,
  approvalOverdueEvent,
  approvalReminderDueEvent,
  approvalTaskAssignedEvent,
  workflowStageActivatedEvent,
  workflowStartedEvent,
} from '../domain/events';
import { ParticipantResolver, describe } from './participant-resolver';
import {
  APPROVAL_TASK_DEFINITION_MISSING,
  WORKFLOW_VERSION_READER,
  type WorkflowVersionReader,
} from './version-reader.port';
import { WorkflowTimers } from './workflow-timers.service';
import {
  DOCUMENT_NUMBER_ALLOCATOR,
  type DocumentApprovalContext,
  type DocumentNumberAllocator,
  type NewTask,
  type NewTimer,
  type SubmitResult,
  WORKFLOW_CALENDAR,
  WORKFLOW_DELEGATION_GATE,
  WORKFLOW_DOCUMENT_GATE,
  WORKFLOW_ENGINE_REPOSITORY,
  type WorkflowAggregate,
  type WorkflowCalendarReader,
  type WorkflowDelegationGate,
  type WorkflowDocumentGate,
  type WorkflowEngineRepository,
  type WorkflowStageRecord,
} from './ports';

/**
 * The engine.
 *
 * Everything it does is one of four moves — start an instance, activate a stage, decide a task, end
 * an instance — and every routing shape a tenant can author is a composition of those. There is no
 * code path for "sequential approval" and none for "parallel": stages run in order, tasks inside a
 * stage run in parallel unless the stage is `ordered`, and the completion rule says how many have
 * to agree (`07-workflow-architecture.md` §2). That is deliberately one primitive rather than
 * three, because three would have to be kept in step and the third would be the one nobody tests.
 *
 * ### The guarantees, and where each one lives
 *
 * **One transaction per decision.** `AdministeredWriter.write` opens it, and the task, the stage,
 * the instance, the document's status and the audit event commit inside it or none of them do (§3).
 * The one thing deliberately outside is the queue: timers are planned in the transaction, written
 * as rows in it, and enqueued after it commits — because a reminder enqueued inside a transaction
 * that then rolls back is exactly what [ADR-0011] exists to prevent.
 *
 * **A task is decided once.** The update carries `decision IS NULL` in its `WHERE`, and zero rows
 * affected is a `409`. A read-then-write would leave a window however short the transaction is, and
 * a second decision on one task corrupts the quorum count — which §8 names as something the engine
 * must never do.
 *
 * **A resolver that yields nobody fails loudly.** Submission refuses, naming the resolver. The
 * alternative — skipping the stage — is a control silently not applied, which is the failure mode
 * the whole product exists to make impossible.
 *
 * **Numbering happens through the seam, never in the engine.** [ADR-0004] reserves at submission
 * and assigns at approval, and §8 forbids assigning earlier. The engine calls
 * `DOCUMENT_NUMBER_ALLOCATOR` — reserve on submit, assign on complete, void on every ending that
 * is not an approval — always inside the same transaction as the move it accompanies. The port
 * stays `@Optional`: with nothing bound an approval completes with `numberAssigned: false`, which
 * Phase 4 shipped and test doubles still exercise. Lock order is fixed and stated: the instance
 * row first (taken by every write path already), the document row next, and the sequence counter
 * inside the allocator last — so two approvals in one series serialise on the counter for the
 * tail of their transactions and cannot deadlock across it.
 */
@Injectable()
export class WorkflowEngine {
  constructor(
    @Inject(WORKFLOW_ENGINE_REPOSITORY) private readonly repository: WorkflowEngineRepository,
    @Inject(WORKFLOW_DOCUMENT_GATE) private readonly documents: WorkflowDocumentGate,
    @Inject(WORKFLOW_VERSION_READER) private readonly versions: WorkflowVersionReader,
    @Inject(WORKFLOW_CALENDAR) private readonly calendars: WorkflowCalendarReader,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriter,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly participants: ParticipantResolver,
    private readonly timers: WorkflowTimers,
    private readonly writer: AdministeredWriter,
    /**
     * Bound by this module since Phase 5, and still `@Optional`: a composition without the
     * binding — Phase 4's state, and the engine's test doubles — completes approvals honestly
     * unnumbered rather than failing or fabricating.
     */
    @Optional()
    @Inject(DOCUMENT_NUMBER_ALLOCATOR)
    private readonly numbering: DocumentNumberAllocator | null = null,
    /**
     * Bound by this module since Phase 11, and `@Optional` for the same reason the allocator is:
     * a composition without it — Phase 4's state, and the engine's own test doubles — refuses
     * every decision on somebody else's task, which is exactly what the engine did before
     * delegation existed. The seam degrades to the stricter behaviour, never to the looser one.
     */
    @Optional()
    @Inject(WORKFLOW_DELEGATION_GATE)
    private readonly delegations: WorkflowDelegationGate | null = null,
  ) {}

  // --- Submission -------------------------------------------------------------------------

  /**
   * Hands a document to its workflow.
   *
   * Everything that can refuse, refuses here — before anything is written. A submission that
   * created an instance and then discovered nobody could approve stage 0 would leave a document
   * `SUBMITTED` with an approval nothing could finish, and the author would have no way back.
   */
  async submit(documentId: DocumentId, comment: string | null): Promise<SubmitResult> {
    const scheduled: NewTimer[] = [];

    const result = await this.writer.write<SubmitResult>(async () => {
      const context = await this.requireContextFor(documentId);
      const actor = this.requireActor();

      if (context.status !== DocumentStatus.DRAFT) {
        throw new ValidationError('Only a draft can be submitted for approval.', [
          { field: 'status', message: context.status },
        ]);
      }
      if (context.latestRevisionId === null) {
        // A submission is a request to approve *content*. §3's guard list names "a file attached"
        // for exactly this reason: approving a document with nothing in it approves nothing.
        throw new ValidationError('This document has no content to approve.', [
          { field: 'revision', message: 'missing' },
        ]);
      }
      if (context.workflowDefinitionId === null) {
        // Legitimate rather than an error state: a reference type needs no approval. Refused with
        // a sentence rather than silently approving, because a type that *should* have a workflow
        // and does not is a configuration mistake somebody has to be told about.
        throw new ValidationError('This kind of document does not go through approval.', [
          { field: 'documentType', message: 'no workflow' },
        ]);
      }
      if ((await this.repository.loadLiveForDocument(documentId)) !== null) {
        // The polite refusal. Two submissions racing past it both fail on the partial unique index
        // instead, which is what makes "one live approval per document" a property rather than a
        // check — and is why the index exists as well as this.
        throw new ValidationError('This document is already in approval.', [
          { field: 'status', message: 'in approval' },
        ]);
      }

      const version = await this.versions.publishedVersionFor(context.workflowDefinitionId);
      if (version === null) {
        throw new ValidationError(
          'The workflow for this kind of document has no published version.',
          [{ field: 'workflow', message: APPROVAL_TASK_DEFINITION_MISSING }],
        );
      }
      if (!this.appliesTo(version.definition, context)) {
        // `appliesTo` is the definition's own scope. A definition that does not apply to this
        // document is a configuration answer, not a failure of this submission — and it is refused
        // rather than skipped, because "approved without approval" is never the right outcome.
        throw new ValidationError(
          'The workflow attached to this document type does not apply to this document.',
          [{ field: 'workflow', message: 'appliesTo' }],
        );
      }

      const instanceId = this.writer.clock.nextId();
      const now = this.writer.clock.now();

      await this.repository.createInstance({
        id: instanceId,
        documentId,
        revisionId: context.latestRevisionId,
        definitionId: context.workflowDefinitionId,
        workflowVersionId: version.id,
        startedAt: now,
      });
      await this.repository.createStages(
        version.definition.stages.map((stage, index) => ({
          id: this.writer.clock.nextId(),
          instanceId,
          index,
          name: stage.name,
          completionRule: stage.completionRule,
          threshold: stage.threshold ?? null,
          ordered: stage.ordered,
        })),
      );

      await this.documents.transition({
        documentId,
        to: DocumentStatus.SUBMITTED,
        workflowInstanceId: instanceId,
        reason: null,
      });

      // ADR-0004: the pending reference reviewers will use, drawn in the submission's own
      // transaction — a submission that fails to validate never spends a value. Before
      // `advanceFrom`, because a definition whose every stage is scoped away completes *inside*
      // this call, and completion must find the reservation it commits.
      if (this.numbering !== null) {
        await this.numbering.reserveAtSubmission({
          documentId,
          workflowInstanceId: asId<WorkflowInstanceId>(instanceId),
        });
      }

      if (comment !== null) {
        await this.repository.addComment({
          id: this.writer.clock.nextId(),
          instanceId,
          documentId,
          stageId: null,
          taskId: null,
          authorId: actor,
          body: comment,
          decision: null,
          at: now,
        });
      }

      await this.outbox.publish([
        workflowStartedEvent(asId<AnyId>(instanceId), {
          workflowInstanceId: instanceId,
          documentId,
          revisionId: context.latestRevisionId,
          workflowVersionId: version.id,
        }),
      ]);

      // The first stage activates inside the same transaction. `SUBMITTED` is a state a document
      // passes *through*, not one it rests in: §2's sequence has the engine resolve participants
      // and create tasks immediately, and a document left `SUBMITTED` with no tasks would be a
      // document waiting for a process that had already been asked to start.
      const aggregate = await this.requireAggregate(asId<WorkflowInstanceId>(instanceId));
      const advanced = await this.advanceFrom(aggregate, 0, context, version.definition, []);
      scheduled.push(...advanced.timers);

      return {
        result: { instanceId: asId<WorkflowInstanceId>(instanceId), status: advanced.status },
        change: {
          action: WorkflowAudit.SUBMITTED,
          subjectType: AuditSubjectType.DOCUMENT,
          subjectId: asId<AnyId>(documentId),
          operation: AdministrativeOperation.UPDATED,
          before: { status: DocumentStatus.DRAFT },
          after: {
            status: advanced.status,
            workflowInstanceId: instanceId,
            // The version, not the definition. "Which rules was this approved under" is the
            // question this trail exists to answer years later, and a definition identifier alone
            // would answer it with whatever the definition says today.
            workflowVersionId: version.id,
            workflowVersion: version.version,
            revisionId: context.latestRevisionId,
          },
        },
      };
    });

    await this.timers.enqueue(scheduled);
    return result;
  }

  // --- Deciding ---------------------------------------------------------------------------

  /**
   * One approver's decision, and everything that follows from it.
   *
   * The order inside the transaction is the order the rules apply in: the task is claimed first, so
   * two people racing to decide one task produce one decision and one conflict; then the stage is
   * re-evaluated; then the instance either moves on or ends.
   */
  async decide(input: {
    readonly taskId: ApprovalTaskId;
    readonly decision: TaskDecisionKey;
    readonly comment: string | null;
  }): Promise<WorkflowInstanceId> {
    const scheduled: NewTimer[] = [];

    const instanceId = await this.writer.write<WorkflowInstanceId>(async () => {
      // The instance is locked before anything is read, and that ordering is the whole of what makes
      // a quorum correct under concurrency. Two approvers deciding at the same instant run in two
      // transactions; without the lock neither sees the other's decision, both evaluate the stage
      // against one approval, and a two-person quorum is met while the stage stays pending forever.
      // With it the second decision waits, re-reads, and completes the stage.
      const owning = await this.repository.instanceIdOfTask(input.taskId);
      if (owning === null || !(await this.repository.lockInstance(owning))) {
        throw new NotFoundError('The requested task');
      }
      const aggregate = await this.repository.load(owning);
      if (aggregate === null) {
        throw new NotFoundError('The requested task');
      }
      const task = aggregate.tasks.find((candidate) => candidate.id === input.taskId);
      if (task === undefined) {
        throw new NotFoundError('The requested task');
      }
      const actor = this.requireActor();

      if (aggregate.instance.status !== WorkflowInstanceStatus.RUNNING) {
        throw new ValidationError('This approval is not running.', [
          { field: 'status', message: aggregate.instance.status },
        ]);
      }
      const now = this.writer.clock.now();

      // The one check Phase 4 said this phase relaxes, relaxed in the one place it lives.
      //
      // Delegation is a **routing overlay** (§4): the task stays the delegator's and the delegate
      // acts on it. So nothing below rewrites `assigneeId`, and the task is not reassigned — the
      // actor is simply permitted to decide it, and both identities are recorded.
      //
      // The authority is asked for *now*, inside this transaction, after the instance's row lock.
      // That ordering is what makes revocation immediate in the sense §4 means: a revocation
      // committed before this read is already visible, and one arriving after it waits on the lock
      // and finds the decision already taken. There is no window in which a revoked delegation
      // decides anything.
      let delegationId: string | null = null;
      if (task.assigneeId !== actor) {
        if (this.delegations === null) {
          // Phase 4's state, kept composable: with nothing bound, only the assignee decides.
          throw new ForbiddenError('decide a task assigned to somebody else');
        }
        const authority = await this.delegations.authorityFor({
          actorId: actor,
          assigneeId: task.assigneeId,
          // The permission the delegate is exercising. Named rather than assumed, because §4's
          // rule is about *this* permission: a delegation covering `document:approve` does not
          // authorise a rejection, which the catalogue and the matrix treat as a separate grant.
          permission: permissionFor(input.decision),
          at: now,
        });
        if (authority.delegationId === null) {
          // The refusal names which rule refused, so an approver is told something they can act
          // on — "that delegation ended on Friday" rather than a bare "not yours".
          throw new ForbiddenError(
            `decide a task assigned to somebody else (${authority.refusal ?? 'NONE'})`,
          );
        }
        delegationId = authority.delegationId;
      }
      if (input.decision !== TaskDecision.APPROVED && input.comment === null) {
        throw new ValidationError('A rejection or a request for changes has to say why.', [
          { field: 'comment', message: 'required' },
        ]);
      }

      const stage = this.requireStage(aggregate, task.stageId);
      const actionable = actionableTasks(
        stage.ordered,
        aggregate.tasks.filter((candidate) => candidate.stageId === stage.id),
      );
      if (!actionable.some((candidate) => candidate.id === task.id)) {
        // An `ordered` stage hands out every task at activation so the whole routing is visible,
        // and only the earliest outstanding step is decidable. Refusing later ones here is what
        // makes "ordered" mean anything.
        throw new ValidationError('An earlier approver has still to decide.', [
          { field: 'sequence', message: 'not yet' },
        ]);
      }

      const claimed = await this.repository.decideIfPending({
        taskId: task.id,
        decision: input.decision,
        // Who *actually* decided. The delegate, when one did.
        decidedById: actor,
        // The delegator, set only when somebody decided for another person — Phase 11 filling the
        // field Phase 4 left, with no migration, exactly as that phase intended. `assigneeId` is
        // untouched: the task never moved.
        onBehalfOfId: delegationId === null ? null : task.assigneeId,
        // The arrangement that authorised it. Written with the pair or with neither — a check
        // constraint refuses a row that carries one and not the other, because a trail that names
        // a delegation but no delegator cannot answer "who decided, and for whom".
        delegationId,
        comment: input.comment,
        at: now,
        autoDecided: false,
      });
      if (!claimed) {
        // Zero rows matched: somebody decided first. A conflict rather than an overwrite, and the
        // numbers are the version pair a client uses to reload.
        throw new VersionConflictError(0, 1);
      }

      if (input.comment !== null) {
        await this.repository.addComment({
          id: this.writer.clock.nextId(),
          instanceId: aggregate.instance.id,
          documentId: aggregate.instance.documentId,
          stageId: stage.id,
          taskId: task.id,
          authorId: actor,
          body: input.comment,
          decision: input.decision,
          at: now,
        });
      }

      await this.outbox.publish([
        approvalTaskDecidedEvent(asId<AnyId>(task.id), {
          taskId: task.id,
          workflowInstanceId: aggregate.instance.id,
          decision: input.decision,
          decidedBy: actor,
          onBehalfOfId: delegationId === null ? null : task.assigneeId,
        }),
      ]);

      if (delegationId !== null) {
        // The **second** audit event, in the same transaction as the decision's own, through the
        // `record` method Phase 10 added for exactly this shape. It is what makes the delegated
        // decision *attested*: Phase 9 widened the chain's digest to cover `on_behalf_of_id`, and
        // it does not cover `approval_task.delegation_id`, which this phase added afterwards — the
        // table refuses the `UPDATE` that would rehash the trail, so the column can never become
        // covered. This row is chained like every other, and it is filed against the **delegation**
        // rather than the task, which is what makes "everything decided under this arrangement" a
        // query on one subject rather than a join through a table an investigation has to know
        // about.
        await this.writer.record({
          action: WorkflowAudit.DELEGATION_USED,
          subjectType: AuditSubjectType.DELEGATION,
          subjectId: asId<AnyId>(delegationId),
          operation: AdministrativeOperation.UPDATED,
          after: {
            taskId: task.id,
            workflowInstanceId: aggregate.instance.id,
            documentId: aggregate.instance.documentId,
            decision: input.decision,
            decidedBy: actor,
            onBehalfOf: task.assigneeId,
          },
        });
      }

      const after = await this.requireAggregate(aggregate.instance.id);
      const outcome = await this.settleStage(after, stage, scheduled);

      return {
        result: aggregate.instance.id,
        change: {
          action: auditActionFor(input.decision),
          subjectType: AuditSubjectType.TASK,
          subjectId: asId<AnyId>(task.id),
          operation: AdministrativeOperation.UPDATED,
          after: {
            workflowInstanceId: aggregate.instance.id,
            documentId: aggregate.instance.documentId,
            // The revision decided on, so "prove what was approved" resolves through this event
            // without a join that a later revision would change the answer of (§3).
            revisionId: aggregate.instance.revisionId,
            stageIndex: stage.index,
            stageName: stage.name,
            decision: input.decision,
            decidedBy: actor,
            onBehalfOf: delegationId === null ? null : task.assigneeId,
            delegationId,
            comment: input.comment,
            stageOutcome: outcome,
          },
        },
      };
    });

    await this.timers.enqueue(scheduled);
    return instanceId;
  }

  // --- Ending -----------------------------------------------------------------------------

  /** The author taking a document back before anybody has decided. */
  async withdraw(documentId: DocumentId, reason: string | null): Promise<void> {
    const aggregate = await this.writer.read(() => this.repository.loadLiveForDocument(documentId));
    if (aggregate === null) {
      throw new ValidationError('This document is not in approval.', [
        { field: 'status', message: 'not submitted' },
      ]);
    }
    const actor = this.requireActor();
    const context = await this.writer.read(() => this.documents.contextFor(documentId));
    if (context !== null && context.ownerUserId !== actor && context.authorUserId !== actor) {
      throw new ForbiddenError('withdraw somebody else’s submission');
    }
    await this.end(
      aggregate.instance.id,
      WorkflowCancellationReason.WITHDRAWN,
      reason,
      DocumentStatus.DRAFT,
    );
  }

  /** An administrator ending an approval that should not continue. */
  async cancel(
    instanceId: WorkflowInstanceId,
    reason: WorkflowCancellationReasonKey,
    note: string | null,
  ): Promise<void> {
    await this.end(instanceId, reason, note, DocumentStatus.DRAFT);
  }

  // --- Holding ----------------------------------------------------------------------------

  /**
   * Stops an approval's clocks.
   *
   * The pause is what a legal hold and a tenant suspension both need, and §6 is precise about what
   * it means: each timer keeps what it had left. Phase 4 exposes it administratively; the legal
   * hold that will call it is Phase 9's, and it calls exactly this.
   */
  async pause(
    instanceId: WorkflowInstanceId,
    reason: WorkflowPauseReasonKey,
    note: string | null,
  ): Promise<void> {
    await this.writer.write(async () => {
      await this.lock(instanceId);
      const aggregate = await this.requireAggregate(instanceId);
      if (aggregate.instance.status !== WorkflowInstanceStatus.RUNNING) {
        throw new ValidationError('Only a running approval can be held.', [
          { field: 'status', message: aggregate.instance.status },
        ]);
      }
      const now = this.writer.clock.now();
      await this.repository.setPaused({ instanceId, paused: true, reason, at: now });
      await this.timers.pause(instanceId);

      return {
        result: undefined,
        change: {
          action: WorkflowAudit.WORKFLOW_PAUSED,
          subjectType: AuditSubjectType.WORKFLOW,
          subjectId: asId<AnyId>(instanceId),
          operation: AdministrativeOperation.UPDATED,
          before: { status: WorkflowInstanceStatus.RUNNING },
          after: { status: WorkflowInstanceStatus.PAUSED, reason, note },
        },
      };
    });
  }

  async resume(instanceId: WorkflowInstanceId): Promise<void> {
    await this.writer.write(async () => {
      await this.lock(instanceId);
      const aggregate = await this.requireAggregate(instanceId);
      if (aggregate.instance.status !== WorkflowInstanceStatus.PAUSED) {
        throw new ValidationError('This approval is not being held.', [
          { field: 'status', message: aggregate.instance.status },
        ]);
      }
      const now = this.writer.clock.now();
      await this.repository.setPaused({ instanceId, paused: false, reason: null, at: now });
      await this.timers.resume(instanceId);

      return {
        result: undefined,
        change: {
          action: WorkflowAudit.WORKFLOW_PAUSED,
          subjectType: AuditSubjectType.WORKFLOW,
          subjectId: asId<AnyId>(instanceId),
          operation: AdministrativeOperation.UPDATED,
          before: {
            status: WorkflowInstanceStatus.PAUSED,
            pausedAt: aggregate.instance.pausedAt?.toISOString() ?? null,
          },
          after: { status: WorkflowInstanceStatus.RUNNING },
        },
      };
    });
  }

  /** A remark that is not a decision. Not audited: a comment is not a change to a controlled record. */
  async comment(instanceId: WorkflowInstanceId, body: string): Promise<void> {
    await this.writer.read(async () => {
      const aggregate = await this.requireAggregate(instanceId);
      await this.repository.addComment({
        id: this.writer.clock.nextId(),
        instanceId,
        documentId: aggregate.instance.documentId,
        stageId: null,
        taskId: null,
        authorId: this.requireActor(),
        body,
        decision: null,
        at: this.writer.clock.now(),
      });
    });
  }

  // --- Timers -----------------------------------------------------------------------------

  /**
   * A deadline or a reminder arrived.
   *
   * Idempotent on the timer row rather than on the delivery, because delivery is at least once and
   * a job that arrives twice must do its work once. `markTimerFired` is the claim: it moves
   * `SCHEDULED` to `FIRED` and returns false if the row was not `SCHEDULED`, which covers a
   * duplicate delivery, a job that outlived the stage it belonged to, and one that fired against an
   * instance somebody has since paused.
   */
  async onTimerFired(jobId: string): Promise<void> {
    const scheduled: NewTimer[] = [];

    await this.writer.write(async () => {
      const timer = await this.repository.findTimerByJobId(jobId);
      if (timer === null) {
        this.logger.debug('A workflow timer fired for a row that no longer exists', { jobId });
        return { result: undefined, change: this.noop(jobId) };
      }
      // A deadline can escalate or auto-approve, both of which change the same rows a person's
      // decision does — so the timer path takes the same lock, in the same order.
      await this.repository.lockInstance(timer.instanceId);
      if (!(await this.repository.markTimerFired(timer.id, this.writer.clock.now()))) {
        return { result: undefined, change: this.noop(jobId) };
      }

      const aggregate = await this.repository.load(timer.instanceId);
      if (aggregate === null || aggregate.instance.status !== WorkflowInstanceStatus.RUNNING) {
        return { result: undefined, change: this.noop(jobId) };
      }
      const stage = aggregate.stages.find((candidate) => candidate.id === timer.stageId);
      if (stage === undefined || stage.status !== WorkflowStageStatus.ACTIVE) {
        return { result: undefined, change: this.noop(jobId) };
      }

      if (timer.kind === WorkflowTimerKind.REMINDER) {
        // A reminder is a notification and nothing else — it changes no state, which is why it is
        // published rather than acted on. Phase 12 consumes it: it publishes `workflow.reminder-due`
        // rather than a second `stage-activated`, because "this is still waiting for you" and "your
        // approval is needed" are two different things to say to the same person.
        await this.outbox.publish([
          approvalReminderDueEvent(asId<AnyId>(aggregate.instance.id), {
            workflowInstanceId: aggregate.instance.id,
            documentId: aggregate.instance.documentId,
            stageIndex: stage.index,
            stageName: stage.name,
            assigneeIds: aggregate.tasks
              .filter(
                (task) => task.stageId === stage.id && task.state === ApprovalTaskState.PENDING,
              )
              .map((task) => task.assigneeId),
            dueAt: stage.dueAt?.toISOString() ?? null,
          }),
        ]);
        return { result: undefined, change: this.noop(jobId) };
      }

      return this.onOverdue(aggregate, stage, scheduled);
    });

    await this.timers.enqueue(scheduled);
  }

  // --- Internals ---------------------------------------------------------------------------

  /**
   * What a passed deadline does, per the stage's `onOverdue`.
   *
   * §5's table, in one place. `AUTO_APPROVE` is the one worth reading twice: it is permitted only
   * for a stage the definition marked non-controlling — the schema requires the flag and requires
   * it to be `true` — and every auto-approval is audited under its own action, because an approval
   * nobody made is the entry an auditor will want to find by searching for it.
   */
  private async onOverdue(
    aggregate: WorkflowAggregate,
    stage: WorkflowStageRecord,
    scheduled: NewTimer[],
  ): Promise<{ result: undefined; change: AdministrativeChange }> {
    const definition = await this.definitionFor(aggregate.instance.workflowVersionId);
    const authored = definition?.stages[stage.index];
    const behaviour = authored?.onOverdue ?? { action: OverdueAction.NOTIFY_ONLY };
    const now = this.writer.clock.now();
    const pending = aggregate.tasks.filter(
      (task) => task.stageId === stage.id && task.state === ApprovalTaskState.PENDING,
    );

    switch (behaviour.action) {
      case OverdueAction.TERMINATE:
        await this.endWithin(
          aggregate,
          WorkflowInstanceStatus.CANCELLED,
          WorkflowCancellationReason.ADMINISTRATIVE,
          DocumentStatus.DRAFT,
        );
        return {
          result: undefined,
          change: {
            action: WorkflowAudit.WITHDRAWN,
            subjectType: AuditSubjectType.WORKFLOW,
            subjectId: asId<AnyId>(aggregate.instance.id),
            operation: AdministrativeOperation.UPDATED,
            after: { reason: 'DEADLINE_TERMINATE', stageIndex: stage.index },
          },
        };

      case OverdueAction.AUTO_APPROVE: {
        for (const task of pending) {
          await this.repository.decideIfPending({
            taskId: task.id,
            decision: TaskDecision.APPROVED,
            // The system decided, and the trail says so rather than naming a person who did not.
            decidedById: task.assigneeId,
            onBehalfOfId: null,
            // The system decided under no delegation, and the trail must not imply one.
            delegationId: null,
            comment: 'Approved automatically when the stage deadline passed.',
            at: now,
            autoDecided: true,
          });
        }
        await this.settleStage(
          await this.requireAggregate(aggregate.instance.id),
          stage,
          scheduled,
        );
        return {
          result: undefined,
          change: {
            action: WorkflowAudit.AUTO_APPROVED,
            subjectType: AuditSubjectType.WORKFLOW,
            subjectId: asId<AnyId>(aggregate.instance.id),
            operation: AdministrativeOperation.UPDATED,
            after: {
              stageIndex: stage.index,
              stageName: stage.name,
              taskIds: pending.map((task) => task.id),
              nonControlling: true,
            },
          },
        };
      }

      case OverdueAction.ESCALATE: {
        const escalations = await this.escalate(aggregate, stage, authored, pending, scheduled);
        return {
          result: undefined,
          change: {
            action: WorkflowAudit.ESCALATED,
            subjectType: AuditSubjectType.WORKFLOW,
            subjectId: asId<AnyId>(aggregate.instance.id),
            operation: AdministrativeOperation.UPDATED,
            after: {
              stageIndex: stage.index,
              stageName: stage.name,
              escalatedTo: escalations.to,
              keptOriginal: escalations.keptOriginal,
              escalationCount: escalations.count,
              capped: escalations.capped,
            },
          },
        };
      }

      default:
        // `NOTIFY_ONLY`. The stage stays exactly as it was and somebody is told, which is a
        // notification rather than a state change — so it goes to the outbox and nowhere else.
        await this.outbox.publish([
          approvalOverdueEvent(asId<AnyId>(aggregate.instance.id), {
            workflowInstanceId: aggregate.instance.id,
            documentId: aggregate.instance.documentId,
            stageIndex: stage.index,
            stageName: stage.name,
            assigneeIds: pending.map((task) => task.assigneeId),
            dueAt: stage.dueAt?.toISOString() ?? null,
          }),
        ]);
        return { result: undefined, change: this.noop(aggregate.instance.id) };
    }
  }

  /**
   * Creates a task for whoever the stage's escalation target resolves to.
   *
   * `keepOriginal` decides whether the person who missed the deadline can still decide, and it
   * defaults to true: taking somebody's task away the moment they are an hour late is a policy a
   * tenant can choose and not one to impose.
   *
   * `maxEscalations` caps the loop. Beyond it the instance is left alone and flagged in the audit
   * payload, per §5's last row — because the alternative to a cap is an approval that escalates up
   * an org chart until it runs out of managers.
   */
  private async escalate(
    aggregate: WorkflowAggregate,
    stage: WorkflowStageRecord,
    authored: WorkflowStage | undefined,
    pending: readonly { readonly id: ApprovalTaskId; readonly assigneeId: UserId }[],
    scheduled: NewTimer[],
  ): Promise<{ to: readonly string[]; keptOriginal: boolean; count: number; capped: boolean }> {
    const behaviour = authored?.onOverdue;
    const cap = authored?.maxEscalations ?? 0;
    if (behaviour?.action !== OverdueAction.ESCALATE) {
      return {
        to: [],
        keptOriginal: true,
        count: aggregate.instance.escalationCount,
        capped: false,
      };
    }
    if (aggregate.instance.escalationCount >= cap) {
      return {
        to: [],
        keptOriginal: true,
        count: aggregate.instance.escalationCount,
        capped: true,
      };
    }

    const context = await this.requireContextFor(aggregate.instance.documentId);
    // Resolved against the *current* assignees, which is what `MANAGER_OF: ASSIGNEE` means here and
    // is the one place that subject has a well-defined answer.
    const targets = await this.participants.resolve(
      [behaviour.to],
      { ...context, authorUserId: pending[0]?.assigneeId ?? context.authorUserId },
      stage.name,
      pending.map((task) => task.assigneeId),
    );

    const existing = new Set(
      aggregate.tasks.filter((task) => task.stageId === stage.id).map((task) => task.assigneeId),
    );
    const fresh = targets.filter((target) => !existing.has(target.userId));
    const count = await this.repository.recordEscalation(aggregate.instance.id);

    if (fresh.length > 0) {
      await this.repository.createTasks(
        fresh.map((target) => ({
          id: this.writer.clock.nextId(),
          instanceId: aggregate.instance.id,
          stageId: stage.id,
          assigneeId: target.userId,
          resolvedBy: `ESCALATION:${target.resolvedBy}`,
          // Zero, so an escalation is decidable immediately even in an ordered stage. An escalation
          // placed at the end of a sequence would be an escalation nobody can act on.
          sequence: 0,
          dueAt: stage.dueAt,
          escalatedFromId: pending[0]?.id ?? null,
        })),
      );
    }

    if (behaviour.keepOriginal !== true) {
      await this.repository.closePendingTasks(stage.id, ApprovalTaskState.WITHDRAWN);
      // Reopened for the escalation targets only: `closePendingTasks` withdrew everything pending,
      // including the tasks just created, so they are created after it rather than before. Doing it
      // in this order would be the subtle bug; doing it in the other is why the order is stated.
    }

    for (const target of fresh) {
      await this.outbox.publish([
        approvalTaskEscalatedEvent(asId<AnyId>(aggregate.instance.id), {
          taskId: pending[0]?.id ?? aggregate.instance.id,
          fromAssigneeId: pending[0]?.assigneeId ?? '',
          toAssigneeId: target.userId,
          dueAt: (stage.dueAt ?? this.writer.clock.now()).toISOString(),
        }),
      ]);
    }

    void scheduled;
    return {
      to: fresh.map((target) => target.userId),
      keptOriginal: behaviour.keepOriginal !== false,
      count,
      capped: false,
    };
  }

  /**
   * Re-evaluates a stage after a decision, and moves the instance accordingly.
   *
   * The one place the completion rule is consulted, so `ALL`, `ANY`, `QUORUM` and `PERCENT` differ
   * by arithmetic rather than by control flow.
   */
  private async settleStage(
    aggregate: WorkflowAggregate,
    stage: WorkflowStageRecord,
    scheduled: NewTimer[],
  ): Promise<StageOutcomeKey> {
    const tasks = aggregate.tasks.filter((task) => task.stageId === stage.id);
    const outcome = evaluateStage(
      { rule: stage.completionRule, threshold: stage.threshold },
      tasks,
    );
    if (outcome === StageOutcome.PENDING) {
      return outcome;
    }

    const now = this.writer.clock.now();
    await this.timers.cancelStage(stage.id);

    if (outcome === StageOutcome.APPROVED) {
      // Everybody who had not decided is superseded rather than withdrawn: their task was made
      // unnecessary by a rule the definition chose, which is a different fact from an approval that
      // was taken away from them (§2, `ANY`).
      await this.repository.closePendingTasks(stage.id, ApprovalTaskState.SUPERSEDED);
      await this.repository.completeStage(stage.id, now);

      const context = await this.requireContextFor(aggregate.instance.documentId);
      const definition = await this.definitionFor(aggregate.instance.workflowVersionId);
      if (definition === null) {
        throw new NotFoundError('The workflow version this approval is running under');
      }
      const approvers = tasks
        .filter((task) => task.decision === TaskDecision.APPROVED)
        .map((task) => task.assigneeId);
      const advanced = await this.advanceFrom(
        await this.requireAggregate(aggregate.instance.id),
        stage.index + 1,
        context,
        definition,
        approvers,
      );
      scheduled.push(...advanced.timers);
      return outcome;
    }

    // Rejected, changes requested, or a threshold that can no longer be met. What each does to the
    // instance is the definition's `onReject`, which is authored per stage.
    const definition = await this.definitionFor(aggregate.instance.workflowVersionId);
    const authored = definition?.stages[stage.index];
    const returnToAuthor =
      outcome === StageOutcome.CHANGES_REQUESTED ||
      authored?.onReject === RejectBehaviour.RETURN_TO_AUTHOR;

    await this.repository.closePendingTasks(stage.id, ApprovalTaskState.WITHDRAWN);
    await this.repository.completeStage(stage.id, now);
    await this.repository.cancelRemainingStages(aggregate.instance.id, stage.index + 1);
    await this.timers.cancelInstance(aggregate.instance.id);

    // The pending number this approval held, if any, is spent — never issued and never reused.
    // Voided in the same transaction as the refusal, so no reading ever sees a rejected document
    // still holding a live pending reference (§2 of `09-numbering-architecture.md`).
    if (this.numbering !== null) {
      await this.numbering.voidReservation({
        documentId: aggregate.instance.documentId,
        workflowInstanceId: aggregate.instance.id,
        reason: outcome,
      });
    }

    if (returnToAuthor) {
      await this.repository.endInstance({
        instanceId: aggregate.instance.id,
        status: WorkflowInstanceStatus.CANCELLED,
        reason: WorkflowCancellationReason.RETURNED,
        at: now,
        numberAssigned: false,
      });
      await this.documents.transition({
        documentId: aggregate.instance.documentId,
        to: DocumentStatus.CHANGES_REQUESTED,
        workflowInstanceId: aggregate.instance.id,
        reason: outcome,
      });
    } else {
      await this.repository.endInstance({
        instanceId: aggregate.instance.id,
        status: WorkflowInstanceStatus.REJECTED,
        reason: outcome,
        at: now,
        numberAssigned: false,
      });
      await this.documents.transition({
        documentId: aggregate.instance.documentId,
        to: DocumentStatus.REJECTED,
        workflowInstanceId: aggregate.instance.id,
        reason: outcome,
      });
    }

    await this.outbox.publish([
      workflowCancelledEvent(asId<AnyId>(aggregate.instance.id), {
        workflowInstanceId: aggregate.instance.id,
        documentId: aggregate.instance.documentId,
        reason: outcome,
      }),
    ]);
    return outcome;
  }

  /**
   * Activates the first stage at or after `fromIndex` whose condition holds, or completes.
   *
   * A loop rather than a recursion, and the loop is where conditional workflow lives: a stage whose
   * condition is false is `SKIPPED` and the next one is tried. A definition whose every remaining
   * stage is scoped away completes the instance, which is correct — the document passed every
   * control that applied to it.
   */
  private async advanceFrom(
    aggregate: WorkflowAggregate,
    fromIndex: number,
    context: DocumentApprovalContext,
    definition: WorkflowDefinitionBody,
    previousApprovers: readonly UserId[],
  ): Promise<{ status: DocumentStatusKey; timers: readonly NewTimer[] }> {
    const now = this.writer.clock.now();
    const timers: NewTimer[] = [];

    for (let index = fromIndex; index < aggregate.stages.length; index += 1) {
      const stage = aggregate.stages[index];
      const authored = definition.stages[index];
      if (stage === undefined || authored === undefined) {
        break;
      }

      if (authored.condition !== null && !evaluateCondition(authored.condition, context.facts)) {
        await this.repository.skipStage(stage.id, StageSkipReason.CONDITION_FALSE, now);
        continue;
      }

      // Resolved *now*, at activation, against this document — never at definition time, and never
      // reused from an earlier stage (§2). A resolver that yields nobody throws, which fails the
      // whole submission rather than skipping a control (§8).
      const resolved = await this.participants.resolve(
        authored.participants,
        context,
        authored.name,
        previousApprovers,
      );

      const calendar = await this.calendars.forEntity(context.entityId);
      const planned = this.timers.plan({
        instanceId: aggregate.instance.id,
        stageId: stage.id,
        taskIds: [],
        deadline: authored.deadline,
        reminders: authored.reminders,
        from: now,
        calendar,
      });

      const tasks: NewTask[] = resolved.map((participant, position) => ({
        id: this.writer.clock.nextId(),
        instanceId: aggregate.instance.id,
        stageId: stage.id,
        assigneeId: participant.userId,
        resolvedBy: participant.resolvedBy,
        // The position in the resolved list *is* the sequence in an ordered stage, which is why
        // resolution preserves the order the definition names its resolvers in.
        sequence: stage.ordered ? position : 0,
        dueAt: planned.dueAt,
        escalatedFromId: null,
      }));
      await this.repository.createTasks(tasks);

      // Re-planned with the task identifiers, because a reminder is per task: "each fires once,
      // recorded on the task" (§6), and a stage-wide reminder could not record that.
      const withTasks = this.timers.plan({
        instanceId: aggregate.instance.id,
        stageId: stage.id,
        taskIds: tasks.map((task) => task.id),
        deadline: authored.deadline,
        reminders: authored.reminders,
        from: now,
        calendar,
      });
      await this.repository.createTimers(withTasks.timers);
      timers.push(...withTasks.timers);

      await this.repository.activateStage(stage.id, now, withTasks.dueAt);
      await this.repository.moveToStage(aggregate.instance.id, index);
      await this.documents.transition({
        documentId: context.documentId,
        to: DocumentStatus.UNDER_REVIEW,
        workflowInstanceId: aggregate.instance.id,
        reason: null,
      });
      await this.outbox.publish([
        workflowStageActivatedEvent(asId<AnyId>(aggregate.instance.id), {
          workflowInstanceId: aggregate.instance.id,
          stageIndex: index,
          assigneeIds: tasks.map((task) => task.assigneeId),
          dueAt: withTasks.dueAt?.toISOString() ?? null,
        }),
        // Beside it rather than instead of it: `stage-activated` is the *workflow* fact and is
        // wanted whether or not anybody is told, while this one is addressed to the people who
        // now have work and carries what a notification needs to name it (18 §4's first row).
        approvalTaskAssignedEvent(asId<AnyId>(aggregate.instance.id), {
          workflowInstanceId: aggregate.instance.id,
          documentId: context.documentId,
          stageIndex: index,
          stageName: authored.name,
          assigneeIds: tasks.map((task) => task.assigneeId),
          dueAt: withTasks.dueAt?.toISOString() ?? null,
        }),
      ]);

      return { status: DocumentStatus.UNDER_REVIEW, timers };
    }

    await this.complete(aggregate, definition);
    return { status: DocumentStatus.APPROVED, timers };
  }

  /**
   * Every stage passed.
   *
   * The number is assigned here and nowhere earlier: [ADR-0004] reserves at submission and
   * assigns at approval, and §8 forbids assigning one before the final stage completes. The
   * allocator commits the submission's reservation — or draws now, for a rule that reserves
   * nothing — inside this same transaction. This path did not change when Phase 5 bound the
   * allocator; only unbound compositions still record `numberAssigned: false`.
   */
  private async complete(
    aggregate: WorkflowAggregate,
    definition: WorkflowDefinitionBody,
  ): Promise<void> {
    const now = this.writer.clock.now();
    let numberAssigned = false;

    if (definition.onComplete.assignNumber && this.numbering !== null) {
      const allocated = await this.numbering.assignAtApproval({
        documentId: aggregate.instance.documentId,
        workflowInstanceId: aggregate.instance.id,
      });
      numberAssigned = allocated.documentNumber.length > 0;
    }

    await this.repository.endInstance({
      instanceId: aggregate.instance.id,
      status: WorkflowInstanceStatus.COMPLETED,
      reason: null,
      at: now,
      numberAssigned,
    });
    await this.timers.cancelInstance(aggregate.instance.id);
    await this.documents.transition({
      documentId: aggregate.instance.documentId,
      to: DocumentStatus.APPROVED,
      workflowInstanceId: aggregate.instance.id,
      reason: null,
    });
    await this.outbox.publish([
      workflowCompletedEvent(asId<AnyId>(aggregate.instance.id), {
        workflowInstanceId: aggregate.instance.id,
        documentId: aggregate.instance.documentId,
        stagesCompleted: aggregate.stages.filter(
          (stage) => stage.status === WorkflowStageStatus.COMPLETED,
        ).length,
      }),
    ]);
  }

  private async end(
    instanceId: WorkflowInstanceId,
    reason: WorkflowCancellationReasonKey,
    note: string | null,
    to: DocumentStatusKey,
  ): Promise<void> {
    await this.writer.write(async () => {
      await this.lock(instanceId);
      const aggregate = await this.requireAggregate(instanceId);
      if (
        aggregate.instance.status !== WorkflowInstanceStatus.RUNNING &&
        aggregate.instance.status !== WorkflowInstanceStatus.PAUSED
      ) {
        throw new ValidationError('This approval has already ended.', [
          { field: 'status', message: aggregate.instance.status },
        ]);
      }
      const decided = aggregate.tasks.some((task) => task.decision !== null);
      if (decided && reason === WorkflowCancellationReason.WITHDRAWN) {
        // A withdrawal takes back a request nobody has answered. Once somebody has decided, taking
        // the document back would erase a recorded decision from the process it belonged to — so an
        // author asks for it to be cancelled administratively instead, which is audited as such.
        throw new ValidationError(
          'Somebody has already decided; this can no longer be withdrawn.',
          [{ field: 'tasks', message: 'decided' }],
        );
      }

      await this.endWithin(aggregate, WorkflowInstanceStatus.CANCELLED, reason, to);
      if (note !== null) {
        await this.repository.addComment({
          id: this.writer.clock.nextId(),
          instanceId,
          documentId: aggregate.instance.documentId,
          stageId: null,
          taskId: null,
          authorId: this.requireActor(),
          body: note,
          decision: null,
          at: this.writer.clock.now(),
        });
      }

      return {
        result: undefined,
        change: {
          action: WorkflowAudit.WITHDRAWN,
          subjectType: AuditSubjectType.WORKFLOW,
          subjectId: asId<AnyId>(instanceId),
          operation: AdministrativeOperation.UPDATED,
          before: { status: aggregate.instance.status },
          after: { status: WorkflowInstanceStatus.CANCELLED, reason, note, documentStatus: to },
        },
      };
    });
  }

  private async endWithin(
    aggregate: WorkflowAggregate,
    status: typeof WorkflowInstanceStatus.CANCELLED,
    reason: WorkflowCancellationReasonKey,
    to: DocumentStatusKey,
  ): Promise<void> {
    const now = this.writer.clock.now();
    for (const stage of aggregate.stages) {
      if (stage.status === WorkflowStageStatus.ACTIVE) {
        await this.repository.closePendingTasks(stage.id, ApprovalTaskState.WITHDRAWN);
      }
    }
    await this.repository.cancelRemainingStages(aggregate.instance.id, 0);
    await this.timers.cancelInstance(aggregate.instance.id);
    // Withdrawal and cancellation void the reservation exactly as a rejection does: the value
    // is spent and never returns to the pool.
    if (this.numbering !== null) {
      await this.numbering.voidReservation({
        documentId: aggregate.instance.documentId,
        workflowInstanceId: aggregate.instance.id,
        reason,
      });
    }
    await this.repository.endInstance({
      instanceId: aggregate.instance.id,
      status,
      reason,
      at: now,
      numberAssigned: false,
    });
    await this.documents.transition({
      documentId: aggregate.instance.documentId,
      to,
      workflowInstanceId: aggregate.instance.id,
      reason,
    });
    await this.outbox.publish([
      workflowCancelledEvent(asId<AnyId>(aggregate.instance.id), {
        workflowInstanceId: aggregate.instance.id,
        documentId: aggregate.instance.documentId,
        reason,
      }),
    ]);
  }

  /**
   * Whether a definition's own `appliesTo` covers this document.
   *
   * Both halves have to hold: the type list, when it names any, and the condition, when there is
   * one. An empty type list means every type, which is what the schema's default says.
   */
  private appliesTo(definition: WorkflowDefinitionBody, context: DocumentApprovalContext): boolean {
    const types = definition.appliesTo.documentTypes;
    const typeCode = context.facts.get('documentType.code');
    if (types.length > 0 && (typeof typeCode !== 'string' || !types.includes(typeCode))) {
      return false;
    }
    return (
      definition.appliesTo.condition === null ||
      evaluateCondition(definition.appliesTo.condition, context.facts)
    );
  }

  private async definitionFor(
    versionId: WorkflowVersionId,
  ): Promise<WorkflowDefinitionBody | null> {
    const version = await this.versions.versionById(versionId);
    return version?.definition ?? null;
  }

  /** The row lock every write path takes first. Missing means gone, which is a 404. */
  private async lock(id: WorkflowInstanceId): Promise<void> {
    if (!(await this.repository.lockInstance(id))) {
      throw new NotFoundError('The requested approval');
    }
  }

  private async requireAggregate(id: WorkflowInstanceId): Promise<WorkflowAggregate> {
    const aggregate = await this.repository.load(id);
    if (aggregate === null) {
      throw new NotFoundError('The requested approval');
    }
    return aggregate;
  }

  private async requireContextFor(documentId: DocumentId): Promise<DocumentApprovalContext> {
    const context = await this.documents.contextFor(documentId);
    if (context === null) {
      throw new NotFoundError('The requested resource');
    }
    return context;
  }

  private requireStage(aggregate: WorkflowAggregate, stageId: string): WorkflowStageRecord {
    const stage = aggregate.stages.find((candidate) => candidate.id === stageId);
    if (stage === undefined) {
      throw new NotFoundError('The requested stage');
    }
    return stage;
  }

  private requireActor(): UserId {
    const { userId } = requireContext();
    if (userId === null) {
      // Approvals are made by people. The system escalates and auto-approves, and both of those go
      // through paths that name the assignee rather than the actor.
      throw new ForbiddenError('act on an approval without a signed-in user');
    }
    return userId;
  }

  /**
   * An audit entry for a timer that changed nothing.
   *
   * Written rather than skipped, because a fired timer *is* a fact about the approval and the trail
   * must not be able to say "nothing happened" when a deadline passed. `AdministeredWriter` writes
   * exactly one event per transaction, so this is what a no-op firing records.
   */
  private noop(subject: string): AdministrativeChange {
    return {
      action: WorkflowAudit.TIMER_FIRED,
      subjectType: AuditSubjectType.WORKFLOW,
      subjectId: asId<AnyId>(subject),
      operation: AdministrativeOperation.UPDATED,
      after: { effect: 'none' },
    };
  }
}

/**
 * The permission a decision exercises — Phase 11.
 *
 * The catalogue and 08 §6's matrix treat approving and rejecting as two grants, and the approval
 * controller already enforces the second separately on the same route. A delegation covering
 * `document:approve` therefore does not authorise a rejection, and naming the permission here is
 * what makes that true of a delegate as well as of an assignee. `CHANGES_REQUESTED` is a refusal
 * that sends a document back, so it takes the same key as a rejection.
 */
function permissionFor(decision: TaskDecisionKey): PermissionKey {
  return decision === TaskDecision.APPROVED
    ? Permission.DOCUMENT_APPROVE
    : Permission.DOCUMENT_REJECT;
}

function auditActionFor(decision: TaskDecisionKey): string {
  switch (decision) {
    case TaskDecision.APPROVED:
      return WorkflowAudit.APPROVED;
    case TaskDecision.REJECTED:
      return WorkflowAudit.REJECTED;
    default:
      return WorkflowAudit.CHANGES_REQUESTED;
  }
}

export { describe as describeParticipant };
