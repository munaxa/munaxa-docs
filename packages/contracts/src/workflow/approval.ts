import { z } from 'zod';

import {
  ALL_WORKFLOW_PAUSE_REASONS,
  ApprovalTaskState,
  DocumentStatus,
  StageCompletionRule,
  TaskDecision,
  WorkflowInstanceStatus,
  WorkflowStageStatus,
  type WorkflowPauseReasonKey,
} from '@edms/domain';

import { isoDateTimeSchema, uuidSchema } from '../common/identifiers';
import { pageQuerySchema, sortQuerySchema } from '../common/pagination';

/**
 * Approval, on the wire.
 *
 * The engine's read side is a *timeline* rather than a set of rows, and that shape is deliberate.
 * "Who must agree before this becomes official" is answered by an instance, its stages in order,
 * and the tasks inside each — and a client that had to assemble that from three flat collections
 * would be a client that can render them in an order the engine did not mean.
 *
 * Nothing here restates a definition. A definition is `admin/workflow.ts` and belongs to the people
 * who author workflows; this is what a running one looks like to somebody being asked to decide.
 * The overlap is deliberate and small: a stage's name and completion rule appear in both, because
 * an approver has to be told what they are part of, and copying two fields is cheaper than making
 * an approval screen read an administration contract.
 */

export const taskDecisionSchema = z.nativeEnum(TaskDecision);
export const approvalTaskStateSchema = z.nativeEnum(ApprovalTaskState);
export const workflowInstanceStatusSchema = z.nativeEnum(WorkflowInstanceStatus);
export const workflowStageStatusSchema = z.nativeEnum(WorkflowStageStatus);

/**
 * A comment on a decision.
 *
 * Bounded and trimmed like every other free text in the product. Whether one is *required* is not
 * a property of the string: `06-document-lifecycle.md` §3 requires one for a rejection and for a
 * request for changes, and that is enforced where the decision is, because it depends on which
 * decision was made.
 */
export const approvalCommentSchema = z.string().trim().min(1).max(4000);

// --- Submitting -----------------------------------------------------------------------------

/**
 * Handing a document to its workflow.
 *
 * The body carries no workflow identifier, and that absence is the design. Which definition applies
 * is decided by the document's *type* and by the definition's own `appliesTo` condition, resolved
 * server-side at submission — a client naming one would be a client choosing its own approvers.
 */
export const submitDocumentSchema = z.object({
  /** What the author wants the approvers to know. Optional; a submission is not a decision. */
  comment: approvalCommentSchema.optional(),
});

export const withdrawSubmissionSchema = z.object({
  reason: approvalCommentSchema.optional(),
});

// --- Deciding -------------------------------------------------------------------------------

/**
 * One approver's decision.
 *
 * `decision` and `comment` in one body rather than a comment endpoint plus a decision endpoint,
 * because they are one act: a rejection whose reason arrived in a second request is a rejection
 * that existed for a moment with no reason, and that moment is what somebody reads later.
 */
export const decideTaskSchema = z
  .object({
    decision: taskDecisionSchema,
    comment: approvalCommentSchema.optional(),
  })
  .superRefine((body, context) => {
    if (body.decision !== TaskDecision.APPROVED && body.comment === undefined) {
      // An approval may be silent — agreeing with what is written needs no elaboration. A refusal
      // may not: the author has to be told what to change, and "rejected" alone is not something
      // anybody can act on.
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['comment'],
        message: 'A rejection or a request for changes has to say why.',
      });
    }
  });

/** A remark on an approval that is not a decision. */
export const addWorkflowCommentSchema = z.object({
  body: approvalCommentSchema,
});

/** Holding an approval, and letting it go again. */
export const pauseWorkflowSchema = z.object({
  reason: z.enum(
    ALL_WORKFLOW_PAUSE_REASONS as [WorkflowPauseReasonKey, ...WorkflowPauseReasonKey[]],
  ),
  note: approvalCommentSchema.optional(),
});

// --- Reading --------------------------------------------------------------------------------

/** One person's task, as an inbox row and as a timeline entry. */
export const approvalTaskSchema = z.object({
  id: uuidSchema,
  workflowInstanceId: uuidSchema,
  stageId: uuidSchema,
  stageIndex: z.number().int().min(0),
  stageName: z.string(),
  assigneeId: uuidSchema,
  assigneeName: z.string().nullable(),
  /** Which resolver produced this person — the answer to "why am I being asked". */
  resolvedBy: z.string(),
  sequence: z.number().int().min(0),
  state: approvalTaskStateSchema,
  decision: taskDecisionSchema.nullable(),
  decidedById: uuidSchema.nullable(),
  decidedByName: z.string().nullable(),
  /** The delegator, when somebody decided for another person. Both identities travel together. */
  onBehalfOfId: uuidSchema.nullable(),
  decidedAt: isoDateTimeSchema.nullable(),
  comment: z.string().nullable(),
  dueAt: isoDateTimeSchema.nullable(),
  /** True when the engine decided it under a stage the definition marked non-controlling. */
  autoDecided: z.boolean(),
  /** Whether this caller may decide it now — false for a later step of an ordered stage. */
  actionable: z.boolean(),
  createdAt: isoDateTimeSchema,
});

export const workflowStageSummarySchema = z.object({
  id: uuidSchema,
  index: z.number().int().min(0),
  name: z.string(),
  completionRule: z.nativeEnum(StageCompletionRule),
  threshold: z.number().int().nullable(),
  ordered: z.boolean(),
  status: workflowStageStatusSchema,
  /** What the completion rule works out to for the people who were actually resolved. */
  approvalsRequired: z.number().int().min(0),
  approvalsGiven: z.number().int().min(0),
  activatedAt: isoDateTimeSchema.nullable(),
  completedAt: isoDateTimeSchema.nullable(),
  dueAt: isoDateTimeSchema.nullable(),
  skipReason: z.string().nullable(),
  tasks: z.array(approvalTaskSchema),
});

export const workflowCommentSchema = z.object({
  id: uuidSchema,
  authorId: uuidSchema,
  authorName: z.string().nullable(),
  stageId: uuidSchema.nullable(),
  taskId: uuidSchema.nullable(),
  body: z.string(),
  /** The decision it accompanied, when it accompanied one. */
  decision: taskDecisionSchema.nullable(),
  createdAt: isoDateTimeSchema,
});

/**
 * A whole approval attempt — the "workflow history" and the "approval timeline" in one shape.
 *
 * They were never two things. A timeline is this rendered forwards and a history is a list of
 * these, and serving them from two endpoints would be two projections of one aggregate to keep in
 * step.
 */
export const workflowInstanceSchema = z.object({
  id: uuidSchema,
  documentId: uuidSchema,
  revisionId: uuidSchema,
  revisionLabel: z.string(),
  definitionId: uuidSchema,
  definitionKey: z.string(),
  definitionName: z.string(),
  /** The version's own number. What "which rules was this approved under" resolves to. */
  workflowVersionId: uuidSchema,
  workflowVersion: z.number().int().min(1),
  status: workflowInstanceStatusSchema,
  currentStageIndex: z.number().int(),
  startedAt: isoDateTimeSchema,
  startedBy: uuidSchema.nullable(),
  endedAt: isoDateTimeSchema.nullable(),
  endReason: z.string().nullable(),
  pausedAt: isoDateTimeSchema.nullable(),
  pauseReason: z.string().nullable(),
  escalationCount: z.number().int().min(0),
  /** False until Phase 5 allocates one; the completion event records which it was. */
  numberAssigned: z.boolean(),
  stages: z.array(workflowStageSummarySchema),
  comments: z.array(workflowCommentSchema),
  version: z.number().int().min(1),
});

/** What a document's approval area shows: the live attempt, and everything before it. */
export const documentWorkflowSchema = z.object({
  documentId: uuidSchema,
  status: z.nativeEnum(DocumentStatus),
  /** Null when nothing is running — before a first submission, and after a final decision. */
  current: workflowInstanceSchema.nullable(),
  /** Ended attempts, newest first. A rejected submission is history, never a deleted row. */
  history: z.array(workflowInstanceSchema),
  /** The transitions the product can perform from here, computed server-side (§5). */
  availableTransitions: z.array(z.nativeEnum(DocumentStatus)),
  /**
   * Whether this document has a workflow to run at all.
   *
   * False for a type that names no definition, which is legitimate — a reference document needs no
   * approval — and is why "submit" is absent rather than failing.
   */
  requiresApproval: z.boolean(),
});

/** An inbox row: the task, plus enough of the document to decide whether to open it. */
export const approvalInboxItemSchema = approvalTaskSchema.extend({
  documentId: uuidSchema,
  documentTitle: z.string(),
  documentNumber: z.string().nullable(),
  documentTypeName: z.string(),
  /** Past its deadline, computed server-side so two clients cannot disagree about "overdue". */
  overdue: z.boolean(),
});

export const approvalInboxQuerySchema = pageQuerySchema
  .merge(sortQuerySchema(['dueAt', 'createdAt'] as const))
  .extend({
    /**
     * Whose inbox. Absent means the caller's own.
     *
     * A delegate needs to see the tasks they may act on, and a manager reviewing a backlog needs to
     * see somebody else's — both gated by permission at the endpoint. Defaulting to the caller is
     * what keeps the ordinary case from having to name themselves.
     */
    assigneeId: uuidSchema.optional(),
    state: approvalTaskStateSchema.optional(),
    overdue: z.enum(['true', 'false']).optional(),
  });

export type SubmitDocumentBody = z.infer<typeof submitDocumentSchema>;
export type WithdrawSubmissionBody = z.infer<typeof withdrawSubmissionSchema>;
export type DecideTaskBody = z.infer<typeof decideTaskSchema>;
export type AddWorkflowCommentBody = z.infer<typeof addWorkflowCommentSchema>;
export type PauseWorkflowBody = z.infer<typeof pauseWorkflowSchema>;
export type ApprovalTask = z.infer<typeof approvalTaskSchema>;
export type WorkflowStageSummary = z.infer<typeof workflowStageSummarySchema>;
export type WorkflowComment = z.infer<typeof workflowCommentSchema>;
export type WorkflowInstance = z.infer<typeof workflowInstanceSchema>;
export type DocumentWorkflow = z.infer<typeof documentWorkflowSchema>;
export type ApprovalInboxItem = z.infer<typeof approvalInboxItemSchema>;
export type ApprovalInboxQuery = z.infer<typeof approvalInboxQuerySchema>;
