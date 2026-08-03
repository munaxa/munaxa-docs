import { Inject, Injectable } from '@nestjs/common';

import { type TenantId, TenantStatus, asId } from '@edms/domain';

import { TENANT_REGISTRY, type TenantRegistry } from '../../../core/tenancy/tenant-registry.port';
import type { TenantDirectory } from '../application/authentication.ports';

/**
 * Resolves a sign-in slug to a tenant identifier, from the registry.
 *
 * Phase 1 answered this with a query against a shared `tenant` table, and under ADR-0015 there is no
 * such table to query: each tenant's rows live in its own database, and the question "which database"
 * is precisely what has to be answered *before* a query can be issued. So the answer comes from the
 * registry — the same place `TenantDatabase` gets the connection string from, which is what makes the
 * two impossible to disagree.
 *
 * That removes the one query in the product that ran outside a tenant context. Sign-in now touches a
 * database only after it knows which one, and every statement it issues is inside that tenant's
 * transaction like every other statement in the product.
 *
 * A closed tenant does not resolve, so its people cannot sign in — the registry drops it. A suspended
 * one does resolve: suspension makes a tenant read-only, and read-only requires being able to read.
 * Whether it is suspended is then read from the tenant row *inside* the transaction, because a status
 * read from configuration at boot is stale for as long as the process lives.
 */
@Injectable()
export class RegistryTenantDirectory implements TenantDirectory {
  constructor(@Inject(TENANT_REGISTRY) private readonly registry: TenantRegistry) {}

  async findIdBySlug(slug: string): Promise<TenantId | null> {
    const normalized = slug.trim().toLowerCase();
    if (normalized.length === 0) {
      return null;
    }
    const placement = await this.registry.bySlug(normalized);
    if (!placement || placement.status === TenantStatus.CLOSED) {
      return null;
    }
    return asId<TenantId>(placement.id);
  }
}
