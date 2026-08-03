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

/** How many of a stage's approvers must agree before the stage completes. */
export const StageCompletionRule = {
  ALL: 'ALL',
  ANY: 'ANY',
  QUORUM: 'QUORUM',
} as const;

export type StageCompletionRuleKey = (typeof StageCompletionRule)[keyof typeof StageCompletionRule];

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
