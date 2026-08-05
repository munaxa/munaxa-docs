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

// --- The three events addressed to people, added by Phase 12 ---------------------------------
//
// `workflow.stage-activated` was carrying three different meanings, because it was the only
// event the engine had for "somebody should look at this": it was published when a stage
// activated, again when a reminder timer fired, and again when a deadline passed with
// `NOTIFY_ONLY`. That was harmless while nothing consumed it. It stopped being harmless the
// moment 18 §4 asked for three *different* notifications — "your approval is needed", "this is
// still waiting for you" and "this passed its deadline" — from what was, on the wire, one fact
// repeated.
//
// So three events, rather than a discriminator on the payload of the existing one. A field would
// have changed a shipped payload shape, which §6 of `02-backend-architecture.md` forbids, and it
// would have made every consumer branch on it to find out whether the event was for them —
// exactly the argument Phase 11 gave for splitting `delegation.requested` off `approved`.
//
// They carry the document and the stage name that `stage-activated` does not, because a
// notification "carries enough context to act" (§4) and resolving a stage index back to a name
// would make the notification consumer read the workflow definition — a module reaching into
// another module's aggregate to render a sentence.
//
// `workflow.stage-activated` is unchanged and still published at activation. It is the *workflow*
// fact — a stage became active — and the audit trail and any future projection want it whether or
// not anybody is told.

/** Somebody has an approval to decide. 18 §4's first row. */
export const APPROVAL_TASK_ASSIGNED = 'workflow.task-assigned' as const;

export interface ApprovalTaskAssignedPayload {
  readonly workflowInstanceId: string;
  readonly documentId: string;
  readonly stageIndex: number;
  readonly stageName: string;
  readonly assigneeIds: readonly string[];
  readonly dueAt: string | null;
}

export const approvalTaskAssignedEvent = defineEvent<
  typeof APPROVAL_TASK_ASSIGNED,
  ApprovalTaskAssignedPayload
>(APPROVAL_TASK_ASSIGNED, 1, WORKFLOW_AGGREGATE);

/** A reminder timer fired: the deadline is approaching and nobody has decided. 18 §4's second row. */
export const APPROVAL_REMINDER_DUE = 'workflow.reminder-due' as const;

export const approvalReminderDueEvent = defineEvent<
  typeof APPROVAL_REMINDER_DUE,
  ApprovalTaskAssignedPayload
>(APPROVAL_REMINDER_DUE, 1, WORKFLOW_AGGREGATE);

/**
 * A deadline passed and the stage's `onOverdue` was `NOTIFY_ONLY`. 18 §4's third row.
 *
 * Only that branch. `ESCALATE` publishes `workflow.task-escalated`, which is a different fact
 * addressed to a different person, and `TERMINATE` and `AUTO_APPROVE` change the instance —
 * their notifications are the document's, not the task's.
 */
export const APPROVAL_OVERDUE = 'workflow.overdue' as const;

export const approvalOverdueEvent = defineEvent<
  typeof APPROVAL_OVERDUE,
  ApprovalTaskAssignedPayload
>(APPROVAL_OVERDUE, 1, WORKFLOW_AGGREGATE);

/** Every event type this module publishes, for the outbox's routing table. */
export const WORKFLOW_EVENT_TYPES: readonly string[] = Object.freeze([
  WORKFLOW_STARTED,
  WORKFLOW_STAGE_ACTIVATED,
  APPROVAL_TASK_ASSIGNED,
  APPROVAL_REMINDER_DUE,
  APPROVAL_OVERDUE,
  APPROVAL_TASK_DECIDED,
  APPROVAL_TASK_ESCALATED,
  WORKFLOW_COMPLETED,
  WORKFLOW_CANCELLED,
]);

export type WorkflowEvent = DomainEventDraft;
