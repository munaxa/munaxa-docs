import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TenantStatus } from '@edms/domain';

import type { AppConfig } from '../config';
import type { Logger } from '../observability/logger';
import type { TenantPlacement } from '../tenancy/tenant-placement';
import type { TenantRegistry } from '../tenancy/tenant-registry.port';
import { TenantDatabase, withPoolSize } from './tenant-database';

/**
 * `DATABASE_POOL_SIZE` is documented as the size of each tenant's pool, and the connection budget in
 * ADR-0015 and ADR-0021 is `DATABASE_MAX_TENANT_CLIENTS × DATABASE_POOL_SIZE`. For as long as the value
 * stopped at configuration, every tenant client ran on Prisma's own default instead. These tests hold
 * the value to the one place Prisma reads it: the `connection_limit` of the URL each client is built
 * with.
 */

const constructed = vi.hoisted(() => [] as { datasources: { db: { url: string } } }[]);

vi.mock('@prisma/client', () => ({
  PrismaClient: class {
    constructor(options: { datasources: { db: { url: string } } }) {
      constructed.push(options);
    }
    $connect(): Promise<void> {
      return Promise.resolve();
    }
    $disconnect(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

const ACME = '019489f0-0000-7000-8000-0000000000a1';

function placement(url: string): TenantPlacement {
  return {
    id: ACME,
    slug: 'acme',
    status: TenantStatus.ACTIVE,
    database: { url },
    storage: { driver: 'S3', container: 'shared', prefix: 'acme' },
    search: { index: 'acme' },
  };
}

function databaseFor(url: string, poolSize: number): TenantDatabase {
  const config = {
    database: {
      url,
      migrationUrl: null,
      poolSize,
      statementTimeoutMs: 15_000,
      maxTenantClients: 25,
    },
  } as unknown as AppConfig;
  const registry: TenantRegistry = {
    bySlug: () => Promise.resolve(placement(url)),
    byId: () => Promise.resolve(placement(url)),
    all: () => Promise.resolve([placement(url)]),
  };
  const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return new TenantDatabase(config, logger as unknown as Logger, registry);
}

describe('withPoolSize', () => {
  it('sets connection_limit to the configured pool size', () => {
    const url = new URL(withPoolSize('postgresql://app:secret@db.internal:5432/edms_acme', 10));
    expect(url.searchParams.get('connection_limit')).toBe('10');
  });

  it('respects an explicitly configured value', () => {
    const url = new URL(withPoolSize('postgresql://app:secret@db.internal:5432/edms_acme', 4));
    expect(url.searchParams.get('connection_limit')).toBe('4');
  });

  it('replaces a connection_limit already in the catalogue URL, so the budget is the configured one', () => {
    const url = new URL(
      withPoolSize('postgresql://app:secret@db.internal:5432/edms_acme?connection_limit=50', 10),
    );
    expect(url.searchParams.getAll('connection_limit')).toEqual(['10']);
  });

  it('leaves the credentials, host, database and every other parameter as they were', () => {
    const url = new URL(
      withPoolSize(
        'postgresql://app:p%40ss%2Fword@db.internal:5432/edms_acme?sslmode=require&schema=public',
        10,
      ),
    );
    expect(url.username).toBe('app');
    expect(url.password).toBe('p%40ss%2Fword');
    expect(url.host).toBe('db.internal:5432');
    expect(url.pathname).toBe('/edms_acme');
    expect(url.searchParams.get('sslmode')).toBe('require');
    expect(url.searchParams.get('schema')).toBe('public');
  });
});

describe('a tenant client', () => {
  beforeEach(() => {
    constructed.length = 0;
  });

  it('is built with the configured DATABASE_POOL_SIZE as its pool', async () => {
    await databaseFor('postgresql://app:secret@db.internal:5432/edms_acme', 7).clientFor(ACME);

    expect(constructed).toHaveLength(1);
    const url = new URL(constructed[0]!.datasources.db.url);
    expect(url.searchParams.get('connection_limit')).toBe('7');
    expect(url.pathname).toBe('/edms_acme');
  });

  it('is built once per tenant and reused, so the pool is per tenant rather than per request', async () => {
    const databases = databaseFor('postgresql://app:secret@db.internal:5432/edms_acme', 10);
    await databases.clientFor(ACME);
    await databases.clientFor(ACME);

    expect(constructed).toHaveLength(1);
  });
});
