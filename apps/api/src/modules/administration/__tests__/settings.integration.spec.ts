import 'reflect-metadata';

import { PrismaClient } from '@prisma/client';
import { beforeAll, describe, expect, it } from 'vitest';

import { type TenantId, Settings, asId } from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import type { AppConfig } from '../../../core/config/configuration';
import type { Logger } from '../../../core/observability/logger';
import { PrismaService } from '../../../core/prisma/prisma.service';
import { type RequestContext, runWithContext } from '../../../core/tenancy/tenant-context';
import { FakeCache } from '../../../testing/fake-ports';
import { CachedSettingsReader } from '../infrastructure/cached-settings.reader';
import { PrismaTenantSettingsRepository } from '../infrastructure/prisma-tenant-settings.repository';

/**
 * `tenant` is the one table with no row-level security policy — it has no `tenant_id` to key
 * one on — so the explicit filter in the repository is the *only* thing keeping one tenant's
 * configuration away from another's. Everywhere else the database is a second line of defence;
 * here it is not, which is exactly why these run against a real one.
 */

const OWNER_URL = process.env['DATABASE_MIGRATION_URL'] ?? '';
const APP_URL = process.env['DATABASE_URL'] ?? '';

const ACME = asId<TenantId>(uuidv7());
const OTHER = asId<TenantId>(uuidv7());

const config = { env: 'test', database: { url: APP_URL, poolSize: 5 } } as unknown as AppConfig;
const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const prisma = new PrismaService(config, logger);
const repository = new PrismaTenantSettingsRepository(prisma);
const cache = new FakeCache();
const reader = new CachedSettingsReader(repository, cache, logger);

function contextFor(tenantId: TenantId): RequestContext {
  return {
    tenantId,
    userId: null,
    roles: [],
    permissions: [],
    sessionId: null,
    correlationId: 'settings-integration',
    permissionVersion: 0,
    locale: 'en',
  };
}

function asTenant<T>(tenantId: TenantId, work: () => Promise<T>): Promise<T> {
  return runWithContext(contextFor(tenantId), work);
}

beforeAll(async () => {
  if (!OWNER_URL || !APP_URL) {
    throw new Error('DATABASE_URL and DATABASE_MIGRATION_URL must both be set.');
  }
  const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  for (const [tenantId, slug] of [
    [ACME, `acme-settings-${Date.now()}`],
    [OTHER, `other-settings-${Date.now()}`],
  ] as const) {
    await owner.tenant.create({ data: { id: tenantId, slug, name: slug, status: 'ACTIVE' } });
  }
  await owner.$disconnect();
});

describe('tenant settings against PostgreSQL', () => {
  it('stores a value and reads it back', async () => {
    await asTenant(ACME, async () => {
      await repository.set(Settings.DEFAULT_LOCALE.key, 'ar');
      await reader.invalidate(ACME);

      expect(await reader.get(Settings.DEFAULT_LOCALE)).toBe('ar');
    });
  });

  it('writing one setting leaves the others alone', async () => {
    await asTenant(ACME, async () => {
      await repository.set(Settings.TIMEZONE.key, 'Asia/Amman');
      await repository.set(Settings.PASSWORD_MINIMUM_LENGTH.key, 16);
      await reader.invalidate(ACME);

      // The read-modify-write this replaces would have dropped one of the three: each writer
      // builds a bag from its own read, and the last one wins. `jsonb_set` merges instead.
      expect(await reader.get(Settings.DEFAULT_LOCALE)).toBe('ar');
      expect(await reader.get(Settings.TIMEZONE)).toBe('Asia/Amman');
      expect(await reader.get(Settings.PASSWORD_MINIMUM_LENGTH)).toBe(16);
    });
  });

  it('survives concurrent writes of different settings', async () => {
    await asTenant(ACME, async () => {
      await Promise.all([
        repository.set(Settings.TIMEZONE.key, 'Europe/London'),
        repository.set(Settings.SESSION_IDLE_TIMEOUT_MINUTES.key, 60),
        repository.set(Settings.PASSWORD_FORBID_IDENTIFIERS.key, false),
      ]);
      await reader.invalidate(ACME);

      expect(await reader.get(Settings.TIMEZONE)).toBe('Europe/London');
      expect(await reader.get(Settings.SESSION_IDLE_TIMEOUT_MINUTES)).toBe(60);
      expect(await reader.get(Settings.PASSWORD_FORBID_IDENTIFIERS)).toBe(false);
    });
  });

  it('keeps one tenant’s configuration away from another’s', async () => {
    const theirs = await asTenant(OTHER, async () => {
      await reader.invalidate(OTHER);
      return reader.get(Settings.DEFAULT_LOCALE);
    });

    // ACME set 'ar'; this tenant set nothing and must see the product default.
    expect(theirs).toBe('en');
  });

  it('refuses a key the catalogue does not declare', async () => {
    await asTenant(ACME, async () => {
      await expect(repository.set('locale.invented', 'x')).rejects.toThrowError(
        /not a setting this product defines/,
      );
    });
  });

  it('falls back to the default when the stored value is hand-edited into nonsense', async () => {
    const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
    await owner.$executeRawUnsafe(
      `UPDATE "tenant" SET "settings" = jsonb_set("settings", '{security.password.minimumLength}', '"not a number"'::jsonb, true) WHERE "id" = $1::uuid`,
      ACME,
    );
    await owner.$disconnect();

    const value = await asTenant(ACME, async () => {
      await reader.invalidate(ACME);
      return reader.get(Settings.PASSWORD_MINIMUM_LENGTH);
    });

    expect(value).toBe(12);
  });
});
