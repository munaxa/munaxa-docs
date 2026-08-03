import { readFileSync } from 'node:fs';

import { Inject, Injectable } from '@nestjs/common';

import { TenantStatus } from '@edms/domain';

import { APP_CONFIG, type AppConfig } from '../config';
import {
  type TenantPlacement,
  TenantCatalogueError,
  tenantCatalogueSchema,
  resolveCatalogue,
} from './tenant-placement';
import type { TenantRegistry } from './tenant-registry.port';

/**
 * The tenant registry, from validated configuration.
 *
 * This is the adapter both deployments use today. On premise the catalogue is *implicit* — one tenant
 * whose database is `DATABASE_URL` and whose storage and search are the process's own — so an
 * installation needs no extra file to configure. In the cloud it is a document, inline or mounted,
 * listing every tenant with a template supplying whatever each entry does not state.
 *
 * **Resolved once, at construction.** A catalogue that failed to parse is a process that does not
 * start, naming the tenant and the field — rather than a process that starts and answers the first
 * request for the affected tenant with a 500. The cost is that adding a tenant to a running cloud
 * deployment means a restart, and that is the honest limit of a configuration-driven registry: the
 * `TenantRegistry` port exists so a control-plane adapter can lift it without anything above moving.
 *
 * Closed tenants are dropped rather than kept and refused later. A closed tenant has no valid request,
 * so holding its connection string in memory buys nothing and risks something.
 */
@Injectable()
export class ConfigTenantRegistry implements TenantRegistry {
  private readonly placements: readonly TenantPlacement[];
  private readonly bySlugIndex: ReadonlyMap<string, TenantPlacement>;
  private readonly byIdIndex: ReadonlyMap<string, TenantPlacement>;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.placements = resolveCatalogue(catalogueFor(config)).filter(
      (placement) => placement.status !== TenantStatus.CLOSED,
    );
    this.bySlugIndex = new Map(this.placements.map((placement) => [placement.slug, placement]));
    this.byIdIndex = new Map(this.placements.map((placement) => [placement.id, placement]));
  }

  bySlug(slug: string): Promise<TenantPlacement | null> {
    return Promise.resolve(this.bySlugIndex.get(slug.trim().toLowerCase()) ?? null);
  }

  byId(tenantId: string): Promise<TenantPlacement | null> {
    return Promise.resolve(this.byIdIndex.get(tenantId) ?? null);
  }

  all(): Promise<readonly TenantPlacement[]> {
    return Promise.resolve(this.placements);
  }
}

/**
 * The catalogue this configuration describes, whichever way it describes it.
 *
 * The single-tenant case is built here rather than being written into a file by an installer, because
 * an installation that already has `DATABASE_URL`, `STORAGE_BUCKET` and a slug has said everything a
 * catalogue would repeat. Asking for it twice is asking for the two to disagree.
 */
export function catalogueFor(config: AppConfig): ReturnType<typeof tenantCatalogueSchema.parse> {
  const { tenants } = config.deployment;

  if (tenants.source === 'SINGLE') {
    return {
      tenants: [
        {
          id: tenants.id,
          slug: tenants.slug,
          database: {
            url: config.database.url,
            ...(config.database.migrationUrl !== null && {
              migrationUrl: config.database.migrationUrl,
            }),
          },
          storage: {
            // `NONE` is not a placement — it is the absence of one — so the placement records the
            // driver an installation would use, and the port still fails loudly until an adapter
            // exists. Recording `NONE` here would make the isolation prefix meaningless.
            driver: config.storage.driver === 'NONE' ? 'LOCAL' : config.storage.driver,
            container: config.storage.bucket ?? 'munaxa-docs',
            // A prefix even for one tenant. It is what `TenantScopedStorage` validates against, so a
            // single-tenant install exercises exactly the same isolation check as a shared bucket —
            // and an installation that later grows a second tenant does not have to move any bytes.
            prefix: tenants.slug,
            ...(config.storage.region !== null && { region: config.storage.region }),
            ...(config.storage.endpoint !== null && { endpoint: config.storage.endpoint }),
          },
          search: { index: tenants.slug },
        },
      ],
    };
  }

  const document = tenants.source === 'INLINE' ? tenants.document : readCatalogueFile(tenants.path);
  const parsed = tenantCatalogueSchema.safeParse(parseJson(document, tenants.source));
  if (!parsed.success) {
    throw new TenantCatalogueError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return parsed.data;
}

function readCatalogueFile(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    // The path, never the contents: a catalogue holds connection strings, and an unreadable-file
    // error is not the place to discover that they end up in a log.
    throw new TenantCatalogueError([
      `TENANT_CATALOGUE_PATH: cannot read ${path} (${error instanceof Error ? error.message : 'unknown error'})`,
    ]);
  }
}

function parseJson(document: string, source: string): unknown {
  try {
    return JSON.parse(document);
  } catch {
    // Deliberately without the parser's own message, which quotes the surrounding text — and the
    // surrounding text of a malformed catalogue is a connection string.
    throw new TenantCatalogueError([`${source}: the catalogue is not valid JSON`]);
  }
}
