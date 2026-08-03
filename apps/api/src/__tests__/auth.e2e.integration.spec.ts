import 'reflect-metadata';

import { PrismaClient } from '@prisma/client';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Permission } from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import { ScryptPasswordHasher } from '../modules/identity/infrastructure/scrypt-password-hasher';

/**
 * The whole API over HTTP: real guards, real middleware, real database, real crypto.
 *
 * Everything below the controller has its own tests. What only this level can check is the
 * assembly — the global guard chain, the versioned route prefix, the exception filter's shape.
 * It earned its place immediately: the tenant isolation guard refused every sign-in, because a
 * public route naming a tenant looked exactly like an authenticated one trying to escape its
 * own. No unit test could see that, since none of them run the guard chain.
 */

const OWNER_URL = process.env['DATABASE_MIGRATION_URL'] ?? '';
const APP_URL = process.env['DATABASE_URL'] ?? '';
const PASSWORD = 'correct horse battery staple';

const tenantId = uuidv7();
const slug = `e2e-${tenantId.replaceAll('-', '').slice(-12)}`;
const email = 'ada@e2e.test';

let app: INestApplication;
let baseUrl: string;

/** What the API answers with. Declared here rather than imported: a test that shares the
 * production type cannot notice the production type changing shape. */
interface AuthBody {
  accessToken: string;
  refreshToken: string;
  user: { displayName: string; permissions: string[] };
}
interface ProblemBody {
  code: string;
  detail: string;
}
interface MeBody {
  tenantId: string;
  permissions: string[];
}

interface Response<TBody> {
  readonly status: number;
  readonly body: TBody;
}

async function post<TBody>(path: string, body: unknown): Promise<Response<TBody>> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json().catch(() => null)) as TBody };
}

async function get<TBody>(path: string, accessToken?: string): Promise<Response<TBody>> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
  });
  return { status: response.status, body: (await response.json().catch(() => null)) as TBody };
}

beforeAll(async () => {
  if (!OWNER_URL || !APP_URL) {
    throw new Error('DATABASE_URL and DATABASE_MIGRATION_URL must both be set.');
  }

  const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  const passwordHash = await new ScryptPasswordHasher().hash(PASSWORD);
  const roleId = uuidv7();

  await owner.tenant.create({ data: { id: tenantId, slug, name: 'E2E Ltd', status: 'ACTIVE' } });
  await owner.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SELECT set_config('app.tenant_id', $1, true)", tenantId);
    await tx.role.create({
      data: {
        id: roleId,
        tenantId,
        key: 'TENANT_ADMIN',
        name: 'Tenant administrator',
        isSystem: true,
        permissions: { create: [{ tenantId, permission: Permission.USER_MANAGE }] },
      },
    });
    await tx.user.create({
      data: {
        id: uuidv7(),
        tenantId,
        email,
        emailNormalized: email,
        displayName: 'Ada Lovelace',
        status: 'ACTIVE',
        passwordHash,
        passwordAlgorithm: 'SCRYPT',
        roles: { create: [{ tenantId, roleId }] },
      },
    });
  });
  await owner.$disconnect();

  const { AppModule } = await import('../app.module');
  const { configureApp } = await import('../bootstrap');

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  // The production setup, called rather than re-created: guard order, route prefix, URI
  // versioning and the validation pipe are the things this test exists to exercise.
  configureApp(app);
  await app.init();
  await app.listen(0);
  baseUrl = (await app.getUrl()).replace('[::1]', 'localhost');
}, 120_000);

afterAll(async () => {
  await app?.close();
});

describe('authentication over HTTP', () => {
  let refreshToken: string;

  it('signs in and returns both tokens', async () => {
    const { status, body } = await post<AuthBody>('/api/v1/auth/login', {
      email,
      password: PASSWORD,
      tenant: slug,
    });

    expect(status).toBe(200);
    expect(body.user.displayName).toBe('Ada Lovelace');
    expect(body.user.permissions).toEqual([Permission.USER_MANAGE]);
    expect(body.accessToken.split('.')).toHaveLength(3);
    expect(typeof body.refreshToken).toBe('string');
    refreshToken = body.refreshToken;
  });

  it('accepts the access token on a guarded route', async () => {
    const { body: session } = await post<AuthBody>('/api/v1/auth/login', {
      email,
      password: PASSWORD,
      tenant: slug,
    });

    const { status, body } = await get<MeBody>('/api/v1/auth/me', session.accessToken);

    expect(status).toBe(200);
    expect(body.tenantId).toBe(tenantId);
    expect(body.permissions).toEqual([Permission.USER_MANAGE]);
  });

  it('refuses a guarded route with no token', async () => {
    const { status, body } = await get<ProblemBody>('/api/v1/auth/me');

    expect(status).toBe(401);
    expect(body.code).toBe('UNAUTHENTICATED');
  });

  it('refuses a guarded route with a forged token', async () => {
    const { status } = await get<ProblemBody>('/api/v1/auth/me', 'not.a.token');

    expect(status).toBe(401);
  });

  it('answers a wrong password and an unknown address identically', async () => {
    const wrong = await post<ProblemBody>('/api/v1/auth/login', {
      email,
      password: 'a completely different password',
      tenant: slug,
    });
    const unknown = await post<ProblemBody>('/api/v1/auth/login', {
      email: 'nobody@e2e.test',
      password: PASSWORD,
      tenant: slug,
    });

    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.code).toBe(unknown.body.code);
    expect(wrong.body.detail).toBe(unknown.body.detail);
  });

  it('rotates the refresh token, and a replay kills the family', async () => {
    const rotated = await post<AuthBody>('/api/v1/auth/refresh', { refreshToken, tenant: slug });
    expect(rotated.status).toBe(200);
    expect(rotated.body.refreshToken).not.toBe(refreshToken);

    const replay = await post<ProblemBody>('/api/v1/auth/refresh', { refreshToken, tenant: slug });
    expect(replay.status).toBe(401);

    // The successor is dead too: the family, not the token, is the unit of revocation.
    const successor = await post<ProblemBody>('/api/v1/auth/refresh', {
      refreshToken: rotated.body.refreshToken,
      tenant: slug,
    });
    expect(successor.status).toBe(401);
  });

  it('ends a session on sign-out', async () => {
    const { body: session } = await post<AuthBody>('/api/v1/auth/login', {
      email,
      password: PASSWORD,
      tenant: slug,
    });

    const out = await post<null>('/api/v1/auth/logout', {
      refreshToken: session.refreshToken,
      tenant: slug,
    });
    expect(out.status).toBe(204);

    const after = await post<ProblemBody>('/api/v1/auth/refresh', {
      refreshToken: session.refreshToken,
      tenant: slug,
    });
    expect(after.status).toBe(401);
  });

  it('records every attempt in the audit trail, successes and failures alike', async () => {
    const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
    // The tenant context has to be set even for the owner: FORCE ROW LEVEL SECURITY applies to
    // the table owner too, so a `WHERE tenant_id = …` on a context-less session matches
    // nothing at all. The predicate is not what scopes this read — the policy is.
    const rows = await owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SELECT set_config('app.tenant_id', $1, true)", tenantId);
      return tx.$queryRawUnsafe<{ action: string; sequence: bigint }[]>(
        'SELECT action, sequence FROM audit_event ORDER BY sequence',
      );
    });
    await owner.$disconnect();

    const actions = rows.map((row) => row.action);
    expect(actions).toContain('LOGIN_SUCCEEDED');
    expect(actions).toContain('LOGIN_FAILED');
    expect(actions).toContain('SESSION_REVOKED');

    // Gap-free, whatever order the tests ran in.
    expect(rows.map((row) => Number(row.sequence))).toEqual(
      Array.from({ length: rows.length }, (_, index) => index + 1),
    );
  });
});
