import type { ReactNode } from 'react';

import type { ApprovalGroup, User } from '@edms/contracts';
import { Permission } from '@edms/domain';

import { AdminForbidden } from '../../../../features/admin-shared';
import {
  GROUP_FILTER_KEYS,
  GROUP_SORT_FIELDS,
  ApprovalGroupsScreen,
} from '../../../../features/admin-approval-routing/approval-groups-screen';
import { adminAccess, adminList, adminOptions } from '../../../../lib/admin/api';
import { type RawSearchParams, readListState } from '../../../../lib/admin/list-state';

/**
 * Approval groups.
 *
 * Behind `workflow:manage` rather than `settings:manage`: the person who authors approval workflows
 * is the person who maintains the groups those workflows route to, and that is a narrower key than
 * "can configure the tenant".
 */
export default async function ApprovalGroupsPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}): Promise<ReactNode> {
  const access = await adminAccess(Permission.WORKFLOW_MANAGE);
  if (!access.granted) {
    return <AdminForbidden />;
  }

  const state = readListState(await searchParams, GROUP_SORT_FIELDS, GROUP_FILTER_KEYS);
  const [page, users] = await Promise.all([
    adminList<ApprovalGroup>('/admin/approval-groups', state),
    adminOptions<User>('/admin/users', 'displayName'),
  ]);

  return (
    <ApprovalGroupsScreen
      rows={page.data}
      total={page.meta.total}
      state={state}
      users={users.data.map((user) => ({ value: user.id, label: user.displayName }))}
    />
  );
}
