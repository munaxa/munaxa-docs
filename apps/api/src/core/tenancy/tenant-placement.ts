import { z } from 'zod';

import { StorageDriver, TenantStatus } from '@edms/domain';

/**
 * Where one tenant's infrastructure lives.
 *
 * This is the whole of what the platform needs to know in order to serve a company: which database
 * holds its rows, which storage holds its bytes, which index answers its searches. Everything else
 * about a tenant — its name, its settings, its people — lives *inside* that database, because it is
 * business data and this is not.
 *
 * The separation is the point of the file. A placement is infrastructure: it contains connection
 * strings and bucket names, and it is resolved by `core/`. No domain type, no application service and
 * no use case ever sees one. What they see is a tenant id, and the infrastructure underneath them
 * routes on it — which is what lets the same business logic run against a shared cluster in the cloud
 * and a single Postgres on a customer's own server
 * ([ADR-0015](../../../../../docs/architecture/adr/0015-database-per-tenant.md)).
 *
 * A placement is **not** authoritative about whether a tenant may be used. `status` here is a routing
 * hint that keeps a closed tenant from being connected to at all; the tenant row inside the database
 * is what a request reads, inside the transaction, because a value read at boot is stale for as long
 * as the process lives.
 */

/**
 * A slug, which is also an infrastructure identifier.
 *
 * It appears in a database name, a storage prefix and an index name, so the rule is the intersection
 * of what all three accept: lower-case letters, digits and hyphens, starting with a letter. That is
 * narrower than a URL segment needs to be, and deliberately — a slug that is legal in a URL but not
 * in a PostgreSQL identifier is a tenant that cannot be given a database.
 */
export const tenantSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(48)
  .regex(
    /^[a-z][a-z0-9-]*$/,
    'A tenant slug is lower-case letters, digits and hyphens, starting with a letter.',
  );

const databasePlacementSchema = z.object({
  /** The application role's connection string. No `BYPASSRLS`. */
  url: z.string().url(),
  /**
   * The owner role's connection string, used only by the migration runner.
   *
   * Optional because a deployment may keep it out of the running application's environment
   * entirely, which is the safer arrangement: the process serving requests then holds no credential
   * that can alter a table.
   */
  migrationUrl: z.string().url().optional(),
});

const storagePlacementSchema = z.object({
  driver: z.nativeEnum(StorageDriver),
  /** The bucket, container, or — for `LOCAL` — the root directory. */
  container: z.string().trim().min(1),
  /**
   * The prefix every key of this tenant's is written under.
   *
   * Present even when the container is already exclusive to the tenant, because it is what
   * `TenantScopedStorage` validates against. A shared bucket with per-tenant prefixes and a bucket
   * per tenant are then the same code path, and the isolation check does not depend on which was
   * configured.
   */
  prefix: z.string().trim().min(1),
  region: z.string().trim().min(1).optional(),
  endpoint: z.string().url().optional(),
});

const searchPlacementSchema = z.object({
  /** The index, collection or schema this tenant's documents are projected into. */
  index: z.string().trim().min(1),
});

export const tenantPlacementSchema = z.object({
  id: z.string().uuid(),
  slug: tenantSlugSchema,
  /** Human-readable, for operator output and log lines. Never shown to a tenant's users. */
  name: z.string().trim().min(1).max(200).optional(),
  status: z.nativeEnum(TenantStatus).default(TenantStatus.ACTIVE),
  database: databasePlacementSchema,
  storage: storagePlacementSchema,
  search: searchPlacementSchema,
});

export type TenantPlacement = z.infer<typeof tenantPlacementSchema>;
export type DatabasePlacement = TenantPlacement['database'];
export type StoragePlacement = TenantPlacement['storage'];
export type SearchPlacement = TenantPlacement['search'];

/**
 * A catalogue entry as an operator writes it, before defaults are applied.
 *
 * Almost everything is optional, because almost everything is derivable. A hundred tenants on one
 * pattern should be a hundred lines of `{ "id": …, "slug": … }`, not a hundred copies of a
 * connection string with one word changed — and a copied connection string with one word *not*
 * changed is two tenants sharing a database, which is the failure this whole phase exists to remove.
 */
export const tenantEntrySchema = z.object({
  id: z.string().uuid(),
  slug: tenantSlugSchema,
  name: z.string().trim().min(1).max(200).optional(),
  status: z.nativeEnum(TenantStatus).optional(),
  database: databasePlacementSchema.partial().optional(),
  storage: storagePlacementSchema.partial().optional(),
  search: searchPlacementSchema.partial().optional(),
});

export type TenantEntry = z.infer<typeof tenantEntrySchema>;

/**
 * The defaults an entry inherits, and the templates that derive the rest.
 *
 * `{slug}` is the only placeholder, and it is substituted into a database URL, a storage prefix and
 * an index name. One token rather than a small language: a template engine here would be a way to
 * express a placement that no validator could check.
 */
export const catalogueDefaultsSchema = z.object({
  databaseUrlTemplate: z.string().min(1).optional(),
  migrationUrlTemplate: z.string().min(1).optional(),
  storage: storagePlacementSchema
    .partial()
    .extend({ prefixTemplate: z.string().min(1).optional() })
    .optional(),
  search: z.object({ indexTemplate: z.string().min(1).optional() }).optional(),
});

export const tenantCatalogueSchema = z.object({
  defaults: catalogueDefaultsSchema.optional(),
  tenants: z.array(tenantEntrySchema).min(1),
});

export type TenantCatalogue = z.infer<typeof tenantCatalogueSchema>;

/** Substitutes the one placeholder. Absent from the template is fine; a leftover one is not. */
export function fillTemplate(template: string, slug: string): string {
  return template.replaceAll('{slug}', slug);
}

export class TenantCatalogueError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid tenant catalogue:\n  - ${issues.join('\n  - ')}`);
    this.name = 'TenantCatalogueError';
  }
}

/**
 * Resolves a catalogue into complete placements.
 *
 * Every gap is filled from the defaults, and anything still missing is an error naming the tenant and
 * the field — at boot, not at the first request that needed it. A tenant whose database URL was never
 * configured is a tenant nobody can sign in to, and finding that out from a 500 is finding it out
 * from a customer.
 *
 * Two placements sharing a database URL, a storage prefix or a search index is refused outright. That
 * is the whole promise of this phase, and it is exactly the mistake a copied catalogue entry makes.
 */
export function resolveCatalogue(catalogue: TenantCatalogue): readonly TenantPlacement[] {
  const defaults = catalogue.defaults ?? {};
  const issues: string[] = [];
  const placements: TenantPlacement[] = [];

  for (const entry of catalogue.tenants) {
    const url =
      entry.database?.url ??
      (defaults.databaseUrlTemplate === undefined
        ? undefined
        : fillTemplate(defaults.databaseUrlTemplate, entry.slug));
    const migrationUrl =
      entry.database?.migrationUrl ??
      (defaults.migrationUrlTemplate === undefined
        ? undefined
        : fillTemplate(defaults.migrationUrlTemplate, entry.slug));

    const storageDefaults = defaults.storage ?? {};
    const driver = entry.storage?.driver ?? storageDefaults.driver;
    const container = entry.storage?.container ?? storageDefaults.container;
    const prefix =
      entry.storage?.prefix ??
      (storageDefaults.prefixTemplate === undefined
        ? entry.slug
        : fillTemplate(storageDefaults.prefixTemplate, entry.slug));
    const region = entry.storage?.region ?? storageDefaults.region;
    const endpoint = entry.storage?.endpoint ?? storageDefaults.endpoint;

    const index =
      entry.search?.index ??
      (defaults.search?.indexTemplate === undefined
        ? entry.slug
        : fillTemplate(defaults.search.indexTemplate, entry.slug));

    if (url === undefined) {
      issues.push(`${entry.slug}: no database URL, and no databaseUrlTemplate to derive one from`);
      continue;
    }
    if (driver === undefined) {
      issues.push(`${entry.slug}: no storage driver, and no default to inherit`);
      continue;
    }
    if (container === undefined) {
      issues.push(`${entry.slug}: no storage container, and no default to inherit`);
      continue;
    }

    const parsed = tenantPlacementSchema.safeParse({
      id: entry.id,
      slug: entry.slug,
      ...(entry.name !== undefined && { name: entry.name }),
      ...(entry.status !== undefined && { status: entry.status }),
      database: { url, ...(migrationUrl !== undefined && { migrationUrl }) },
      storage: {
        driver,
        container,
        prefix,
        ...(region !== undefined && { region }),
        ...(endpoint !== undefined && { endpoint }),
      },
      search: { index },
    });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        issues.push(`${entry.slug}: ${issue.path.join('.') || '(root)'}: ${issue.message}`);
      }
      continue;
    }
    placements.push(parsed.data);
  }

  issues.push(...collisions(placements));

  if (issues.length > 0) {
    throw new TenantCatalogueError(issues);
  }
  return Object.freeze(placements);
}

/**
 * Two tenants pointed at the same thing.
 *
 * Reported per resource rather than as one "duplicate entry", because the interesting case is a
 * *partial* copy: an entry with its own database but a prefix somebody forgot to change shares a
 * tenant's bytes while looking correct in every other respect.
 */
function collisions(placements: readonly TenantPlacement[]): readonly string[] {
  const issues: string[] = [];
  const seen = {
    id: new Map<string, string>(),
    slug: new Map<string, string>(),
    database: new Map<string, string>(),
    storage: new Map<string, string>(),
    search: new Map<string, string>(),
  };

  for (const placement of placements) {
    const claims: readonly [keyof typeof seen, string, string][] = [
      ['id', placement.id, 'identifier'],
      ['slug', placement.slug, 'slug'],
      ['database', placement.database.url, 'database'],
      ['storage', `${placement.storage.container}/${placement.storage.prefix}`, 'storage location'],
      ['search', placement.search.index, 'search index'],
    ];
    for (const [key, value, label] of claims) {
      const owner = seen[key].get(value);
      if (owner !== undefined) {
        issues.push(`${placement.slug}: shares its ${label} with ${owner}`);
      } else {
        seen[key].set(value, placement.slug);
      }
    }
  }
  return issues;
}
