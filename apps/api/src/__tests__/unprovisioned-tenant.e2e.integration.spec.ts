import 'reflect-metadata';

import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { uuidv7 } from '@edms/utils';

/**
 * SMK-1: a sign-in to a tenant that is in the catalogue and migrated, but not provisioned yet.
 *
 * That is a real state of every new tenant: the operator adds it to the catalogue and migrates its
 * database, and only provisioning writes its `tenant` row and first administrator (go-live §6). In
 * between, the registry resolves the slug — it reads the catalogue — while the database has no row
 * for it. The rejected sign-in's audit record references that row, so the release smoke found the
 * request answering **500** from `audit_event_tenant_id_fkey` instead of refusing the sign-in.
 *
 * The tenant here is exactly that state: its database is one CI has migrated (the second tenant
 * database), and its catalogue id is fresh, so no `tenant` row carries it.
 */

const SECOND_OWNER_URL = process.env['SECOND_DATABASE_MIGRATION_URL'] ?? '';
const SECOND_APP_URL = process.env['SECOND_DATABASE_URL'] ?? '';

const PENDING = { id: uuidv7(), slug: `pending-${uuidv7().slice(-8)}` } as const;

delete process.env['TENANT_ID'];
delete process.env['TENANT_SLUG'];
delete process.env['TENANT_CATALOGUE_PATH'];
process.env['TENANT_CATALOGUE'] = JSON.stringify({
  tenants: [
    {
      ...PENDING,
      database: { url: SECOND_APP_URL, migrationUrl: SECOND_OWNER_URL },
      storage: { driver: 'LOCAL', container: 'munaxa-docs', prefix: `tenants/${PENDING.slug}` },
      search: { index: `docs-${PENDING.slug}` },
    },
  ],
});

let app: INestApplication;
let base: string;

interface Reply {
  readonly status: number;
  readonly body: { code?: string; accessToken?: string; refreshToken?: string } | null;
}

async function post(path: string, body: unknown): Promise<Reply> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? null : (JSON.parse(text) as Reply['body']),
  };
}

/** As in auth.e2e: one address makes every request here, and sign-in is rate limited per address. */
async function clearSignInLimiter(): Promise<void> {
  const { RedisCacheAdapter } = await import('../infrastructure/cache/redis-cache.adapter');
  const { loadConfig } = await import('../core/config/configuration');
  const cache = new RedisCacheAdapter(loadConfig());
  await cache.deleteByPrefix('rl:');
  await cache.onModuleDestroy();
}

beforeAll(async () => {
  if (!SECOND_OWNER_URL || !SECOND_APP_URL) {
    throw new Error(
      'SECOND_DATABASE_URL and SECOND_DATABASE_MIGRATION_URL must be set: this suite needs a ' +
        'migrated tenant database.',
    );
  }
  await clearSignInLimiter();

  const { AppModule } = await import('../app.module');
  const { configureApp } = await import('../bootstrap');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  await app.listen(0);
  base = `http://127.0.0.1:${new URL(await app.getUrl()).port}`;
}, 180_000);

afterAll(async () => {
  await app?.close();
});

describe('a catalogue tenant that is migrated but not provisioned (SMK-1)', () => {
  it('refuses the sign-in with 401 and issues no token — not a 500', async () => {
    const reply = await post('/api/v1/auth/login', {
      email: 'ada@pending.test',
      password: 'correct horse battery staple',
      tenant: PENDING.slug,
    });

    expect(reply.status).toBe(401);
    expect(reply.body?.code).toBe('UNAUTHENTICATED');
    expect(reply.body?.accessToken).toBeUndefined();
    expect(reply.body?.refreshToken).toBeUndefined();
  });

  it('answers exactly as an unknown tenant does, so it does not reveal the tenant exists', async () => {
    const body = { email: 'ada@pending.test', password: 'correct horse battery staple' };
    const pending = await post('/api/v1/auth/login', { ...body, tenant: PENDING.slug });
    const unknown = await post('/api/v1/auth/login', { ...body, tenant: 'no-such-tenant' });

    expect(pending.status).toBe(unknown.status);
    expect(pending.body?.code).toBe(unknown.body?.code);
  });

  it('refuses refresh and sign-out against it with 401, not a 500', async () => {
    const body = { refreshToken: 'not-a-refresh-token', tenant: PENDING.slug };

    expect((await post('/api/v1/auth/refresh', body)).status).toBe(401);
    expect((await post('/api/v1/auth/logout', body)).status).toBe(401);
  });
});
