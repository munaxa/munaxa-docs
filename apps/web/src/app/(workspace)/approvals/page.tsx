import type { ReactNode } from 'react';

import type { ApprovalInboxItem, Collection } from '@edms/contracts';
import { ApprovalTaskState, Permission } from '@edms/domain';

import { AdminForbidden, AdminScreen } from '../../../features/admin-shared';
import { ApprovalInboxScreen } from '../../../features/approvals/inbox-screen';
import { adminAccess, adminGet } from '../../../lib/admin/api';

/**
 * "What needs my attention right now."
 *
 * The dashboard task list, served as its own destination rather than a widget, because it is where
 * an approver spends their day: a list they work down until it is empty. The Dashboard module owns
 * the wider "state of my work" view and is a later phase; this is the approval half of it, built by
 * the phase that made approvals exist.
 *
 * No `assigneeId` in the request. "My approvals" is inherently the caller's own list, and the
 * endpoint refuses somebody else's — an inbox that took a user would be an endpoint for reading
 * another person's queue, which is a supervision feature rather than a navigation one.
 */
export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const access = await adminAccess(Permission.DOCUMENT_VIEW);
  if (!access.granted) {
    return <AdminForbidden />;
  }

  const params = await searchParams;
  const decided = params['state'] === ApprovalTaskState.DECIDED;
  const query = new URLSearchParams({
    page: '1',
    pageSize: '50',
    sortBy: 'dueAt',
    sortDirection: 'asc',
    state: decided ? ApprovalTaskState.DECIDED : ApprovalTaskState.PENDING,
  });

  const inbox = await adminGet<Collection<ApprovalInboxItem>>(
    `/approval-tasks?${query.toString()}`,
  );

  return (
    <AdminScreen titleKey="approvals.title" descriptionKey="approvals.description">
      <ApprovalInboxScreen rows={inbox.data} decided={decided} />
    </AdminScreen>
  );
}
