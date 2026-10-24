import 'reflect-metadata';

import { PrismaClient } from '@prisma/client';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Permission } from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import { ScryptPasswordHasher } from '../modules/identity/infrastructure/scrypt-password-hasher';

/**
 * A malformed identifier in the path, over HTTP against a real database — finding D-10.
 *
 * The release smoke met `/api/v1/documents/undefined/content` answering **500**: the id went to the
 * database as given, and Prisma raised `P2023` ("Error creating UUID") from the query. The filter
 * recognises that error by its text, so this suite asks the real database for it rather than a
 * fixture that would agree with any text.
 */

const OWNER_URL = process.env['DATABASE_MIGRATION_URL'] ?? '';
const APP_URL = process.env['DATABASE_URL'] ?? '';
const PASSWORD = 'correct horse battery staple';

const run = uuidv7().replaceAll('-', '').slice(-12);
const TENANT = { id: uuidv7(), slug: `malformed-${run}` } as const;
const email = `ada-${run}@malformed-identifier.test`;

delete process.env['TENANT_ID'];
delete process.env['TENANT_SLUG'];
delete process.env['TENANT_CATALOGUE_PATH'];
process.env['TENANT_CATALOGUE'] = JSON.stringify({
  tenants: [
    {
      ...TENANT,
      database: { url: APP_URL, migrationUrl: OWNER_URL },
      storage: { driver: 'LOCAL', container: 'munaxa-docs', prefix: `tenants/${TENANT.slug}` },
      search: { index: `docs-${TENANT.slug}` },
    },
  ],
});

let app: INestApplication;
let base: string;
let accessToken: string;

interface Reply {
  readonly status: number;
  readonly body: { code?: string; accessToken?: string } | null;
}

async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Reply> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined && { 'content-type': 'application/json' }),
      ...(accessToken !== undefined && { authorization: `Bearer ${accessToken}` }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? null : (JSON.parse(text) as Reply['body']),
  };
}

async function seed(): Promise<void> {
  const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  const passwordHash = await new ScryptPasswordHasher().hash(PASSWORD);
  const roleId = uuidv7();
  try {
    await owner.tenant.create({
      data: { id: TENANT.id, slug: TENANT.slug, name: 'Malformed identifier', status: 'ACTIVE' },
    });
    await owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SELECT set_config('app.tenant_id', $1, true)", TENANT.id);
      await tx.role.create({
        data: {
          id: roleId,
          tenantId: TENANT.id,
          key: `MALFORMED_IDENTIFIER_${run.toUpperCase()}`,
          name: 'Malformed identifier fixture',
          isSystem: false,
          permissions: { create: [{ tenantId: TENANT.id, permission: Permission.DOCUMENT_VIEW }] },
        },
      });
      await tx.user.create({
        data: {
          id: uuidv7(),
          tenantId: TENANT.id,
          email,
          emailNormalized: email,
          displayName: 'Malformed Identifier',
          status: 'ACTIVE',
          passwordHash,
          passwordAlgorithm: 'SCRYPT',
          roles: { create: [{ tenantId: TENANT.id, roleId }] },
        },
      });
    });
  } finally {
    await owner.$disconnect();
  }
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
  if (!OWNER_URL || !APP_URL) {
    throw new Error(
      'DATABASE_URL and DATABASE_MIGRATION_URL must be set: this suite needs a database.',
    );
  }
  await seed();
  await clearSignInLimiter();

  const { AppModule } = await import('../app.module');
  const { configureApp } = await import('../bootstrap');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  await app.listen(0);
  base = `http://127.0.0.1:${new URL(await app.getUrl()).port}`;

  const signedIn = await call('POST', '/api/v1/auth/login', {
    email,
    password: PASSWORD,
    tenant: TENANT.slug,
  });
  expect(signedIn.status).toBe(200);
  accessToken = signedIn.body?.accessToken ?? '';
}, 180_000);

afterAll(async () => {
  await app?.close();
});

describe('a malformed identifier in the path (D-10)', () => {
  it.each(['undefined', 'not-a-uuid', '1', "1' OR '1'='1"])(
    'answers 404 NOT_FOUND for /documents/%s, not 500',
    async (id) => {
      const reply = await call('GET', `/api/v1/documents/${encodeURIComponent(id)}`);

      expect(reply.status).toBe(404);
      expect(reply.body?.code).toBe('NOT_FOUND');
    },
  );

  it('answers exactly as a well-formed id that names no document does', async () => {
    const malformed = await call('GET', '/api/v1/documents/undefined');
    const unknown = await call('GET', `/api/v1/documents/${uuidv7()}`);

    expect(malformed.status).toBe(unknown.status);
    expect(malformed.body?.code).toBe(unknown.body?.code);
  });
});
