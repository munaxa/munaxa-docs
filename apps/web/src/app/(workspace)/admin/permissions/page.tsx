import type { ReactNode } from 'react';

import type { PermissionCatalogue, Role } from '@edms/contracts';
import { Permission } from '@edms/domain';

import { AdminForbidden } from '../../../../features/admin-shared';
import { PermissionsScreen } from '../../../../features/admin-identity/permissions-screen';
import { adminAccess, adminGet, adminOptions } from '../../../../lib/admin/api';

/**
 * The permission catalogue, cross-referenced against the tenant's roles.
 *
 * Both sides are needed to answer the question this screen exists for — "who can approve" — so both
 * are fetched here and neither is derived in the browser from the other.
 */
export default async function PermissionsPage(): Promise<ReactNode> {
  const access = await adminAccess(Permission.ROLE_MANAGE);
  if (!access.granted) {
    return <AdminForbidden />;
  }

  const [catalogue, roles] = await Promise.all([
    adminGet<PermissionCatalogue>('/admin/roles/permissions'),
    adminOptions<Role>('/admin/roles', 'name'),
  ]);

  return <PermissionsScreen catalogue={catalogue.data} roles={roles.data} />;
}
