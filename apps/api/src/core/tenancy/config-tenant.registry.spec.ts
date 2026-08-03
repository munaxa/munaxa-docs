import { describe, expect, it } from 'vitest';

import { TenantStatus } from '@edms/domain';

import type { AppConfig } from '../config/configuration';
import { ConfigTenantRegistry } from './config-tenant.registry';
import { TenantCatalogueError, resolveCatalogue } from './tenant-placement';

/**
 * The registry is the first thing a process reads and the last thing anybody checks, so the tests are
 * about the mistakes an operator actually makes: a copied entry, a template with a typo, a tenant added
 * to the catalogue but never given a database.
 *
 * Every one of them is a boot failure. That is the design: a placement resolved lazily would turn a
 * misconfigured tenant into a 500 for one customer, and the operator would hear about it from them.
 */

const ACME = '019489f0-0000-7000-8000-0000000000a1';
const RIVAL = '019489f0-0000-7000-8000-0000000000b2';

function configWith(
  tenants: AppConfig['deployment']['tenants'],
  overrides: Partial<AppConfig['storage']> = {},
): AppConfig {
  return {
    deployment: { profile: 'CLOUD', tenants },
    database: { url: 'postgresql://app@localhost:5432/edms', migrationUrl: null },
    storage: { driver: 'S3', bucket: 'shared', region: null, endpoint: null, ...overrides },
  } as unknown as AppConfig;
}

function inline(catalogue: unknown): AppConfig {
  return configWith({ source: 'INLINE', document: JSON.stringify(catalogue) });
}

describe('deriving one tenant from the environment', () => {
  it('needs no catalogue at all, which is what an on-premise install has', () => {
    const registry = new ConfigTenantRegistry(
      configWith({ source: 'SINGLE', id: ACME, slug: 'acme' }),
    );

    return registry.bySlug('acme').then((placement) => {
      expect(placement).toMatchObject({
        id: ACME,
        slug: 'acme',
        database: { url: 'postgresql://app@localhost:5432/edms' },
        // A prefix even for one tenant, so the isolation check is exercised in the deployment that has
        // only one — and so growing a second tenant later moves no bytes.
        storage: { container: 'shared', prefix: 'acme' },
        search: { index: 'acme' },
      });
    });
  });

  it('records a real driver even when none is configured yet', async () => {
    // `NONE` is the absence of a placement rather than a placement, and recording it would make the
    // isolation prefix meaningless. The port still refuses until an adapter exists.
    const registry = new ConfigTenantRegistry(
      configWith({ source: 'SINGLE', id: ACME, slug: 'acme' }, { driver: 'NONE', bucket: null }),
    );
    await expect(registry.bySlug('acme')).resolves.toMatchObject({
      storage: { driver: 'LOCAL', container: 'munaxa-docs' },
    });
  });
});

describe('reading a catalogue', () => {
  it('fills each entry from the templates, so a hundred tenants are a hundred lines', async () => {
    const registry = new ConfigTenantRegistry(
      inline({
        defaults: {
          databaseUrlTemplate: 'postgresql://app@db/edms_{slug}',
          migrationUrlTemplate: 'postgresql://owner@db/edms_{slug}',
          storage: { driver: 'S3', container: 'munaxa-docs', prefixTemplate: 'tenants/{slug}' },
          search: { indexTemplate: 'docs-{slug}' },
        },
        tenants: [
          { id: ACME, slug: 'acme' },
          { id: RIVAL, slug: 'rival' },
        ],
      }),
    );

    await expect(registry.byId(ACME)).resolves.toMatchObject({
      database: {
        url: 'postgresql://app@db/edms_acme',
        migrationUrl: 'postgresql://owner@db/edms_acme',
      },
      storage: { prefix: 'tenants/acme' },
      search: { index: 'docs-acme' },
    });
    await expect(registry.byId(RIVAL)).resolves.toMatchObject({
      database: { url: 'postgresql://app@db/edms_rival' },
      storage: { prefix: 'tenants/rival' },
    });
  });

  it('lets an entry override anything it inherits', async () => {
    // The tenant that outgrew the shared cluster and was moved to its own, which is the whole reason
    // per-tenant placement exists.
    const registry = new ConfigTenantRegistry(
      inline({
        defaults: {
          databaseUrlTemplate: 'postgresql://app@shared/edms_{slug}',
          storage: { driver: 'S3', container: 'munaxa-docs' },
        },
        tenants: [
          { id: ACME, slug: 'acme', database: { url: 'postgresql://app@dedicated/acme' } },
          { id: RIVAL, slug: 'rival' },
        ],
      }),
    );

    await expect(registry.byId(ACME)).resolves.toMatchObject({
      database: { url: 'postgresql://app@dedicated/acme' },
    });
  });

  it('drops a closed tenant rather than holding its connection string', async () => {
    const registry = new ConfigTenantRegistry(
      inline({
        defaults: {
          databaseUrlTemplate: 'postgresql://app@db/edms_{slug}',
          storage: { driver: 'S3', container: 'b' },
        },
        tenants: [
          { id: ACME, slug: 'acme', status: TenantStatus.CLOSED },
          { id: RIVAL, slug: 'rival' },
        ],
      }),
    );

    await expect(registry.bySlug('acme')).resolves.toBeNull();
    await expect(registry.byId(ACME)).resolves.toBeNull();
    await expect(registry.all()).resolves.toHaveLength(1);
  });

  it('keeps a suspended tenant, because read-only requires being able to read', async () => {
    const registry = new ConfigTenantRegistry(
      inline({
        defaults: {
          databaseUrlTemplate: 'postgresql://app@db/edms_{slug}',
          storage: { driver: 'S3', container: 'b' },
        },
        tenants: [{ id: ACME, slug: 'acme', status: TenantStatus.SUSPENDED }],
      }),
    );
    await expect(registry.bySlug('acme')).resolves.toMatchObject({ status: 'SUSPENDED' });
  });

  it('answers nothing for a slug it does not know', async () => {
    // Null rather than an error: "which organisations exist" is not a question an unauthenticated
    // endpoint answers, so an unknown slug has to be indistinguishable from a wrong password.
    const registry = new ConfigTenantRegistry(
      inline({
        defaults: {
          databaseUrlTemplate: 'postgresql://app@db/edms_{slug}',
          storage: { driver: 'S3', container: 'b' },
        },
        tenants: [{ id: ACME, slug: 'acme' }],
      }),
    );
    await expect(registry.bySlug('somebody-else')).resolves.toBeNull();
    await expect(registry.byId(RIVAL)).resolves.toBeNull();
  });

  it('refuses a catalogue that is not valid JSON, without quoting it', () => {
    // The surrounding text of a malformed catalogue is a connection string.
    try {
      new ConfigTenantRegistry(configWith({ source: 'INLINE', document: '{ "tenants": [' }));
      expect.unreachable('expected the catalogue to be refused');
    } catch (error) {
      expect(error).toBeInstanceOf(TenantCatalogueError);
      expect((error as Error).message).not.toContain('postgresql://');
    }
  });

  it('names the file it could not read, and nothing else', () => {
    expect(
      () => new ConfigTenantRegistry(configWith({ source: 'FILE', path: '/nowhere/tenants.json' })),
    ).toThrowError(/nowhere\/tenants\.json/);
  });
});

describe('refusing a catalogue that would share infrastructure', () => {
  const defaults = { storage: { driver: 'S3' as const, container: 'munaxa-docs' } };

  it('refuses two tenants pointed at one database', () => {
    expect(() =>
      resolveCatalogue({
        defaults,
        tenants: [
          {
            id: ACME,
            slug: 'acme',
            database: { url: 'postgresql://app@db/edms' },
            storage: { prefix: 'acme' },
          },
          {
            id: RIVAL,
            slug: 'rival',
            database: { url: 'postgresql://app@db/edms' },
            storage: { prefix: 'rival' },
          },
        ],
      }),
    ).toThrowError(/shares its database/);
  });

  it('refuses two tenants pointed at one storage location', () => {
    // The interesting mistake: a copied entry with its own database and a prefix nobody changed. It
    // looks correct in every other respect, and it shares a customer's bytes.
    expect(() =>
      resolveCatalogue({
        defaults: { databaseUrlTemplate: 'postgresql://app@db/edms_{slug}', ...defaults },
        tenants: [
          { id: ACME, slug: 'acme', storage: { prefix: 'acme' } },
          { id: RIVAL, slug: 'rival', storage: { prefix: 'acme' } },
        ],
      }),
    ).toThrowError(/shares its storage location/);
  });

  it('refuses two tenants pointed at one search index', () => {
    expect(() =>
      resolveCatalogue({
        defaults: { databaseUrlTemplate: 'postgresql://app@db/edms_{slug}', ...defaults },
        tenants: [
          { id: ACME, slug: 'acme', search: { index: 'docs' } },
          { id: RIVAL, slug: 'rival', search: { index: 'docs' } },
        ],
      }),
    ).toThrowError(/shares its search index/);
  });

  it('refuses a duplicated identifier or slug', () => {
    expect(() =>
      resolveCatalogue({
        defaults: { databaseUrlTemplate: 'postgresql://app@db/edms_{slug}', ...defaults },
        tenants: [
          { id: ACME, slug: 'acme' },
          { id: ACME, slug: 'rival' },
        ],
      }),
    ).toThrowError(/shares its identifier/);
  });

  it('names the tenant and the field when a placement cannot be completed', () => {
    // A tenant in the catalogue with no database is a customer nobody can sign in as. Found at boot,
    // by name, rather than by them telling us.
    expect(() =>
      resolveCatalogue({ defaults, tenants: [{ id: ACME, slug: 'acme' }] }),
    ).toThrowError(/acme: no database URL/);
  });
});
