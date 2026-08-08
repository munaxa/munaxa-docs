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

/**
 * The single-tenant shape, set before the application is composed.
 *
 * This is the one suite that boots the real container, so it is the one that has to configure tenancy
 * the way a deployment does. Under ADR-0015 a process cannot start without knowing which tenants it
 * serves — there is no default database to fall back on — and an on-premise installation says so with
 * exactly these two variables.
 */
process.env['TENANT_ID'] = tenantId;
process.env['TENANT_SLUG'] = slug;

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

  // A clean limiter, because this suite now runs against a real one — Phase 6.7 Part A.
  //
  // `auth.login` allows ten attempts per five minutes *per address*, and the sign-ins below plus
  // the rate-limit tests at the end exceed that from a single test host. Without this the suite
  // would pass once and fail every rerun inside the window, which is the self-inflicted flakiness
  // a security control must not introduce into its own repository. The fixture owns its
  // preconditions here exactly as it owns the tenant it creates above.
  const { RedisCacheAdapter } = await import('../infrastructure/cache/redis-cache.adapter');
  const { loadConfig } = await import('../core/config/configuration');
  const cache = new RedisCacheAdapter(loadConfig());
  await cache.deleteByPrefix('rl:');
  await cache.onModuleDestroy();

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
    // The predicate is what scopes this read, and it has to be: `edms_owner` is a superuser —
    // the bootstrap role here, `POSTGRES_USER` under compose — and a superuser bypasses
    // row-level security whether or not it is forced. Without `WHERE tenant_id`, this would
    // read every tenant every suite in the run has created, and the gap-free assertion below
    // would fail the moment there were two. The context is still set so the read sees what the
    // application wrote under the same policy.
    const rows = await owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SELECT set_config('app.tenant_id', $1, true)", tenantId);
      return tx.$queryRawUnsafe<{ action: string; sequence: bigint }[]>(
        'SELECT action, sequence FROM audit_event WHERE tenant_id = $1::uuid ORDER BY sequence',
        tenantId,
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

/**
 * The rate limit, over real HTTP — Phase 6.7 Part A's missing proof.
 *
 * Every other rate-limit assertion in this repository invokes `RateLimitGuard.canActivate` with a
 * constructed `ExecutionContext`. That proves the *mechanism* — distributed counting, tenant
 * namespacing, fail-closed behaviour — and proves nothing about whether a request ever reaches it.
 * Phase 6.3 and 6.4 both found controls that were declared, configured and unreachable, so this
 * suite is where the claim becomes true: a request enters the real server, traverses the real
 * `APP_GUARD` chain, and is refused.
 */
describe('rate limiting over HTTP', () => {
  it('refuses the sixth signing attempt with 429, before authorization decides anything', async () => {
    const { body: session } = await post<AuthBody>('/api/v1/auth/login', {
      email,
      password: PASSWORD,
      tenant: slug,
    });

    // Ada holds `user:manage` and not `document:sign`, so authorization will refuse every one of
    // these. That is what makes the assertion sharp: the first five are refused by RBAC and the
    // sixth by the rate limiter, which can only happen if the limiter runs *before* it. The
    // signature domain never sees any of them, so nothing here depends on a signable document.
    const documentId = uuidv7();
    const body = { revisionId: uuidv7(), purpose: 'APPROVAL' };
    const statuses: number[] = [];

    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const response = await fetch(`${baseUrl}/api/v1/documents/${documentId}/signatures`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.accessToken}`,
        },
        body: JSON.stringify(body),
      });
      statuses.push(response.status);
      if (attempt === 6) {
        const problem = (await response.json()) as { code: string; detail: string };
        expect(problem.code).toBe('RATE_LIMITED');
        // The refusal names the outcome and nothing about the infrastructure behind it.
        expect(`${problem.code} ${problem.detail}`).not.toMatch(
          /redis|cache|counter|ECONNREFUSED/i,
        );
      }
    }

    // Five attempts admitted by the limiter (and refused by authorization), the sixth stopped by
    // the limiter itself — `document.sign` is 5 per 15 minutes.
    expect(statuses.slice(0, 5).every((status) => status !== 429)).toBe(true);
    expect(statuses[5]).toBe(429);
  }, 60_000);

  it('limits sign-in before authentication runs, so an anonymous caller is bounded too', async () => {
    // Why `RateLimitGuard` is registered ahead of `AuthenticationGuard`: credential stuffing is
    // unauthenticated by definition, and a limiter that only ran for authenticated callers would
    // leave the one endpoint it targets wide open. `auth.login` is 10 per 5 minutes, keyed on the
    // submitted address — never resolved to an account, so a fictitious address is counted exactly
    // like a real one and this test uses one.
    const stranger = `${uuidv7()}@nobody.test`;
    const statuses: number[] = [];

    for (let attempt = 1; attempt <= 11; attempt += 1) {
      const { status } = await post<ProblemBody>('/api/v1/auth/login', {
        email: stranger,
        password: 'wrong',
        tenant: slug,
      });
      statuses.push(status);
    }

    // A `429` appears, and every request that produced one was **unauthenticated** — which is the
    // property this test exists for. The exact position is deliberately not asserted: `auth.login`
    // is keyed on address *and* identity, and the eight sign-ins the tests above perform share this
    // suite's address budget. Pinning the index would make this test depend on how many logins its
    // neighbours happen to do. The precise boundary is proven in isolation by
    // `core/security/__tests__/rate-limit.integration.spec.ts`; what only this level can show is
    // that an anonymous caller is bounded at all.
    expect(statuses).toContain(429);
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
    // And the refusals before it were credential failures, not something else — so the limiter is
    // sitting in front of authentication rather than replacing it.
    expect(statuses.some((status) => status === 401 || status === 400)).toBe(true);
  }, 60_000);
});
