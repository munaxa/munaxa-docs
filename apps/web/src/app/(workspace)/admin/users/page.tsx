import type { ReactNode } from 'react';

import type { Department, Role, User } from '@edms/contracts';
import { Permission } from '@edms/domain';

import { AdminForbidden } from '../../../../features/admin-shared';
import { UsersScreen } from '../../../../features/admin-identity/users-screen';
import { adminAccess, adminList, adminOptions } from '../../../../lib/admin/api';
import { type RawSearchParams, readListState } from '../../../../lib/admin/list-state';
import { USER_FILTER_KEYS, USER_SORT_FIELDS } from '../../../../lib/admin/list-keys';

/** People, with the roles and departments their form and filters need. */
export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}): Promise<ReactNode> {
  const access = await adminAccess(Permission.USER_MANAGE);
  if (!access.granted) {
    return <AdminForbidden />;
  }

  const state = readListState(await searchParams, USER_SORT_FIELDS, USER_FILTER_KEYS);
  const [page, roles, departments] = await Promise.all([
    adminList<User>('/admin/users', state),
    adminOptions<Role>('/admin/roles', 'name'),
    adminOptions<Department>('/admin/departments', 'path'),
  ]);

  return (
    <UsersScreen
      rows={page.data}
      total={page.meta.total}
      state={state}
      roles={roles.data.map((role) => ({ value: role.id, label: role.name }))}
      departments={departments.data.map((department) => ({
        value: department.id,
        label: `${department.name} (${department.code})`,
      }))}
    />
  );
}
