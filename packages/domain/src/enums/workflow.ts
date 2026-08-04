/** Workflow vocabulary (`docs/architecture/07-workflow-architecture.md`). */
export const WorkflowInstanceStatus = {
  RUNNING: 'RUNNING',
  /**
   * Timers stopped, nothing decides.
   *
   * A document under legal hold or a suspended tenant pauses its approvals, and §6 is precise
   * about what pausing means: each timer keeps the duration it had left and resumes with *that*.
   * A pause that restarted the clock would hand an approver three fresh days for every hour the
   * hold lasted, which is a deadline nobody could rely on.
   */
  PAUSED: 'PAUSED',
  COMPLETED: 'COMPLETED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
} as const;

/** The states an instance is still in play in — the ones a document may not be resubmitted under. */
export const LIVE_WORKFLOW_INSTANCE_STATUSES: readonly string[] = Object.freeze([
  WorkflowInstanceStatus.RUNNING,
  WorkflowInstanceStatus.PAUSED,
]);

export type WorkflowInstanceStatusKey =
  (typeof WorkflowInstanceStatus)[keyof typeof WorkflowInstanceStatus];

export const WorkflowStageStatus = {
  PENDING: 'PENDING',
  ACTIVE: 'ACTIVE',
  COMPLETED: 'COMPLETED',
  /** Its condition did not hold. Never "nobody resolved" — that fails submission loudly (§8). */
  SKIPPED: 'SKIPPED',
  /** The instance ended before this stage ran. */
  CANCELLED: 'CANCELLED',
} as const;

export type WorkflowStageStatusKey = (typeof WorkflowStageStatus)[keyof typeof WorkflowStageStatus];

/** How many of a stage's approvers must agree before the stage completes (§2). */
export const StageCompletionRule = {
  ALL: 'ALL',
  ANY: 'ANY',
  QUORUM: 'QUORUM',
  PERCENT: 'PERCENT',
} as const;

export type StageCompletionRuleKey = (typeof StageCompletionRule)[keyof typeof StageCompletionRule];

export const ALL_STAGE_COMPLETION_RULES: readonly StageCompletionRuleKey[] = Object.freeze(
  Object.values(StageCompletionRule),
);

/**
 * The rules that carry a threshold, and therefore the ones a definition must state a number for.
 *
 * `QUORUM` without a count and `PERCENT` without a percentage are the two ways to write a stage
 * whose completion condition can never be evaluated. The validator refuses both, and it asks
 * here rather than repeating the pair.
 */
export function needsThreshold(rule: StageCompletionRuleKey): boolean {
  return rule === StageCompletionRule.QUORUM || rule === StageCompletionRule.PERCENT;
}

/**
 * What happened to one person's task, independently of what they decided.
 *
 * Separate from the decision because the two answer different questions, and an approval inbox has
 * to tell them apart: `SUPERSEDED` is what an `ANY` stage does to everybody else's task once one
 * person approves, and `WITHDRAWN` is a task whose instance ended underneath it. Both are
 * undecided; neither is pending; and showing either in somebody's "awaiting you" list would be
 * asking for a decision that can no longer be taken.
 */
export const ApprovalTaskState = {
  PENDING: 'PENDING',
  DECIDED: 'DECIDED',
  WITHDRAWN: 'WITHDRAWN',
  SUPERSEDED: 'SUPERSEDED',
} as const;

export type ApprovalTaskStateKey = (typeof ApprovalTaskState)[keyof typeof ApprovalTaskState];

export const TaskDecision = {
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  CHANGES_REQUESTED: 'CHANGES_REQUESTED',
} as const;

export type TaskDecisionKey = (typeof TaskDecision)[keyof typeof TaskDecision];

/** Why an instance ended, recorded on the instance and in the audit event. */
export const WorkflowCancellationReason = {
  RETURNED: 'RETURNED',
  WITHDRAWN: 'WITHDRAWN',
  SUPERSEDED: 'SUPERSEDED',
  ADMINISTRATIVE: 'ADMINISTRATIVE',
} as const;

export type WorkflowCancellationReasonKey =
  (typeof WorkflowCancellationReason)[keyof typeof WorkflowCancellationReason];

// ---------------------------------------------------------------------------------------
// The vocabulary a *definition* is authored in.
//
// Everything below describes what Administration stores; nothing below is runtime state. The
// split matters because a definition is data a tenant edits and a version is data the engine
// reads, and the engine may never learn a word that is not here (§8).
// ---------------------------------------------------------------------------------------

/**
 * A version's own lifecycle.
 *
 * `PUBLISHED` is the load-bearing one: a published version is immutable, because an instance
 * binds to a version and editing one would change the rules of an approval already running —
 * "the single most important property of the engine" (§1). Editing means publishing a new
 * version; retiring means `DEPRECATED`, which stops new instances and leaves running ones alone.
 */
export const WorkflowVersionState = {
  DRAFT: 'DRAFT',
  PUBLISHED: 'PUBLISHED',
  DEPRECATED: 'DEPRECATED',
} as const;

export type WorkflowVersionStateKey =
  (typeof WorkflowVersionState)[keyof typeof WorkflowVersionState];

/**
 * How a stage's approvers are found (§2).
 *
 * These are *resolvers*, evaluated at stage activation against the document's own context —
 * never stored as user ids, so an org change does not break a workflow that was authored before
 * it. `USER` is the exception, and it is discouraged for exactly that reason.
 */
export const ParticipantKind = {
  USER: 'USER',
  ROLE: 'ROLE',
  DEPARTMENT: 'DEPARTMENT',
  MANAGER_OF: 'MANAGER_OF',
  GROUP: 'GROUP',
  DOCUMENT_FIELD: 'DOCUMENT_FIELD',
  OWNER: 'OWNER',
} as const;

export type ParticipantKindKey = (typeof ParticipantKind)[keyof typeof ParticipantKind];

export const ALL_PARTICIPANT_KINDS: readonly ParticipantKindKey[] = Object.freeze(
  Object.values(ParticipantKind),
);

/** Where a `ROLE` resolver looks for holders. */
export const ParticipantScope = {
  TENANT: 'TENANT',
  DOCUMENT_ENTITY: 'DOCUMENT_ENTITY',
  DOCUMENT_DEPARTMENT: 'DOCUMENT_DEPARTMENT',
} as const;

export type ParticipantScopeKey = (typeof ParticipantScope)[keyof typeof ParticipantScope];

/** Whose manager a `MANAGER_OF` resolver means. */
export const ManagerOfSubject = {
  AUTHOR: 'AUTHOR',
  OWNER: 'OWNER',
  ASSIGNEE: 'ASSIGNEE',
  PREVIOUS_APPROVER: 'PREVIOUS_APPROVER',
} as const;

export type ManagerOfSubjectKey = (typeof ManagerOfSubject)[keyof typeof ManagerOfSubject];

/** Which calendar a deadline duration is counted against (§6). */
export const DeadlineCalendar = {
  CALENDAR_DAYS: 'CALENDAR_DAYS',
  WORKING_DAYS: 'WORKING_DAYS',
} as const;

export type DeadlineCalendarKey = (typeof DeadlineCalendar)[keyof typeof DeadlineCalendar];

/**
 * What happens when a stage's deadline passes (§5).
 *
 * `AUTO_APPROVE` is deliberately in the list and deliberately awkward to reach: some tenants
 * genuinely need informational stages, but an approval nobody made is a control that is not
 * there, so a definition using it must mark the stage non-controlling and every auto-approval
 * is audited as such.
 */
export const OverdueAction = {
  NOTIFY_ONLY: 'NOTIFY_ONLY',
  ESCALATE: 'ESCALATE',
  AUTO_APPROVE: 'AUTO_APPROVE',
  TERMINATE: 'TERMINATE',
} as const;

export type OverdueActionKey = (typeof OverdueAction)[keyof typeof OverdueAction];

export const ALL_OVERDUE_ACTIONS: readonly OverdueActionKey[] = Object.freeze(
  Object.values(OverdueAction),
);

/** What a rejection does to the instance. */
export const RejectBehaviour = {
  TERMINATE: 'TERMINATE',
  RETURN_TO_AUTHOR: 'RETURN_TO_AUTHOR',
} as const;

export type RejectBehaviourKey = (typeof RejectBehaviour)[keyof typeof RejectBehaviour];

/** When a completed workflow makes the document public (§2, `onComplete.publish`). */
export const PublishTiming = {
  IMMEDIATELY: 'IMMEDIATELY',
  ON_EFFECTIVE_DATE: 'ON_EFFECTIVE_DATE',
  MANUALLY: 'MANUALLY',
} as const;

export type PublishTimingKey = (typeof PublishTiming)[keyof typeof PublishTiming];

/** The comparisons a stage condition may make (§2). A closed set, evaluated purely. */
export const ConditionOperator = {
  EQUALS: '=',
  NOT_EQUALS: '!=',
  GREATER_THAN: '>',
  GREATER_OR_EQUAL: '>=',
  LESS_THAN: '<',
  LESS_OR_EQUAL: '<=',
  IN: 'IN',
  CONTAINS: 'CONTAINS',
} as const;

export type ConditionOperatorKey = (typeof ConditionOperator)[keyof typeof ConditionOperator];

export const ALL_CONDITION_OPERATORS: readonly ConditionOperatorKey[] = Object.freeze(
  Object.values(ConditionOperator),
);

/** What a scheduled workflow timer is for (§6). */
export const WorkflowTimerKind = {
  DEADLINE: 'DEADLINE',
  REMINDER: 'REMINDER',
} as const;

export type WorkflowTimerKindKey = (typeof WorkflowTimerKind)[keyof typeof WorkflowTimerKind];

/**
 * Where a timer is in its life.
 *
 * `PAUSED` carries the remaining duration; every other state carries none. That pairing is the
 * whole of "resumes with the remaining duration, never restarting the clock", and it is a database
 * check constraint as well as a rule here — a timer that could be paused without recording what it
 * had left would resume from nothing.
 */
export const WorkflowTimerState = {
  SCHEDULED: 'SCHEDULED',
  PAUSED: 'PAUSED',
  FIRED: 'FIRED',
  CANCELLED: 'CANCELLED',
} as const;

export type WorkflowTimerStateKey = (typeof WorkflowTimerState)[keyof typeof WorkflowTimerState];

/**
 * Why a stage did not run.
 *
 * One value, and the narrowness is the point. §8 forbids skipping a stage whose participants
 * resolve to nobody — that is a silent loss of a control — so the only legitimate reason a stage is
 * passed over is that the definition's own condition said it does not apply to this document.
 */
export const StageSkipReason = {
  CONDITION_FALSE: 'CONDITION_FALSE',
} as const;

export type StageSkipReasonKey = (typeof StageSkipReason)[keyof typeof StageSkipReason];

/**
 * Why an instance paused.
 *
 * Stated rather than free text: "which approvals are held, and by what" is a question an
 * administrator asks across a tenant, and a note somebody typed cannot be grouped by.
 */
export const WorkflowPauseReason = {
  LEGAL_HOLD: 'LEGAL_HOLD',
  TENANT_SUSPENDED: 'TENANT_SUSPENDED',
  ADMINISTRATIVE: 'ADMINISTRATIVE',
} as const;

export type WorkflowPauseReasonKey = (typeof WorkflowPauseReason)[keyof typeof WorkflowPauseReason];

export const ALL_WORKFLOW_PAUSE_REASONS: readonly WorkflowPauseReasonKey[] = Object.freeze(
  Object.values(WorkflowPauseReason),
);
