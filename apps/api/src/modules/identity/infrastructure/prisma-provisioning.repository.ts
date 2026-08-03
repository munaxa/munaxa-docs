import { Inject, Injectable } from '@nestjs/common';

import type { PermissionKey, RoleId, TenantId, UserId } from '@edms/domain';

import { PrismaService } from '../../../core/prisma/prisma.service';
import { requireTransaction } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';
import type { ProvisioningRepository } from '../application/ports';

/**
 * The bootstrap writes.
 *
 * `slugExists` and `createTenant` go through `PrismaService` directly rather than joining a
 * transaction, because at that point there is no tenant context to open one under — the same
 * reason `PrismaTenantDirectory` does. Everything after them is inside the caller's
 * transaction and inside the new tenant's context, like every other write in the product.
 */
@Injectable()
export class PrismaProvisioningRepository implements ProvisioningRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async slugExists(slug: string): Promise<boolean> {
    const existing = await this.prisma.tenant.findFirst({ where: { slug }, select: { id: true } });
    return existing !== null;
  }

  async createTenant(tenant: { id: TenantId; slug: string; name: string }): Promise<void> {
    await this.prisma.tenant.create({
      data: { id: tenant.id, slug: tenant.slug, name: tenant.name, status: 'ACTIVE' },
    });
  }

  async createAdminRole(role: {
    id: RoleId;
    key: string;
    name: string;
    permissions: readonly PermissionKey[];
  }): Promise<void> {
    const { tenantId } = requireContext();
    await requireTransaction().role.create({
      data: {
        id: role.id,
        tenantId,
        key: role.key,
        name: role.name,
        isSystem: true,
        permissions: {
          create: role.permissions.map((permission) => ({ tenantId, permission })),
        },
      },
    });
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
