import { Inject, Injectable } from '@nestjs/common';

import { isSettingKey } from '@edms/domain';

import { TenantDatabase, type PrismaTransaction } from '../../../core/prisma/tenant-database';
import { currentTransaction } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';
import type { TenantSettingsRepository } from '../application/ports';

/**
 * Tenant settings, stored as one `jsonb` column on `tenant`.
 *
 * One column rather than a row per setting, because settings are always read together and
 * never joined against: the whole bag arrives in the read that resolves the tenant, and a
 * table of key-value rows would buy indexing nobody needs at the cost of a query per screen.
 *
 * `tenant` is the one table with no row-level security policy — it has no `tenant_id` to key
 * one on — so every statement here filters by the ambient tenant explicitly. That is the
 * exception that proves the rule: everywhere else the database would catch a missing filter,
 * and here it would not.
 */
@Injectable()
export class PrismaTenantSettingsRepository implements TenantSettingsRepository {
  constructor(@Inject(TenantDatabase) private readonly databases: TenantDatabase) {}

  async get<TValue>(key: string): Promise<TValue | null> {
    const stored = await this.readAll();
    return (stored[key] as TValue | undefined) ?? null;
  }

  /**
   * Writes one setting, leaving the rest of the bag untouched.
   *
   * Read-modify-write on a `jsonb` column races: two administrators saving different settings
   * at the same time would each write a bag built from their own read, and the later write
   * would silently drop the earlier one's change. `jsonb_set` merges in the database instead,
   * so the update touches exactly the key it names.
   */
  async set<TValue>(key: string, value: TValue): Promise<void> {
    if (!isSettingKey(key)) {
      // A key outside the catalogue cannot be read back by anything, so storing it would only
      // grow a column nobody can enumerate.
      throw new Error(`'${key}' is not a setting this product defines.`);
    }
    const { tenantId } = requireContext();
    const client = await this.client();

    await client.$executeRawUnsafe(
      `UPDATE "tenant"
         SET "settings" = jsonb_set(coalesce("settings", '{}'::jsonb), $2::text[], $3::jsonb, true),
             "updated_at" = now()
       WHERE "id" = $1::uuid`,
      tenantId,
      // A path array, so a key containing a dot is one key rather than a nested object.
      [key],
      JSON.stringify(value),
    );
  }

  /**
   * Drops one key, leaving the rest of the bag untouched.
   *
   * `#-` removes a top-level key from a `jsonb` value, and it is used for the same reason `jsonb_set`
   * is on the way in: two administrators changing different settings at once must not overwrite each
   * other, which a read-modify-write of the whole bag would do silently.
   */
  async remove(key: string): Promise<void> {
    if (!isSettingKey(key)) {
      throw new Error(`'${key}' is not a setting this product defines.`);
    }
    const { tenantId } = requireContext();
    const client = await this.client();

    await client.$executeRawUnsafe(
      `UPDATE "tenant"
          SET "settings" = coalesce("settings", '{}'::jsonb) #- $2::text[],
              "updated_at" = now()
        WHERE "id" = $1::uuid`,
      tenantId,
      // A path array, so a key containing a dot is one key rather than a nested object — the same
      // reasoning as `set`.
      [key],
    );
  }

  /** The whole stored bag, unresolved. Callers resolve it against the catalogue. */
  async readAll(): Promise<Readonly<Record<string, unknown>>> {
    const { tenantId } = requireContext();
    const client = await this.client();

    const row = await client.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });

    const settings = row?.settings;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return {};
    }
    return settings;
  }

  /**
   * The ambient transaction if there is one, otherwise the tenant's own client.
   *
   * The fallback matters because settings are read outside a use case — by the cached reader, warming
   * an entry — and it resolves the *tenant's* database rather than a single shared one. That is the
   * only change ADR-0015 makes to this file: the statement, the `jsonb_set` and the explicit tenant
   * filter are all unchanged.
   *
   * The filter stays even though the database now holds one tenant's rows. `tenant` is the one table
   * with no row-level security policy — it has no `tenant_id` to key one on — so nothing underneath
   * would catch its absence, and an installation with two tenants in one database is a supported
   * shape rather than a hypothetical one.
   */
  private async client(): Promise<
    PrismaTransaction | Awaited<ReturnType<TenantDatabase['clientFor']>>
  > {
    const ambient = currentTransaction();
    return ambient ?? this.databases.clientFor(requireContext().tenantId);
  }
}
