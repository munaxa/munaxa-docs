import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Permission } from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import { BULK_BODY_LIMIT_BYTES } from '../core/http/body-limits';
import { ScryptPasswordHasher } from '../modules/identity/infrastructure/scrypt-password-hasher';

/**
 * Request size over the real HTTP pipeline — RC validation, D-17 (and D-16's answer on the wire).
 *
 * Reproduced live first: every route read bodies under the platform's 100 KiB default, so a bulk
 * request past ~2 600 identifiers — well inside `bulk.maxObjects`' default of 5 000 — was refused
 * before any validation ran, and refused as a **500** logged against correlation id "unknown",
 * because the body parser's error was not one the exception filter recognised.
 *
 * This boots the real container through `configureApp`, as `auth.e2e.integration.spec.ts` does,
 * because what is under test is the pipeline's order: which parser reads which body, and what the
 * filter makes of a body it could not read. Queue consumers are off: a queued operation is
 * asserted as accepted, not executed.
 */

const OWNER_URL = process.env['DATABASE_MIGRATION_URL'] ?? '';
const APP_URL = process.env['DATABASE_URL'] ?? '';
const PASSWORD = 'correct horse battery staple';

const tenantId = uuidv7();
const slug = `rs-${tenantId.replaceAll('-', '').slice(-12)}`;
const email = 'bulk@request-size.test';

process.env['TENANT_ID'] = tenantId;
process.env['TENANT_SLUG'] = slug;
process.env['QUEUE_CONSUMERS_ENABLED'] = 'false';

let app: INestApplication;
let baseUrl: string;
let token: string;
let owner: PrismaClient;

interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown> | null;
}

async function send(path: string, raw: string, authenticated = true): Promise<Reply> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authenticated ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: raw,
  });
  const text = await response.text();
  let body: Reply['body'] = null;
  try {
    body = JSON.parse(text) as Reply['body'];
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

const ids = (count: number): string[] => Array.from({ length: count }, () => randomUUID());
const metadataEdit = (count: number): string =>
  JSON.stringify({ ids: ids(count), categoryId: null });

beforeAll(async () => {
  if (!OWNER_URL || !APP_URL) {
    throw new Error('DATABASE_URL and DATABASE_MIGRATION_URL must both be set.');
  }
  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  const passwordHash = await new ScryptPasswordHasher().hash(PASSWORD);
  const roleId = uuidv7();
  await owner.tenant.create({
    data: { id: tenantId, slug, name: 'Request Size Ltd', status: 'ACTIVE' },
  });
  await owner.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SELECT set_config('app.tenant_id', $1, true)", tenantId);
    await tx.role.create({
      data: {
        id: roleId,
        tenantId,
        key: 'BULK_EDITOR',
        name: 'Bulk editor',
        isSystem: false,
        permissions: {
          create: [
            Permission.DOCUMENT_VIEW,
            Permission.DOCUMENT_EDIT,
            Permission.DOCUMENT_CREATE,
            Permission.DOCUMENT_APPROVE,
          ].map((permission) => ({ tenantId, permission })),
        },
      },
    });
    await tx.user.create({
      data: {
        id: uuidv7(),
        tenantId,
        email,
        emailNormalized: email,
        displayName: 'Bulk Editor',
        status: 'ACTIVE',
        passwordHash,
        passwordAlgorithm: 'SCRYPT',
        roles: { create: [{ tenantId, roleId }] },
      },
    });
  });

  // A clean limiter, for the reason `auth.e2e.integration.spec.ts` gives.
  const { RedisCacheAdapter } = await import('../infrastructure/cache/redis-cache.adapter');
  const { loadConfig } = await import('../core/config/configuration');
  const cache = new RedisCacheAdapter(loadConfig());
  await cache.deleteByPrefix('rl:');
  await cache.onModuleDestroy();

  const { AppModule } = await import('../app.module');
  const { configureApp } = await import('../bootstrap');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  await app.listen(0);
  baseUrl = (await app.getUrl()).replace('[::1]', 'localhost');

  const signIn = await send(
    '/api/v1/auth/login',
    JSON.stringify({ email, password: PASSWORD, tenant: slug }),
    false,
  );
  // Also the guard on the parser's registration: a bulk parser that shadowed the platform's would
  // leave this route — every non-bulk route — without a body.
  expect(signIn.status).toBe(200);
  token = String(signIn.body?.['accessToken']);
}, 120_000);

afterAll(async () => {
  await app?.close();
  await owner?.$disconnect();
});

describe('a bulk request is read up to the size its own contract promises (D-17)', () => {
  it('runs an ordinary bulk request, answering the unreachable as the single routes do', async () => {
    const reply = await send('/api/v1/documents/bulk/metadata', metadataEdit(3));

    expect(reply.status).toBe(201);
    const items = reply.body?.['items'] as { outcome: string; errorCode: string; detail: string }[];
    expect(items).toHaveLength(3);
    // D-16 on the wire: identifiers that name nothing get the single routes' NOT_FOUND sentence.
    for (const item of items) {
      expect(item).toMatchObject({
        outcome: 'REFUSED',
        errorCode: 'NOT_FOUND',
        detail: 'That item does not exist, or you do not have access to it.',
      });
    }
  });

  it('accepts the configured maximum — 5 000 identifiers, twice the old body limit', async () => {
    const raw = metadataEdit(5_000);
    expect(Buffer.byteLength(raw)).toBeGreaterThan(100 * 1024);

    const reply = await send('/api/v1/documents/bulk/metadata', raw);

    // Over `bulk.synchronousLimit`, so queued rather than run in the request — and read in full.
    expect(reply.status).toBe(201);
    expect(reply.body).toMatchObject({ state: 'REQUESTED', tally: { requested: 5_000 } });
  });

  it('refuses one past bulk.maxObjects in the bulk layer, as a validation failure', async () => {
    const before = await owner.bulkOperation.count({ where: { tenantId } });
    const reply = await send('/api/v1/documents/bulk/metadata', metadataEdit(5_001));

    expect(reply.status).toBe(422);
    expect(reply.body).toMatchObject({ code: 'VALIDATION_FAILED' });
    // Refused before any operation existed.
    expect(await owner.bulkOperation.count({ where: { tenantId } })).toBe(before);
  });

  it('answers a body past the bulk transport limit with 413, not 500', async () => {
    const raw = metadataEdit(Math.ceil(BULK_BODY_LIMIT_BYTES / 39) + 1_000);
    expect(Buffer.byteLength(raw)).toBeGreaterThan(BULK_BODY_LIMIT_BYTES);
    const before = await owner.bulkOperation.count({ where: { tenantId } });

    const reply = await send('/api/v1/documents/bulk/metadata', raw);

    expect(reply.status).toBe(413);
    expect(reply.body).toMatchObject({ status: 413, code: 'VALIDATION_FAILED' });
    expect(await owner.bulkOperation.count({ where: { tenantId } })).toBe(before);
  });

  it('reads the approval bulk route under the same allowance', async () => {
    const raw = JSON.stringify({ taskIds: ids(4_000), decision: 'APPROVED' });
    expect(Buffer.byteLength(raw)).toBeGreaterThan(100 * 1024);

    const reply = await send('/api/v1/approval-tasks/bulk/decisions', raw);

    expect([413, 500]).not.toContain(reply.status);
  });
});

describe('every other route keeps its own limit', () => {
  const padded = (fields: Record<string, unknown>): string =>
    JSON.stringify({ ...fields, padding: 'x'.repeat(150 * 1024) });

  it('refuses a 150 KiB sign-in with 413, before anything reads it', async () => {
    const reply = await send(
      '/api/v1/auth/login',
      padded({ email, password: PASSWORD, tenant: slug }),
      false,
    );
    expect(reply.status).toBe(413);
    expect(reply.body).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses a 150 KiB document creation with 413', async () => {
    const reply = await send('/api/v1/documents', padded({ title: 'Too large' }));
    expect(reply.status).toBe(413);
  });

  it('answers a body that is not JSON with 400, not 500', async () => {
    const reply = await send('/api/v1/documents/bulk/metadata', '{"ids": [');
    expect(reply.status).toBe(400);
    expect(reply.body).toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
