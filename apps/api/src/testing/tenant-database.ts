import { StorageDriver, TenantStatus } from '@edms/domain';

import type { AppConfig } from '../core/config/configuration';
import type { Logger } from '../core/observability/logger';
import { TenantDatabase } from '../core/prisma/tenant-database';
import type { TenantPlacement } from '../core/tenancy/tenant-placement';
import type { TenantRegistry } from '../core/tenancy/tenant-registry.port';

/**
 * A `TenantDatabase` for an integration test, over one or more real databases.
 *
 * Two shapes, and both are shapes the product genuinely supports — which is why the tests use them
 * rather than a double.
 *
 * `sharedDatabase` points **every** tenant at one database. That is an on-premise installation serving
 * more than one company from a single PostgreSQL, and it is what the suites inherited from Phase 1
 * assert against: that a tenant column and a row-level security policy keep two tenants apart when
 * they share a database. Nothing about that stopped mattering under ADR-0015 — it is the layer
 * underneath the new one, and it is the layer that a single-database deployment relies on entirely.
 *
 * `placedTenants` gives each tenant its own database, which is the cloud shape, and is what
 * `tenant-isolation.integration.spec.ts` uses to assert the property this phase adds: that one
 * tenant's rows are not merely filtered out of another's queries but absent from the database those
 * queries run against.
 */
export function sharedDatabase(config: AppConfig, logger: Logger, url: string): TenantDatabase {
  return new TenantDatabase(config, logger, everyTenantAt(url));
}

/**
 * A registry for a suite that constructs a service directly.
 *
 * Every *identifier* resolves, because the suites mint a fresh tenant id per run so a failed run leaves
 * no rows a later one trips over. Only the *slugs* named in `slugs` resolve, because a slug that
 * resolves to nothing is a real answer the product gives — an unknown organisation at sign-in, a tenant
 * missing from the catalogue at provisioning — and a registry that invented an identifier for any slug
 * it was handed could not express it.
 */
export function everyTenantRegistry(
  url: string,
  slugs: Readonly<Record<string, string>> = {},
): TenantRegistry {
  const base = everyTenantAt(url);
  return {
    ...base,
    bySlug: (slug) => {
      const id = slugs[slug.trim().toLowerCase()];
      return Promise.resolve(id === undefined ? null : placementFor(id, slug, url));
    },
  };
}

export function placedTenants(
  config: AppConfig,
  logger: Logger,
  urlsByTenantId: Readonly<Record<string, string>>,
): TenantDatabase {
  const placements = Object.entries(urlsByTenantId).map(([id, url], index) =>
    placementFor(id, `tenant-${String(index)}`, url),
  );
  return new TenantDatabase(config, logger, fixedRegistry(placements));
}

/**
 * A registry that resolves any identifier to one database.
 *
 * Deliberately permissive: the suites generate a fresh tenant id per run so that a failed run leaves
 * no rows a later one would trip over, and a registry that had to be told about each of them in advance
 * would make every test carry a placement it does not care about.
 *
 * It is a *test* registry for exactly that reason. The real one refuses an unknown identifier, and
 * `config-tenant.registry.spec.ts` is where that is asserted.
 */
function everyTenantAt(url: string): TenantRegistry {
  return {
    bySlug: () => Promise.resolve(null),
    byId: (tenantId) => Promise.resolve(placementFor(tenantId, tenantId, url)),
    all: () => Promise.resolve([]),
  };
}

function fixedRegistry(placements: readonly TenantPlacement[]): TenantRegistry {
  return {
    bySlug: (slug) =>
      Promise.resolve(placements.find((placement) => placement.slug === slug) ?? null),
    byId: (tenantId) =>
      Promise.resolve(placements.find((placement) => placement.id === tenantId) ?? null),
    all: () => Promise.resolve(placements),
  };
}

function placementFor(id: string, slug: string, url: string): TenantPlacement {
  return {
    id,
    slug,
    status: TenantStatus.ACTIVE,
    database: { url },
    storage: { driver: StorageDriver.LOCAL, container: 'test', prefix: slug },
    search: { index: slug },
  };
}
