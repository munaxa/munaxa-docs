import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

import type { DocumentType, WorkflowDefinition } from '@edms/contracts';
import { DomainError, ErrorCode, Permission } from '@edms/domain';

import { AdminForbidden } from '../../../../../features/admin-shared';
import { WorkflowVersionsScreen } from '../../../../../features/admin-workflows/versions-screen';
import { adminAccess, adminGet, adminOptions } from '../../../../../lib/admin/api';

/**
 * One workflow's versions.
 *
 * A page of its own rather than a panel on the list, because the version history is the part somebody
 * comes here to reason about — which version is live, what a draft would replace — and it deserves a URL
 * they can send to whoever has to approve the change.
 */
export default async function WorkflowPage({
  params,
}: {
  params: Promise<{ workflowId: string }>;
}): Promise<ReactNode> {
  const access = await adminAccess(Permission.WORKFLOW_MANAGE);
  if (!access.granted) {
    return <AdminForbidden />;
  }

  const { workflowId } = await params;
  const [workflow, types] = await Promise.all([
    findWorkflow(workflowId),
    adminOptions<DocumentType>('/admin/document-types', 'name'),
  ]);
  if (workflow === null) {
    notFound();
  }

  return (
    <WorkflowVersionsScreen
      workflow={workflow}
      documentTypes={types.data.map((type) => ({
        value: type.code,
        label: `${type.name} (${type.code})`,
      }))}
    />
  );
}

async function findWorkflow(id: string): Promise<WorkflowDefinition | null> {
  try {
    return await adminGet<WorkflowDefinition>(`/admin/workflows/${id}`);
  } catch (error) {
    // A removed workflow, or one belonging to another tenant — which the API reports the same way,
    // deliberately. Both are honestly a missing page.
    if (error instanceof DomainError && error.code === ErrorCode.NOT_FOUND) {
      return null;
    }
    throw error;
  }
}
