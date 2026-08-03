import { Inject, Injectable } from '@nestjs/common';

import { type TenantId, TenantStatus, asId } from '@edms/domain';

import { PrismaService } from '../../../core/prisma/prisma.service';
import type { TenantDirectory } from '../application/authentication.ports';

/**
 * Resolves a tenant slug to its identifier.
 *
 * This is the one repository in the product that reads through `PrismaService` directly
 * rather than joining an ambient transaction, and it is the one that may: it runs *before*
 * any tenant context exists, because determining the tenant is precisely what it is for.
 * `tenant` is correspondingly the one table with no row-level security policy — it has no
 * `tenant_id` to key one on.
 *
 * A closed or deleted tenant resolves to nothing, so its people cannot sign in. A suspended
 * one still resolves: suspension makes a tenant read-only, and read-only requires being able
 * to read (`docs/architecture/adr/0002-multi-tenant-isolation-model.md`).
 */
@Injectable()
export class PrismaTenantDirectory implements TenantDirectory {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async findIdBySlug(slug: string): Promise<TenantId | null> {
    const normalized = slug.trim().toLowerCase();
    if (normalized.length === 0) {
      return null;
    }
    const row = await this.prisma.tenant.findFirst({
      where: {
        slug: normalized,
        deletedAt: null,
        status: { in: [TenantStatus.ACTIVE, TenantStatus.SUSPENDED] },
      },
      select: { id: true },
    });
    return row ? asId<TenantId>(row.id) : null;
  }
}
