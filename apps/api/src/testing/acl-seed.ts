import type { PrismaClient } from '@prisma/client';

import { ALL_PERMISSIONS, type PermissionKey } from '@edms/domain';

/**
 * Gives a suite's callers a role that actually grants what their context claims.
 *
 * ## Why this exists, and why it exists *now*
 *
 * Every suite before Phase 14 built its request context with `roles: ['TENANT_ADMIN']` and seeded
 * no `role` row, because nothing read one: `AclGuard` was bound to no route (Phase 9's limit row),
 * the document list applied no ACL predicate (Phase 13's), and `PrismaAclResolver` short-circuited
 * to a refusal whenever the role list was empty. A claim in a context that nothing resolves is a
 * claim that cannot be wrong.
 *
 * Phase 14 made the claim resolvable, and every one of those suites found out at once that it had
 * been asserting about a caller who — read strictly — held nothing. That is the discovery the phase
 * was expected to produce, and the honest response is to seed the grant rather than to keep the
 * resolver from asking: a suite that passes because the check does not run is a suite that will
 * keep passing after the check breaks.
 *
 * ## Why it takes the owner client
 *
 * These rows are fixtures, written before the code under test runs, and CI's `edms_owner` is the
 * cluster superuser — so this write goes past row-level security. That is correct **for a role
 * grant**, which is tenant configuration an administrator would have made beforehand, and it is
 * exactly wrong for an ACL entry: an `acl_entry` seeded as the owner is not the row a request would
 * have written, and a suite that seeds one is not testing what a request would see. The ACL suite
 * writes its entries through `PermissionService`, as a request does.
 */
export async function seedRoleGrant(
  owner: PrismaClient,
  input: {
    readonly tenantId: string;
    readonly roleId: string;
    /** Must match the key the suite's request context puts in `roles`. */
    readonly key: string;
    readonly userIds: readonly string[];
    /** Omit for every permission in the catalogue — what `TENANT_ADMIN` means to a suite. */
    readonly permissions?: readonly PermissionKey[];
    readonly now: Date;
  },
): Promise<string> {
  const permissions = input.permissions ?? ALL_PERMISSIONS;
  await owner.role.create({
    data: {
      id: input.roleId,
      tenantId: input.tenantId,
      key: input.key,
      name: input.key,
      isSystem: false,
      updatedAt: input.now,
      permissions: {
        create: permissions.map((permission) => ({ tenantId: input.tenantId, permission })),
      },
    },
  });
  for (const userId of input.userIds) {
    await owner.userRole.create({
      data: { tenantId: input.tenantId, userId, roleId: input.roleId, assignedAt: input.now },
    });
  }
  return input.roleId;
}
