import type {
  ApprovalTaskId,
  PermissionKey,
  ApprovalTaskStateKey,
  DocumentId,
  DocumentStatusKey,
  ManagerOfSubjectKey,
  RevisionId,
  StageCompletionRuleKey,
  StageSkipReasonKey,
  TaskDecisionKey,
  UserId,
  WorkflowCancellationReasonKey,
  WorkflowDefinitionId,
  WorkflowInstanceId,
  WorkflowInstanceStatusKey,
  WorkflowPauseReasonKey,
  WorkflowStageId,
  WorkflowStageStatusKey,
  WorkflowTimerKindKey,
  WorkflowTimerStateKey,
  WorkflowVersionId,
  WorkingCalendarView,
} from '@edms/domain';
import type { Page, PageRequest } from '@edms/utils';

import type { FactValue } from '../domain/conditions';

/**
 * What the engine reads and writes.
 *
 * Approval is configuration, not code: definitions are versioned data, and an instance binds to a
 * **version**, so editing a definition never mutates a running approval
 * (`docs/architecture/adr/0006-declarative-workflow-engine.md`).
 *
 * The Phase 0.5 sketch of this file returned `unknown` from three repositories and described an
 * engine that did not exist. It is replaced rather than filled in, because the shape it guessed at
 * was wrong in one way worth recording: it had a repository per aggregate — instance, stage, task —
 * and the engine's every write touches all three in one transaction. Three repositories would have
 * put the job of keeping them consistent into the service, which is precisely the invariant the
 * aggregate boundary exists to hold. There is one repository for the instance and everything under
 * it, and a separate read side for the screens.
 */
export const WORKFLOW_ENGINE_REPOSITORY = Symbol('WorkflowEngineRepository');
export const APPROVAL_QUERY_REPOSITORY = Symbol('ApprovalQueryRepository');
export const WORKFLOW_ENGINE = Symbol('WorkflowEngine');
export const APPROVAL_SERVICE = Symbol('ApprovalService');

// --- The aggregate, as the engine holds it ----------------------------------------------------

export interface WorkflowInstanceRecord {
  readonly id: WorkflowInstanceId;
  readonly documentId: DocumentId;
  readonly revisionId: RevisionId;
  readonly definitionId: WorkflowDefinitionId;
  readonly workflowVersionId: WorkflowVersionId;
  readonly status: WorkflowInstanceStatusKey;
  readonly currentStageIndex: number;
  readonly startedAt: Date;
  readonly startedBy: string | null;
  readonly endedAt: Date | null;
  readonly endReason: string | null;
  readonly pausedAt: Date | null;
  readonly pauseReason: string | null;
  readonly escalationCount: number;
  readonly numberAssigned: boolean;
  readonly version: number;
}

export interface WorkflowStageRecord {
  readonly id: WorkflowStageId;
  readonly instanceId: WorkflowInstanceId;
  readonly index: number;
  readonly name: string;
  readonly completionRule: StageCompletionRuleKey;
  readonly threshold: number | null;
  readonly ordered: boolean;
  readonly status: WorkflowStageStatusKey;
  readonly activatedAt: Date | null;
  readonly completedAt: Date | null;
  readonly dueAt: Date | null;
  readonly skipReason: StageSkipReasonKey | null;
}

export interface ApprovalTaskRecord {
  readonly id: ApprovalTaskId;
  readonly instanceId: WorkflowInstanceId;
  readonly stageId: WorkflowStageId;
  readonly assigneeId: UserId;
  /** Which resolver produced this assignee — the answer to "why am I being asked to approve this". */
  readonly resolvedBy: string;
  readonly sequence: number;
  readonly state: ApprovalTaskStateKey;
  readonly decision: TaskDecisionKey | null;
  readonly decidedById: UserId | null;
  /** Set when the decision was taken under a delegation; the audit records both people. */
  readonly onBehalfOfId: UserId | null;
  /**
   * Which delegation authorised it — Phase 11.
   *
   * A third identifier rather than an inference from the pair above, because two people may have
   * delegated to each other more than once and "under which arrangement" is what an investigation
   * into a since-revoked delegation asks.
   */
  readonly delegationId: string | null;
  readonly decidedAt: Date | null;
  readonly comment: string | null;
  readonly dueAt: Date | null;
  readonly escalatedFromId: ApprovalTaskId | null;
  readonly autoDecided: boolean;
  readonly createdAt: Date;
}

/** An instance with everything under it, which is the only unit the engine ever loads. */
export interface WorkflowAggregate {
  readonly instance: WorkflowInstanceRecord;
  readonly stages: readonly WorkflowStageRecord[];
  readonly tasks: readonly ApprovalTaskRecord[];
}

export interface WorkflowTimerRecord {
  readonly id: string;
  readonly instanceId: WorkflowInstanceId;
  readonly stageId: WorkflowStageId;
  readonly taskId: ApprovalTaskId | null;
  readonly kind: WorkflowTimerKindKey;
  readonly state: WorkflowTimerStateKey;
  readonly fireAt: Date;
  readonly remainingMs: number | null;
  readonly offset: string | null;
  readonly jobId: string;
}

export interface NewInstance {
  readonly id: string;
  readonly documentId: string;
  readonly revisionId: string;
  readonly definitionId: string;
  readonly workflowVersionId: string;
  readonly startedAt: Date;
}

export interface NewStage {
  readonly id: string;
  readonly instanceId: string;
  readonly index: number;
  readonly name: string;
  readonly completionRule: StageCompletionRuleKey;
  readonly threshold: number | null;
  readonly ordered: boolean;
}

export interface NewTask {
  readonly id: string;
  readonly instanceId: string;
  readonly stageId: string;
  readonly assigneeId: string;
  readonly resolvedBy: string;
  readonly sequence: number;
  readonly dueAt: Date | null;
  readonly escalatedFromId: string | null;
}

export interface NewTimer {
  readonly id: string;
  readonly instanceId: string;
  readonly stageId: string;
  readonly taskId: string | null;
  readonly kind: WorkflowTimerKindKey;
  readonly fireAt: Date;
  readonly offset: string | null;
  readonly jobId: string;
}

/**
 * Everything the engine writes.
 *
 * One repository rather than one per table, because every operation the engine performs touches
 * the instance, its current stage and its tasks in the same transaction: activating a stage creates
 * tasks and moves the instance's cursor; a decision that completes a stage supersedes the other
 * tasks and either activates the next stage or ends the instance. Splitting that across three
 * repositories would move the consistency into the caller.
 */
export interface WorkflowEngineRepository {
  /**
   * Takes a row lock on the instance, and returns false if there is no such instance.
   *
   * Every write path calls this **first**, and it is what makes the completion rule correct under
   * concurrency. Two approvers deciding at the same instant run in two transactions, and under
   * `READ COMMITTED` neither can see the other's uncommitted decision — so both would evaluate the
   * stage against one approval and a two-person quorum would be met while the stage stayed pending
   * forever. Serialising on the instance means the second decision waits, then re-reads, then sees
   * the first and completes the stage.
   *
   * The instance is the lock for the whole aggregate, and it is always taken first, so two
   * concurrent decisions on one approval cannot deadlock by acquiring rows in different orders.
   */
  lockInstance(id: WorkflowInstanceId): Promise<boolean>;
  /** The instance a task belongs to, without loading the aggregate — so the lock can be taken. */
  instanceIdOfTask(taskId: ApprovalTaskId): Promise<WorkflowInstanceId | null>;
  /** The whole aggregate, or null. The engine never reads a task without its instance. */
  load(id: WorkflowInstanceId): Promise<WorkflowAggregate | null>;
  loadByTask(taskId: ApprovalTaskId): Promise<WorkflowAggregate | null>;
  /** The live attempt on a document — `RUNNING` or `PAUSED`. At most one, by unique index. */
  loadLiveForDocument(documentId: DocumentId): Promise<WorkflowAggregate | null>;

  createInstance(instance: NewInstance): Promise<void>;
  createStages(stages: readonly NewStage[]): Promise<void>;
  createTasks(tasks: readonly NewTask[]): Promise<void>;

  activateStage(stageId: WorkflowStageId, at: Date, dueAt: Date | null): Promise<void>;
  completeStage(stageId: WorkflowStageId, at: Date): Promise<void>;
  skipStage(stageId: WorkflowStageId, reason: StageSkipReasonKey, at: Date): Promise<void>;
  cancelRemainingStages(instanceId: WorkflowInstanceId, fromIndex: number): Promise<void>;

  /**
   * Records a decision only if the task is still undecided.
   *
   * Returns false when zero rows matched, which means somebody decided first. That is a conflict
   * rather than an overwrite: a second decision on one task would count twice toward a quorum, and
   * `07-workflow-architecture.md` §8 names deciding a task twice as something the engine must never
   * do. The `WHERE` clause is what makes the race impossible rather than unlikely — a read followed
   * by a write leaves a window between them however short the transaction is.
   */
  decideIfPending(input: {
    readonly taskId: ApprovalTaskId;
    readonly decision: TaskDecisionKey;
    readonly decidedById: string;
    readonly onBehalfOfId: string | null;
    /** Set with `onBehalfOfId` or with neither — a check constraint refuses one without the other. */
    readonly delegationId: string | null;
    readonly comment: string | null;
    readonly at: Date;
    readonly autoDecided: boolean;
  }): Promise<boolean>;

  /** Ends the tasks a completed or abandoned stage leaves behind. Never touches a decided one. */
  closePendingTasks(stageId: WorkflowStageId, state: ApprovalTaskStateKey): Promise<number>;

  endInstance(input: {
    readonly instanceId: WorkflowInstanceId;
    readonly status: WorkflowInstanceStatusKey;
    readonly reason: string | null;
    readonly at: Date;
    readonly numberAssigned: boolean;
  }): Promise<void>;
  moveToStage(instanceId: WorkflowInstanceId, index: number): Promise<void>;
  setPaused(input: {
    readonly instanceId: WorkflowInstanceId;
    readonly paused: boolean;
    readonly reason: WorkflowPauseReasonKey | null;
    readonly at: Date;
  }): Promise<void>;
  recordEscalation(instanceId: WorkflowInstanceId): Promise<number>;

  addComment(input: {
    readonly id: string;
    readonly instanceId: string;
    readonly documentId: string;
    readonly stageId: string | null;
    readonly taskId: string | null;
    readonly authorId: string;
    readonly body: string;
    readonly decision: TaskDecisionKey | null;
    readonly at: Date;
  }): Promise<void>;

  // --- Timers ---
  //
  // Rows as well as jobs, because three questions have no answer in a queue: which timers belong
  // to this stage, what did this one have left when the instance paused, and has this reminder
  // already fired (§6).
  createTimers(timers: readonly NewTimer[]): Promise<void>;
  timersFor(
    instanceId: WorkflowInstanceId,
    states: readonly WorkflowTimerStateKey[],
  ): Promise<readonly WorkflowTimerRecord[]>;
  findTimerByJobId(jobId: string): Promise<WorkflowTimerRecord | null>;
  markTimerFired(id: string, at: Date): Promise<boolean>;
  cancelTimersForStage(stageId: WorkflowStageId): Promise<readonly WorkflowTimerRecord[]>;
  cancelTimersForInstance(instanceId: WorkflowInstanceId): Promise<readonly WorkflowTimerRecord[]>;
  pauseTimers(instanceId: WorkflowInstanceId, now: Date): Promise<readonly WorkflowTimerRecord[]>;
  resumeTimers(instanceId: WorkflowInstanceId, now: Date): Promise<readonly WorkflowTimerRecord[]>;
}

// --- The read side ----------------------------------------------------------------------------

export interface ApprovalInboxRequest extends PageRequest {
  readonly assigneeId: string;
  /**
   * Whom this caller is covering, and under which delegation — Phase 11.
   *
   * Passed in rather than resolved in the repository, because who may be covered is Identity's
   * answer and a read model that asked it would be a read model holding a policy. Empty for the
   * ordinary case, which is the ordinary query unchanged.
   */
  readonly cover?: readonly DelegatorCover[] | undefined;
  readonly state?: ApprovalTaskStateKey | undefined;
  readonly overdue?: boolean | undefined;
  readonly sortBy?: string | undefined;
  readonly sortDirection: 'asc' | 'desc';
}

export interface ApprovalInboxRow {
  readonly task: ApprovalTaskRecord;
  /**
   * Set when this row is here because the caller holds a delegation, not because the task is
   * theirs. The task is still the assignee's — nothing moved — so this is what tells the screen to
   * render "on behalf of" rather than the reader having to compare identifiers.
   */
  readonly onBehalfOf?: { readonly delegationId: string; readonly delegatorId: string } | undefined;
  readonly stage: WorkflowStageRecord;
  readonly documentId: string;
  readonly documentTitle: string;
  readonly documentNumber: string | null;
  readonly documentTypeName: string;
  readonly assigneeName: string | null;
  readonly decidedByName: string | null;
}

export interface WorkflowCommentRow {
  readonly id: string;
  readonly authorId: string;
  readonly authorName: string | null;
  readonly stageId: string | null;
  readonly taskId: string | null;
  readonly body: string;
  readonly decision: TaskDecisionKey | null;
  readonly createdAt: Date;
}

export interface WorkflowInstanceView {
  readonly instance: WorkflowInstanceRecord;
  readonly revisionLabel: string;
  readonly definitionKey: string;
  readonly definitionName: string;
  readonly workflowVersion: number;
  readonly stages: readonly WorkflowStageRecord[];
  readonly tasks: readonly ApprovalTaskRecord[];
  readonly people: ReadonlyMap<string, string>;
  readonly comments: readonly WorkflowCommentRow[];
}

/** The screens' read side. Separate from the engine's repository, and deliberately read-only. */
export interface ApprovalQueryRepository {
  inbox(request: ApprovalInboxRequest): Promise<Page<ApprovalInboxRow>>;
  /** Every attempt on a document, newest first. A rejected one is history, never a deleted row. */
  instancesForDocument(documentId: DocumentId): Promise<readonly WorkflowInstanceView[]>;
  instance(id: WorkflowInstanceId): Promise<WorkflowInstanceView | null>;
  /** How many approvals bound to a version — what makes a published version undeletable. */
  countInstancesByVersion(versionIds: readonly string[]): Promise<ReadonlyMap<string, number>>;
  /** Display names for the people a screen names — the inbox's delegators, Phase 11. */
  displayNames(userIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
}

// --- What the engine needs from other modules -------------------------------------------------

export const WORKFLOW_DOCUMENT_GATE = Symbol('WorkflowDocumentGate');

/**
 * What Workflow needs from Document, in Workflow's own words.
 *
 * Workflow sits below Document in the module order and may call it, so this is an ordinary
 * downward dependency rather than one of Phase 3's inversions. It is a narrow port anyway, for the
 * reason every narrow port here exists: the engine needs to read a document's context and move its
 * status, and holding `DOCUMENT_SERVICE` would also let it move a document to another folder.
 */
export interface WorkflowDocumentGate {
  /**
   * Everything a submission needs to know about the document, in one read.
   *
   * `facts` is the flat, pre-approved map a stage condition is evaluated against — assembled here,
   * by code that knows what it is fetching, rather than resolved by the evaluator. That split is
   * what keeps a tenant-authored expression from reaching anything it was not handed (§2).
   */
  contextFor(documentId: DocumentId): Promise<DocumentApprovalContext | null>;
  /** Moves the document, checking the transition table and writing its own audit event. */
  transition(input: {
    readonly documentId: DocumentId;
    readonly to: DocumentStatusKey;
    readonly workflowInstanceId: string | null;
    readonly reason: string | null;
  }): Promise<void>;
}

export interface DocumentApprovalContext {
  readonly documentId: DocumentId;
  readonly status: DocumentStatusKey;
  readonly title: string;
  readonly documentTypeId: string;
  readonly documentTypeName: string;
  /** Null when the type names no definition — legitimate, and means no approval is required. */
  readonly workflowDefinitionId: string | null;
  readonly ownerUserId: UserId;
  /** Who created it. Distinct from the owner, and `MANAGER_OF: AUTHOR` means this one. */
  readonly authorUserId: UserId | null;
  readonly latestRevisionId: RevisionId | null;
  readonly latestRevisionLabel: string | null;
  /** The document's own entity and department, which scope a `ROLE` resolver. */
  readonly entityId: string | null;
  readonly departmentId: string | null;
  /** Users named by the document's own `USER` metadata fields, keyed by field key. */
  readonly userFields: ReadonlyMap<string, UserId>;
  readonly facts: ReadonlyMap<string, FactValue>;
}

export const WORKFLOW_DIRECTORY = Symbol('WorkflowDirectory');

/**
 * How the engine finds people.
 *
 * §2 resolves participants **at stage activation**, against the document's own context, never at
 * definition time — so an org change does not break a workflow authored before it. Every method
 * here is therefore a question asked at a moment, and none of them is cached.
 *
 * Everything returns live, active users only. A resolver that yielded a disabled account would
 * route an approval to somebody who cannot sign in, and the stage would sit there until it
 * escalated — which looks exactly like somebody ignoring their work.
 */
export interface WorkflowDirectory {
  holdersOfRole(roleKey: string, scope: RoleScope): Promise<readonly UserId[]>;
  membersOfDepartment(departmentId: string, managersOnly: boolean): Promise<readonly UserId[]>;
  managersOf(subject: UserId): Promise<readonly UserId[]>;
  membersOfGroup(groupKey: string): Promise<readonly UserId[]>;
  /** Filters to the users who are live and active. Names the rest, so a refusal can say who. */
  activeAmong(userIds: readonly UserId[]): Promise<readonly UserId[]>;
  displayNames(userIds: readonly UserId[]): Promise<ReadonlyMap<string, string>>;
}

export interface RoleScope {
  readonly kind: 'TENANT' | 'ENTITY' | 'DEPARTMENT';
  /** Null for `TENANT`, and only for it. */
  readonly nodeId: string | null;
}

/** Whose manager a `MANAGER_OF` resolver means, once the engine has resolved it to a person. */
export interface ManagerSubject {
  readonly of: ManagerOfSubjectKey;
  readonly userId: UserId | null;
}

export const WORKFLOW_DELEGATION_GATE = Symbol('WorkflowDelegationGate');

/**
 * What Workflow needs from Identity's delegations, in Workflow's own words — Phase 11.
 *
 * Two questions, and neither can be asked without naming a permission. That is not ceremony: §4
 * requires the delegator's authority to be checked **at decision time**, so a port that could
 * answer "is A a delegate of B" without saying what for would be a port whose cheapest call is the
 * one that permits a delegate to exceed the delegator. There is no such method here.
 *
 * The engine holds this rather than `DELEGATION_SERVICE` for the reason it holds
 * `WORKFLOW_DIRECTORY` rather than `USER_DIRECTORY`: a narrow port is what stops a module growing
 * a dependency on the rest of another one.
 */
export interface WorkflowDelegationGate {
  /**
   * May `actorId` decide a task assigned to `assigneeId`, and under which delegation?
   *
   * Called inside the deciding transaction, after the instance's row lock is taken — so a
   * revocation committed a moment earlier is already visible, and one arriving a moment later
   * waits. `delegationId` null means no; `refusal` says which rule refused, so the approver is
   * told something they can act on rather than a bare 403.
   */
  authorityFor(input: {
    readonly actorId: UserId;
    readonly assigneeId: UserId;
    readonly permission: PermissionKey;
    readonly at: Date;
  }): Promise<DelegatedAuthority>;

  /**
   * Whom this person is currently covering for, given one permission.
   *
   * The inbox's read. It returns delegators rather than tasks, because which tasks follow is
   * Workflow's question — Identity has no business knowing what an approval task is.
   */
  coverFor(input: {
    readonly actorId: UserId;
    readonly permission: PermissionKey;
    readonly at: Date;
  }): Promise<readonly DelegatorCover[]>;
}

export interface DelegatedAuthority {
  readonly delegationId: string | null;
  /** Null when authorised. Otherwise a `DelegationRefusal` key, for the message. */
  readonly refusal: string | null;
}

export interface DelegatorCover {
  readonly delegationId: string;
  readonly delegatorId: UserId;
}

export const WORKFLOW_CALENDAR = Symbol('WorkflowCalendar');

/**
 * The working-day calendar a deadline is counted against (§6).
 *
 * Administration owns the rows; this is the one question the engine asks of them. It takes the
 * document's entity rather than a calendar identifier, because "which calendar applies" is a
 * decision about the organisation and not one a workflow author should have to make per stage.
 */
export interface WorkflowCalendarReader {
  forEntity(entityId: string | null): Promise<WorkingCalendarView>;
}

export const DOCUMENT_NUMBER_ALLOCATOR = Symbol('DocumentNumberAllocator');

/**
 * The seam Phase 4 cut and Phase 5 filled.
 *
 * [ADR-0004](../../../../../docs/architecture/adr/0004-numbering-assigned-at-approval.md) reserves
 * a number at submission and assigns it at approval, and §8 lists "assign a document number before
 * the final stage completes" as something the engine must never do. So the engine calls this at
 * completion, in the same transaction as the approval — and, since Phase 5, at submission to
 * reserve and on every ending-without-approval path to void.
 *
 * The port stays `@Optional` in the engine's constructor, exactly as Phase 4 left it: with
 * nothing bound an approval completes with `numberAssigned: false`, which was the honest outcome
 * for a product without numbering and remains the engine's behaviour under test doubles. The
 * binding lives in this module — an adapter over Document's `DOCUMENT_NUMBER_SERVICE` — and
 * binding it is the whole of what made every completed approval numbered, with no change to the
 * engine's completion path. That was the test of whether the seam was cut correctly.
 */
export interface DocumentNumberAllocator {
  /**
   * Draws the pending number a reviewer refers to, when the document's rule reserves at
   * submission. Null means the rule draws at approval instead — including gapless mode.
   */
  reserveAtSubmission(input: {
    readonly documentId: DocumentId;
    readonly workflowInstanceId: WorkflowInstanceId;
  }): Promise<{ readonly pendingNumber: string | null }>;
  /** Draws and assigns the number, inside the caller's transaction. */
  assignAtApproval(input: {
    readonly documentId: DocumentId;
    readonly workflowInstanceId: WorkflowInstanceId;
  }): Promise<{ readonly documentNumber: string }>;
  /**
   * Voids the instance's reservation, if it holds one. Called on every path that ends an
   * instance without approval — rejection, return to author, withdrawal, cancellation — and the
   * voided value never returns to the pool (§2 of `09-numbering-architecture.md`).
   */
  voidReservation(input: {
    readonly documentId: DocumentId;
    readonly workflowInstanceId: WorkflowInstanceId;
    readonly reason: string;
  }): Promise<void>;
}

// --- The services other modules and controllers call -------------------------------------------

export interface SubmitResult {
  readonly instanceId: WorkflowInstanceId;
  readonly status: DocumentStatusKey;
}

export interface WorkflowEngineService {
  submit(documentId: DocumentId, comment: string | null): Promise<SubmitResult>;
  decide(input: {
    readonly taskId: ApprovalTaskId;
    readonly decision: TaskDecisionKey;
    readonly comment: string | null;
  }): Promise<WorkflowInstanceId>;
  withdraw(documentId: DocumentId, reason: string | null): Promise<void>;
  cancel(
    instanceId: WorkflowInstanceId,
    reason: WorkflowCancellationReasonKey,
    note: string | null,
  ): Promise<void>;
  pause(
    instanceId: WorkflowInstanceId,
    reason: WorkflowPauseReasonKey,
    note: string | null,
  ): Promise<void>;
  resume(instanceId: WorkflowInstanceId): Promise<void>;
  comment(instanceId: WorkflowInstanceId, body: string): Promise<void>;
  /** Called by the timer consumer when a deadline or a reminder job fires. */
  onTimerFired(jobId: string): Promise<void>;
}

export interface ApprovalReadService {
  inbox(request: ApprovalInboxRequest): Promise<Page<ApprovalInboxRow>>;
  forDocument(documentId: DocumentId): Promise<{
    readonly current: WorkflowInstanceView | null;
    readonly history: readonly WorkflowInstanceView[];
  }>;
}
