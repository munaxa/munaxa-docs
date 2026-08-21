import { Injectable } from '@nestjs/common';

import {
  type PermissionKey,
  type RoleId,
  type UserId,
  type UserStatusKey,
  asId,
  isPermissionKey,
} from '@edms/domain';

import { requireTransaction } from '../../../core/prisma/unit-of-work';
import type { CredentialRepository, UserCredentialRecord } from '../application/ports';

/**
 * Credential reads and writes.
 *
 * Every query joins the transaction opened by the use case (`requireTransaction()`), which is
 * also the transaction carrying `app.tenant_id` — so row-level security scopes these reads
 * whether or not the `where` clause remembers to. There is deliberately no `tenantId`
 * parameter anywhere in this class: a repository that accepts one is a repository that can be
 * handed the wrong one.
 */
@Injectable()
export class PrismaCredentialRepository implements CredentialRepository {
  async findByEmail(email: string): Promise<UserCredentialRecord | null> {
    const row = await requireTransaction().user.findFirst({
      where: { emailNormalized: email, deletedAt: null },
      include: { roles: LIVE_ROLES },
    });
    return row ? toRecord(row) : null;
  }

  async findById(id: UserId): Promise<UserCredentialRecord | null> {
    const row = await requireTransaction().user.findFirst({
      where: { id, deletedAt: null },
      include: { roles: LIVE_ROLES },
    });
    return row ? toRecord(row) : null;
  }

  async updatePasswordHash(id: UserId, encodedHash: string, at: Date): Promise<void> {
    await requireTransaction().user.update({
      where: { id },
      data: {
        passwordHash: encodedHash,
        passwordAlgorithm: 'SCRYPT',
        passwordUpdatedAt: at,
      },
    });
  }

  async recordSignIn(id: UserId, at: Date): Promise<void> {
    await requireTransaction().user.update({ where: { id }, data: { lastLoginAt: at } });
  }
}

/**
 * The roles a credential actually carries: the live ones — Slice 22.
 *
 * This is the sign-in and refresh query, and it is where a withdrawn role stopped granting
 * anything. `setRoleDeleted` stamps the role and leaves its `role_permission` rows and its
 * `user_role` rows exactly where they were, so without this filter every permission of a deleted
 * role was still unioned into `permissions` below and into the access token minted from it.
 *
 * Filtering here rather than only at the writers is deliberate. `RoleAdminService.delete` refuses
 * while `memberCount > 0`, so the administrative path cannot leave a holder behind — but
 * `PrismaFederatedUserRepository.provision` could, and any future writer of `user_role` can. This is
 * the one place every path passes through, so it is where "a role the tenant withdrew grants
 * nothing" is worth enforcing rather than assuming.
 *
 * A restore is unaffected and needs no compensation: `setRoleDeleted(false)` clears the stamp, the
 * role is live again, and the next refresh resolves its permissions exactly as before.
 */
const LIVE_ROLES = {
  where: { role: { deletedAt: null } },
  include: { role: { include: { permissions: true } } },
} as const;

/** The shape the include above produces. Named so the mapper below reads as a mapper. */
interface UserRow {
  id: string;
  email: string;
  displayName: string;
  status: string;
  passwordHash: string | null;
  mfaEnrolled: boolean;
  permissionVersion: number;
  roles: { role: { id: string; key: string; permissions: { permission: string }[] } }[];
}

function toRecord(row: UserRow): UserCredentialRecord {
  const permissions = new Set<PermissionKey>();
  for (const assignment of row.roles) {
    for (const grant of assignment.role.permissions) {
      // Narrowed against the catalogue rather than cast. A permission removed from the product
      // but still sitting in a role row grants nothing, which is the safe direction.
      if (isPermissionKey(grant.permission)) {
        permissions.add(grant.permission);
      }
    }
  }

  return {
    id: asId<UserId>(row.id),
    email: row.email,
    displayName: row.displayName,
    status: row.status as UserStatusKey,
    passwordHash: row.passwordHash,
    mfaEnrolled: row.mfaEnrolled,
    permissionVersion: row.permissionVersion,
    roleIds: row.roles.map((assignment) => asId<RoleId>(assignment.role.id)),
    roleKeys: row.roles.map((assignment) => assignment.role.key),
    permissions: [...permissions],
  };
}
