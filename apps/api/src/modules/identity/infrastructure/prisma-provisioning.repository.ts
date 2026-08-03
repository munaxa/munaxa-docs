import { Injectable } from '@nestjs/common';

import type { AnyId, PermissionKey, RoleId, TenantId, UserId } from '@edms/domain';

import { requireTransaction } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';
import type { ProvisioningRepository } from '../application/ports';

/**
 * The bootstrap writes.
 *
 * Every one of them now joins the caller's transaction, including the tenant row itself. Phase 1 could
 * not do that: the tenant identifier was generated here, so there was no context to open a transaction
 * under until the row existed. Under ADR-0015 the identifier comes from the registry — an operator
 * knows it before provisioning runs, because it is what routes the tenant to its database — so the
 * context exists first and the whole bootstrap is one transaction.
 *
 * That is not tidiness. A half-provisioned tenant is a workspace nobody can enter and nobody can fix,
 * and the tenant row written outside the transaction was the one piece that could survive a rollback.
 */
@Injectable()
export class PrismaProvisioningRepository implements ProvisioningRepository {
  async alreadyProvisioned(tenantId: TenantId): Promise<boolean> {
    const existing = await requireTransaction().tenant.findUnique({
      where: { id: tenantId },
      select: { id: true },
    });
    return existing !== null;
  }

  async createTenant(tenant: { id: TenantId; slug: string; name: string }): Promise<void> {
    await requireTransaction().tenant.create({
      data: { id: tenant.id, slug: tenant.slug, name: tenant.name, status: 'ACTIVE' },
    });
  }

  async createRootScope(scope: {
    companyId: AnyId;
    entityId: AnyId;
    code: string;
    name: string;
  }): Promise<void> {
    const { tenantId } = requireContext();
    const tx = requireTransaction();

    await tx.company.create({
      data: { id: scope.companyId, tenantId, code: scope.code, name: scope.name },
    });
    await tx.entity.create({
      data: {
        id: scope.entityId,
        tenantId,
        companyId: scope.companyId,
        code: scope.code,
        name: scope.name,
      },
    });
  }

  async createSystemRoles(
    roles: readonly {
      id: RoleId;
      key: string;
      name: string;
      description: string;
      permissions: readonly PermissionKey[];
    }[],
  ): Promise<void> {
    const { tenantId } = requireContext();
    const tx = requireTransaction();

    // `isSystem` on all of them: the product refers to these eight by key, so the keys are fixed and
    // the rows cannot be deleted. Their names and permissions are editable like any other role's.
    await tx.role.createMany({
      data: roles.map((role) => ({
        id: role.id,
        tenantId,
        key: role.key,
        name: role.name,
        description: role.description,
        isSystem: true,
      })),
    });

    const grants = roles.flatMap((role) =>
      role.permissions.map((permission) => ({ tenantId, roleId: role.id, permission })),
    );
    if (grants.length > 0) {
      await tx.rolePermission.createMany({ data: grants });
    }
  }

  async createAdminUser(user: {
    id: UserId;
    roleId: RoleId;
    email: string;
    emailNormalized: string;
    displayName: string;
    passwordHash: string;
  }): Promise<void> {
    const { tenantId } = requireContext();
    await requireTransaction().user.create({
      data: {
        id: user.id,
        tenantId,
        email: user.email,
        emailNormalized: user.emailNormalized,
        displayName: user.displayName,
        // Active immediately: an invitation nobody can send yet would leave the tenant with no
        // way in, which is the problem this exists to solve.
        status: 'ACTIVE',
        passwordHash: user.passwordHash,
        passwordAlgorithm: 'SCRYPT',
        roles: { create: [{ tenantId, roleId: user.roleId }] },
      },
    });
  }
}
