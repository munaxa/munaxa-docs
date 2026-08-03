/** Workflow vocabulary (`docs/architecture/07-workflow-architecture.md`). */
export const WorkflowInstanceStatus = {
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
} as const;

export type WorkflowInstanceStatusKey =
  (typeof WorkflowInstanceStatus)[keyof typeof WorkflowInstanceStatus];

export const WorkflowStageStatus = {
  PENDING: 'PENDING',
  ACTIVE: 'ACTIVE',
  COMPLETED: 'COMPLETED',
  SKIPPED: 'SKIPPED',
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
