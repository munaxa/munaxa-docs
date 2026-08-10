import type { ReactNode } from 'react';

import type { PermissionCatalogue, Role } from '@edms/contracts';
import { Permission } from '@edms/domain';

import { AdminForbidden } from '../../../../features/admin-shared';
import { RolesScreen } from '../../../../features/admin-identity/roles-screen';
import { adminAccess, adminGet, adminList } from '../../../../lib/admin/api';
import { type RawSearchParams, readListState } from '../../../../lib/admin/list-state';
import { ROLE_SORT_FIELDS } from '../../../../lib/admin/list-keys';

/**
 * Roles, with the catalogue the matrix editor renders.
 *
 * The catalogue is served rather than bundled into the client so the API and the UI can never disagree
 * about which permissions exist — a permission missing from it is one the API would refuse anyway.
 */
export default async function RolesPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}): Promise<ReactNode> {
  const access = await adminAccess(Permission.ROLE_MANAGE);
  if (!access.granted) {
    return <AdminForbidden />;
  }

  const state = readListState(await searchParams, ROLE_SORT_FIELDS);
  const [page, catalogue] = await Promise.all([
    adminList<Role>('/admin/roles', state),
    adminGet<PermissionCatalogue>('/admin/roles/permissions'),
  ]);

  return (
    <RolesScreen
      rows={page.data}
      total={page.meta.total}
      state={state}
      catalogue={catalogue.data}
    />
  );
}
