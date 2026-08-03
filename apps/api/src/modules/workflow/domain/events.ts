import { type DomainEventDraft, defineEvent } from '@edms/domain';

/**
 * Workflow's domain events.
 *
 * An event is a fact in the past tense, its payload shape never changes once shipped, and
 * delivery is at least once — so every handler is idempotent on `eventId`
 * (`docs/architecture/02-backend-architecture.md` §6).
 *
 * The payloads are deliberately thin: an event carries identifiers and the facts a consumer
 * cannot derive, never a copy of the aggregate. A fat event becomes a second schema that
 * nobody migrates.
 */
export const WORKFLOW_AGGREGATE = 'workflow';

/** An instance is bound to a definition version and a revision. */
export const WORKFLOW_STARTED = 'workflow.started' as const;

export interface WorkflowStartedPayload {
  readonly workflowInstanceId: string;
  readonly documentId: string;
  readonly revisionId: string;
  readonly workflowVersionId: string;
}

export const workflowStartedEvent = defineEvent<typeof WORKFLOW_STARTED, WorkflowStartedPayload>(
  WORKFLOW_STARTED,
  1,
  WORKFLOW_AGGREGATE,
);

/** Tasks exist for this stage\u2019s approvers. */
export const WORKFLOW_STAGE_ACTIVATED = 'workflow.stage-activated' as const;

export interface WorkflowStageActivatedPayload {
  readonly workflowInstanceId: string;
  readonly stageIndex: number;
  readonly assigneeIds: readonly string[];
  readonly dueAt: string | null;
}

export const workflowStageActivatedEvent = defineEvent<
  typeof WORKFLOW_STAGE_ACTIVATED,
  WorkflowStageActivatedPayload
>(WORKFLOW_STAGE_ACTIVATED, 1, WORKFLOW_AGGREGATE);

/** One approver decided; records who acted and on whose behalf. */
export const APPROVAL_TASK_DECIDED = 'workflow.task-decided' as const;

export interface ApprovalTaskDecidedPayload {
  readonly taskId: string;
  readonly workflowInstanceId: string;
  readonly decision: string;
  readonly decidedBy: string;
  readonly onBehalfOfId: string | null;
}

export const approvalTaskDecidedEvent = defineEvent<
  typeof APPROVAL_TASK_DECIDED,
  ApprovalTaskDecidedPayload
>(APPROVAL_TASK_DECIDED, 1, WORKFLOW_AGGREGATE);

/** A deadline passed and the task was reassigned per the stage rule. */
export const APPROVAL_TASK_ESCALATED = 'workflow.task-escalated' as const;

export interface ApprovalTaskEscalatedPayload {
  readonly taskId: string;
  readonly fromAssigneeId: string;
  readonly toAssigneeId: string;
  readonly dueAt: string;
}

export const approvalTaskEscalatedEvent = defineEvent<
  typeof APPROVAL_TASK_ESCALATED,
  ApprovalTaskEscalatedPayload
>(APPROVAL_TASK_ESCALATED, 1, WORKFLOW_AGGREGATE);

/** Every stage passed; the document may be numbered and approved. */
export const WORKFLOW_COMPLETED = 'workflow.completed' as const;

export interface WorkflowCompletedPayload {
  readonly workflowInstanceId: string;
  readonly documentId: string;
  readonly stagesCompleted: number;
}

export const workflowCompletedEvent = defineEvent<
  typeof WORKFLOW_COMPLETED,
  WorkflowCompletedPayload
>(WORKFLOW_COMPLETED, 1, WORKFLOW_AGGREGATE);

/** Ended without a decision, with a stated reason. */
export const WORKFLOW_CANCELLED = 'workflow.cancelled' as const;

export interface WorkflowCancelledPayload {
  readonly workflowInstanceId: string;
  readonly documentId: string;
  readonly reason: string;
}

export const workflowCancelledEvent = defineEvent<
  typeof WORKFLOW_CANCELLED,
  WorkflowCancelledPayload
>(WORKFLOW_CANCELLED, 1, WORKFLOW_AGGREGATE);

/** Every event type this module publishes, for the outbox's routing table. */
export const WORKFLOW_EVENT_TYPES: readonly string[] = Object.freeze([
  WORKFLOW_STARTED,
  WORKFLOW_STAGE_ACTIVATED,
  APPROVAL_TASK_DECIDED,
  APPROVAL_TASK_ESCALATED,
  WORKFLOW_COMPLETED,
  WORKFLOW_CANCELLED,
]);

export type WorkflowEvent = DomainEventDraft;
