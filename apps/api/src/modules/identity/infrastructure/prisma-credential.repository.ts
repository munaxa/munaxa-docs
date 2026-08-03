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
      include: { roles: { include: { role: { include: { permissions: true } } } } },
    });
    return row ? toRecord(row) : null;
  }

  async findById(id: UserId): Promise<UserCredentialRecord | null> {
    const row = await requireTransaction().user.findFirst({
      where: { id, deletedAt: null },
      include: { roles: { include: { role: { include: { permissions: true } } } } },
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
