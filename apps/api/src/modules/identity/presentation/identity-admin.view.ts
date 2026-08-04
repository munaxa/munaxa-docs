import type { Collection, PermissionCatalogue, Role, User } from '@edms/contracts';
import type { Page } from '@edms/utils';

import type { PermissionDescriptorRow } from '../application/role-admin.service';
import type { RoleAdminRow, UserAdminRow } from '../application/administration.ports';

/**
 * Rows to wire shapes.
 *
 * Every field named, so adding a column to `user` is not the same commit as adding a field to a
 * public contract. That matters more here than anywhere else in the product: the row this maps from
 * is the one the credential columns live on.
 */

export function toUser(row: UserAdminRow): User {
  return {
    id: row.id,
    version: row.version,
    email: row.email,
    displayName: row.displayName,
    status: row.status,
    mfaEnrolled: row.mfaEnrolled,
    lastLoginAt: row.lastLoginAt === null ? null : row.lastLoginAt.toISOString(),
    // Whether one is set, never what it is.
    hasPassword: row.hasPassword,
    roles: row.roles.map((role) => ({ id: role.id, key: role.key, name: role.name })),
    departments: row.departments.map((membership) => ({
      departmentId: membership.departmentId,
      name: membership.name,
      code: membership.code,
      isPrimary: membership.isPrimary,
    })),
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
    deletedAt: row.deletedAt === null ? null : row.deletedAt.toISOString(),
    deletedBy: row.deletedBy,
  };
}

export function toRole(row: RoleAdminRow): Role {
  return {
    id: row.id,
    version: row.version,
    key: row.key,
    name: row.name,
    description: row.description,
    isSystem: row.isSystem,
    permissions: [...row.permissions],
    memberCount: row.memberCount,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
    deletedAt: row.deletedAt === null ? null : row.deletedAt.toISOString(),
    deletedBy: row.deletedBy,
  };
}

export function toPermissionCatalogue(
  rows: readonly PermissionDescriptorRow[],
): PermissionCatalogue {
  return {
    data: rows.map((row) => ({
      key: row.key,
      resource: row.resource,
      action: row.action,
      survivesBrokenInheritance: row.survivesBrokenInheritance,
    })),
  };
}

export function toCollection<TRow, TItem>(
  page: Page<TRow>,
  map: (row: TRow) => TItem,
): Collection<TItem> {
  return { data: page.data.map(map), meta: page.meta };
}
