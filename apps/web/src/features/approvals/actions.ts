'use server';

import {
  type DocumentWorkflow,
  type WorkflowInstance,
  addWorkflowCommentSchema,
  decideTaskSchema,
  pauseWorkflowSchema,
  submitDocumentSchema,
  withdrawSubmissionSchema,
} from '@edms/contracts';

import type { ActionResult } from '../../lib/admin/action-result';
import { adminWrite } from '../../lib/admin/api';
import { validated } from '../../lib/admin/validated';

/**
 * Writes to an approval.
 *
 * Server actions, like every other write in this product, so the access token stays in its
 * `httpOnly` cookie and never reaches client JavaScript.
 *
 * The shape follows one rule from the engine: **a decision is one request.** The decision and its
 * comment travel together because they are one act — a rejection whose reason arrived in a second
 * call is a rejection that existed for a moment with no reason, and that moment is what somebody
 * reads years later. There is deliberately no "comment on a task" action separate from deciding it.
 */

/**
 * Hands a document to its workflow.
 *
 * No workflow identifier in the body, and that absence is the design: which definition applies is
 * decided by the document's type and the definition's own `appliesTo`, server-side. A client naming
 * one would be a client choosing its own approvers.
 */
export async function submitForApproval(
  documentId: string,
  input: unknown,
): Promise<ActionResult<DocumentWorkflow>> {
  return validated(submitDocumentSchema, input, (body) =>
    adminWrite<DocumentWorkflow>({ path: `/documents/${documentId}/submit`, method: 'POST', body }),
  );
}

/** The author taking a document back. The API refuses it once anybody has decided. */
export async function withdrawSubmission(
  documentId: string,
  input: unknown,
): Promise<ActionResult<DocumentWorkflow>> {
  return validated(withdrawSubmissionSchema, input, (body) =>
    adminWrite<DocumentWorkflow>({
      path: `/documents/${documentId}/withdraw`,
      method: 'POST',
      body,
    }),
  );
}

export async function decideTask(
  taskId: string,
  input: unknown,
): Promise<ActionResult<WorkflowInstance>> {
  return validated(decideTaskSchema, input, (body) =>
    adminWrite<WorkflowInstance>({
      path: `/approval-tasks/${taskId}/decision`,
      method: 'POST',
      body,
    }),
  );
}

export async function addComment(instanceId: string, input: unknown): Promise<ActionResult> {
  return validated(addWorkflowCommentSchema, input, (body) =>
    adminWrite({ path: `/workflow-instances/${instanceId}/comments`, method: 'POST', body }),
  );
}

/**
 * Holding an approval, and letting it go again.
 *
 * Behind `workflow:manage`. The reason is a stated value rather than free text, because "which
 * approvals are held, and by what" is a question an administrator asks across a whole tenant, and a
 * note somebody typed cannot be grouped by.
 */
export async function pauseApproval(
  instanceId: string,
  input: unknown,
): Promise<ActionResult<WorkflowInstance>> {
  return validated(pauseWorkflowSchema, input, (body) =>
    adminWrite<WorkflowInstance>({
      path: `/workflow-instances/${instanceId}/pause`,
      method: 'POST',
      body,
    }),
  );
}

export async function resumeApproval(instanceId: string): Promise<ActionResult<WorkflowInstance>> {
  return adminWrite<WorkflowInstance>({
    path: `/workflow-instances/${instanceId}/resume`,
    method: 'POST',
  });
}
