'use server';

import {
  type WorkflowDefinition,
  createWorkflowDefinitionSchema,
  updateWorkflowDefinitionSchema,
  updateWorkflowVersionSchema,
  workflowDefinitionBodySchema,
} from '@edms/contracts';

import type { ActionResult } from '../../lib/admin/action-result';
import { adminWrite } from '../../lib/admin/api';
import { validated } from '../../lib/admin/validated';

/**
 * Writes to approval workflows.
 *
 * The shape of this module follows the one rule that matters most in the engine: **a published version
 * is immutable**. An approval binds to a version, so editing one would change the rules of a run
 * already in flight. There is therefore no "edit the live workflow" action anywhere below — editing a
 * published workflow *is* `addDraft` followed by `publish`, and the API enforces the same thing twice,
 * in the service and in the `WHERE` of the update statement.
 */

export async function createWorkflow(input: unknown): Promise<ActionResult<WorkflowDefinition>> {
  return validated(createWorkflowDefinitionSchema, input, (body) =>
    adminWrite<WorkflowDefinition>({ path: '/admin/workflows', method: 'POST', body }),
  );
}

export async function updateWorkflow(
  id: string,
  version: number,
  input: unknown,
): Promise<ActionResult<WorkflowDefinition>> {
  return validated(updateWorkflowDefinitionSchema, input, (body) =>
    adminWrite<WorkflowDefinition>({
      path: `/admin/workflows/${id}`,
      method: 'PATCH',
      body,
      version,
    }),
  );
}

/**
 * Starts a new draft version.
 *
 * This is what "editing a published workflow" means. The new draft is numbered `max + 1` by the API,
 * inside the same transaction, so a rolled-back attempt leaves no gap for anybody to read as a version
 * somebody removed.
 */
export async function addWorkflowDraft(
  id: string,
  input: unknown,
): Promise<ActionResult<WorkflowDefinition>> {
  return validated(workflowDefinitionBodySchema, input, (body) =>
    adminWrite<WorkflowDefinition>({
      path: `/admin/workflows/${id}/versions`,
      method: 'POST',
      body,
    }),
  );
}

export async function updateWorkflowDraft(
  id: string,
  versionId: string,
  input: unknown,
): Promise<ActionResult<WorkflowDefinition>> {
  return validated(updateWorkflowVersionSchema, input, (body) =>
    adminWrite<WorkflowDefinition>({
      path: `/admin/workflows/${id}/versions/${versionId}`,
      method: 'PATCH',
      body,
    }),
  );
}

/**
 * Publishes a draft, deprecating whichever version was live.
 *
 * Exactly one version is published at a time, and the switch happens in one transaction — so there is
 * no moment at which a document type points at a workflow with no live version.
 */
export async function publishWorkflowVersion(
  id: string,
  versionId: string,
  version: number,
): Promise<ActionResult<WorkflowDefinition>> {
  return adminWrite<WorkflowDefinition>({
    path: `/admin/workflows/${id}/versions/${versionId}/publish`,
    method: 'POST',
    version,
  });
}

/** Retires a version. New approvals stop using it; approvals already running are untouched. */
export async function deprecateWorkflowVersion(
  id: string,
  versionId: string,
  version: number,
): Promise<ActionResult<WorkflowDefinition>> {
  return adminWrite<WorkflowDefinition>({
    path: `/admin/workflows/${id}/versions/${versionId}/deprecate`,
    method: 'POST',
    version,
  });
}

export async function deleteWorkflow(id: string, version: number): Promise<ActionResult> {
  return adminWrite({ path: `/admin/workflows/${id}`, method: 'DELETE', version });
}

export async function restoreWorkflow(id: string, version: number): Promise<ActionResult> {
  return adminWrite({ path: `/admin/workflows/${id}/restore`, method: 'POST', version });
}
