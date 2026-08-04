import type { ReactNode } from 'react';

import type { DocumentType, WorkflowDefinition } from '@edms/contracts';
import { Permission } from '@edms/domain';

import { AdminForbidden } from '../../../../features/admin-shared';
import {
  WORKFLOW_FILTER_KEYS,
  WORKFLOW_SORT_FIELDS,
  WorkflowsScreen,
} from '../../../../features/admin-workflows/workflows-screen';
import { adminAccess, adminList, adminOptions } from '../../../../lib/admin/api';
import { type RawSearchParams, readListState } from '../../../../lib/admin/list-state';

/**
 * Approval workflows.
 *
 * The document types are fetched for the applicability editor, which names them by **code** rather than
 * by id — a definition says which kinds of document it serves, and a code is what a person reads in a
 * definition they are asked to approve.
 */
export default async function WorkflowsPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}): Promise<ReactNode> {
  const access = await adminAccess(Permission.WORKFLOW_MANAGE);
  if (!access.granted) {
    return <AdminForbidden />;
  }

  const state = readListState(await searchParams, WORKFLOW_SORT_FIELDS, WORKFLOW_FILTER_KEYS);
  const [page, types] = await Promise.all([
    adminList<WorkflowDefinition>('/admin/workflows', state),
    adminOptions<DocumentType>('/admin/document-types', 'name'),
  ]);

  return (
    <WorkflowsScreen
      rows={page.data}
      total={page.meta.total}
      state={state}
      documentTypes={types.data.map((type) => ({
        value: type.code,
        label: `${type.name} (${type.code})`,
      }))}
    />
  );
}
