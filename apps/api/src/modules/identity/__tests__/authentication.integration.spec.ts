import 'reflect-metadata';

import { PrismaClient } from '@prisma/client';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ActorChannel, type TenantId, type UserId, Permission, asId } from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import type { AppConfig } from '../../../core/config/configuration';
import type { Logger } from '../../../core/observability/logger';

import { PrismaUnitOfWork } from '../../../core/prisma/unit-of-work';
import { DefaultAuthenticationService } from '../application/authentication.service';
import { JwtTokenService } from '../infrastructure/jwt.token-service';
import { PrismaCredentialRepository } from '../infrastructure/prisma-credential.repository';
import { PrismaSessionRepository } from '../infrastructure/prisma-session.repository';
import { RegistryTenantDirectory } from '../infrastructure/registry-tenant.directory';
import { RandomRefreshTokenFactory } from '../infrastructure/random-refresh-token.factory';
import { ScryptPasswordHasher } from '../infrastructure/scrypt-password-hasher';
import type { MfaService } from '../application/mfa.ports';
import type { AuditWriter } from '../../../core/audit/audit-writer.port';
import { FakeCache, FakeClock } from '../../../testing/fake-ports';
import { everyTenantRegistry, sharedDatabase } from '../../../testing/tenant-database';
import { AuthenticationGuard } from '../../../core/auth/authentication.guard';
import type { PermissionVersionReader } from '../../../core/auth/permission-version';
import { PUBLIC_ROUTE } from '../../../core/auth/public.decorator';
import { type RequestContext, runWithContext } from '../../../core/tenancy/tenant-context';
import {
  CachedPermissionVersionReader,
  permissionVersionKey,
} from '../infrastructure/cached-permission-version.reader';

// Both roles are needed and they are not interchangeable: seeding is DDL-adjacent and runs as
// the owner, while the code under test must run as the application role so that row-level
// security is actually in force. Supplied by the environment — see `.env.example`.
const OWNER_URL = process.env['DATABASE_MIGRATION_URL'] ?? '';
const APP_URL = process.env['DATABASE_URL'] ?? '';

const ACME = asId<TenantId>(uuidv7());
const GLOBEX = asId<TenantId>(uuidv7());

// Unique per run, so the suite can be run repeatedly against the same database without a
// manual truncate between attempts. A test that needs the world cleaned up first is a test
// people stop running.
//
// From the *tail* of the identifier, not the head: a UUID v7 begins with the millisecond
// timestamp, so its leading hex digits are shared by every identifier minted in the same
// ~65-second window — two runs a minute apart would collide on the slug.
const suffix = (id: string): string => id.replaceAll('-', '').slice(-12);
const ACME_SLUG = `acme-${suffix(ACME)}`;
const GLOBEX_SLUG = `globex-${suffix(GLOBEX)}`;

const config = {
  env: 'test',
  auth: {
    issuer: 'https://docs.munaxa.test',
    audience: 'munaxa-docs',
    accessSecret: 'a'.repeat(32),
    accessTtlSeconds: 900,
    refreshTtlSeconds: 2_592_000,
  },
  database: { url: APP_URL, poolSize: 5 },
} as unknown as AppConfig;

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const clock = new FakeClock(new Date());
const hasher = new ScryptPasswordHasher();

const prisma = sharedDatabase(config, logger, APP_URL);
const unitOfWork = new PrismaUnitOfWork(prisma);

/**
 * Audit is recorded, not exercised, here.
 *
 * The real writer belongs to the Audit module and reaching into it would cross a boundary the
 * architecture forbids — and lint enforces. What the chain does under concurrency, rollback
 * and tampering is its own module's integration suite; this one is about authentication.
 */
const auditWriter: AuditWriter = {
  write: () => Promise.resolve(),
  writeStandalone: () => Promise.resolve(),
};
/**
 * The second factor, stubbed to "nobody is enrolled".
 *
 * The real one is `DefaultMfaService` and it has its own suite. What this file is about is the
 * password path, and an enrolment-free stub is the honest shape for it: every assertion below is
 * about an account with one factor, which is what almost every account has.
 */
const noMfa = {
  statusFor: () => Promise.resolve({ enrolled: false, pending: false, recoveryCodesRemaining: 0 }),
  begin: () => Promise.reject(new Error('not used')),
  confirm: () => Promise.reject(new Error('not used')),
  challenge: () => Promise.resolve(true),
  isRequired: () => Promise.resolve(false),
  remove: () => Promise.resolve(),
} as unknown as MfaService;

const service = new DefaultAuthenticationService(
  new PrismaCredentialRepository(),
  new PrismaSessionRepository(clock),
  new RegistryTenantDirectory(everyTenantRegistry(APP_URL, { [ACME_SLUG]: ACME })),
  hasher,
  new JwtTokenService(config, clock),
  new RandomRefreshTokenFactory(config),
  clock,
  unitOfWork,
  auditWriter,
  logger,
  noMfa,
);

/** The person each tenant was seeded with, so the guard cases below can name a real row. */
const seededUsers = new Map<string, string>();

const context = {
  tenantSlug: ACME_SLUG,
  ipAddress: '198.51.100.7',
  userAgent: 'integration',
  correlationId: 'integration-1',
  locale: 'en',
};

beforeAll(async () => {
  if (!OWNER_URL || !APP_URL) {
    throw new Error(
      'DATABASE_URL and DATABASE_MIGRATION_URL must both be set. This suite runs against a ' +
        'real database on purpose: it is where transaction behaviour and row-level security ' +
        'are observable, and neither can be faked.',
    );
  }

  const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  const passwordHash = await hasher.hash('correct horse battery staple');

  // The slug is unique per run; the address is not, and does not need to be — uniqueness on
  // users is per tenant, and each run creates new tenants.
  for (const [tenantId, slug, email] of [
    [ACME, ACME_SLUG, 'ada@acme.test'],
    [GLOBEX, GLOBEX_SLUG, 'ada@globex.test'],
  ] as const) {
    // `tenant` has no policy, so it is inserted outside any tenant context.
    await owner.tenant.create({
      data: { id: tenantId, slug, name: slug, status: 'ACTIVE' },
    });

    // Everything else does. FORCE ROW LEVEL SECURITY applies to the table owner as well, so
    // even provisioning must say which tenant it is acting for — which is the point: there is
    // no role in the system that can write a tenant-scoped row without naming the tenant.
    const roleId = uuidv7();
    const userId = uuidv7();
    seededUsers.set(tenantId, userId);
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
          id: userId,
          tenantId,
          email,
          emailNormalized: email,
          displayName: 'Ada',
          status: 'ACTIVE',
          passwordHash,
          passwordAlgorithm: 'SCRYPT',
          roles: { create: [{ tenantId, roleId }] },
        },
      });
    });
  }
  await owner.$disconnect();
});

/**
 * The real stack against a real database: real row-level security, real scrypt, real JWT.
 * Nothing here is a double except the clock.
 */
describe('authentication against PostgreSQL', () => {
  it('signs in and mints a token carrying the tenant and permissions', async () => {
    const result = await service.signIn({
      ...context,
      email: 'ada@acme.test',
      password: 'correct horse battery staple',
    });

    expect(result.accessToken.split('.')).toHaveLength(3);
    expect(result.user.permissions).toEqual([Permission.USER_MANAGE]);

    const claims = await new JwtTokenService(config, clock).verify(result.accessToken);
    expect(claims.tenantId).toBe(ACME);
  });

  it('refuses the right password against the wrong tenant', async () => {
    // Same address shape, same password, different tenant: row-level security means the
    // credential simply is not there.
    await expect(
      service.signIn({
        ...context,
        tenantSlug: GLOBEX_SLUG,
        email: 'ada@acme.test',
        password: 'correct horse battery staple',
      }),
    ).rejects.toThrowError();
  });

  it('refuses a wrong password', async () => {
    await expect(
      service.signIn({ ...context, email: 'ada@acme.test', password: 'wrong password here' }),
    ).rejects.toThrowError();
  });

  it('rotates a refresh token, and kills the family when one is replayed', async () => {
    const first = await service.signIn({
      ...context,
      email: 'ada@acme.test',
      password: 'correct horse battery staple',
    });

    const second = await service.refresh(first.refreshToken, context);
    expect(second.refreshToken).not.toBe(first.refreshToken);

    // Replay the token that was already exchanged.
    await expect(service.refresh(first.refreshToken, context)).rejects.toThrowError();

    // The family is now revoked, so the successor is dead too.
    await expect(service.refresh(second.refreshToken, context)).rejects.toThrowError();
  });

  it('ends a session on sign-out', async () => {
    const session = await service.signIn({
      ...context,
      email: 'ada@acme.test',
      password: 'correct horse battery staple',
    });

    await service.signOut(session.refreshToken, context);

    await expect(service.refresh(session.refreshToken, context)).rejects.toThrowError();
  });
});

// --- The permission version, made authoritative -------------------------------------------------

/**
 * Slice 31, and the assertion the column was added for in Phase 0.5.
 *
 * `permVersion` was minted into every access token and compared nowhere, so a role change took
 * effect only when the token expired — fifteen minutes by default, an hour at the configured
 * maximum. Three statements in the product said otherwise, the plainest being
 * `RoleAdminService.update`'s "there is no window in which the role says one thing and the tokens
 * still in flight say another". These are that sentence, asserted.
 *
 * Against the real stack: a real token minted by `signIn`, the real reader over a real cache and
 * the tenant's own database, and the real guard. The only double is the clock.
 */
describe('the permission version, at the authentication boundary', () => {
  const cache = new FakeCache(clock);
  const reader = new CachedPermissionVersionReader(cache, unitOfWork);

  /** Counts what reaches the reader, so "no lookup happened" is assertable rather than assumed. */
  let asked = 0;
  const counting: PermissionVersionReader = {
    currentFor: (userId) => {
      asked += 1;
      return reader.currentFor(userId);
    },
  };
  const guard = new AuthenticationGuard(new Reflector(), counting);

  /** A handler with no metadata is an ordinary authenticated route; `PUBLIC_ROUTE` makes it public. */
  function routeTo(handler: () => void): ExecutionContext {
    return {
      getHandler: () => handler,
      getClass: () => class Controller {},
    } as unknown as ExecutionContext;
  }

  const ordinary = (): void => {};
  const publicRoute = (): void => {};
  Reflect.defineMetadata(PUBLIC_ROUTE, 'health checks answer before anybody signs in', publicRoute);

  function asCaller(
    overrides: Partial<RequestContext>,
    handler: () => void = ordinary,
  ): Promise<boolean> {
    const context: RequestContext = {
      tenantId: ACME,
      userId: asId<UserId>(seededUsers.get(ACME) ?? ''),
      roles: [],
      permissions: [],
      sessionId: 'session',
      correlationId: 'perm-version',
      permissionVersion: 1,
      locale: 'en',
      ...overrides,
    };
    return runWithContext(context, () => guard.canActivate(routeTo(handler)));
  }

  /** The version the seeded row actually carries, read straight from the database. */
  async function versionOf(tenantId: string, userId: string): Promise<number> {
    const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
    try {
      const row = await owner.user.findFirstOrThrow({
        where: { id: userId, tenantId },
        select: { permissionVersion: true },
      });
      return row.permissionVersion;
    } finally {
      await owner.$disconnect();
    }
  }

  async function bumpIn(tenantId: string, userId: string): Promise<void> {
    const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
    try {
      await owner.user.updateMany({
        where: { id: userId, tenantId },
        data: { permissionVersion: { increment: 1 } },
      });
    } finally {
      await owner.$disconnect();
    }
  }

  beforeEach(async () => {
    asked = 0;
    await cache.deleteByPrefix('perm-version:');
  });

  /**
   * The positive control, and it comes first deliberately: everything below asserts a refusal, and
   * a change that refused every token would pass all of them.
   */
  it('accepts a token whose version matches the tenant record', async () => {
    const userId = seededUsers.get(ACME) ?? '';
    const current = await versionOf(ACME, userId);

    await expect(asCaller({ permissionVersion: current })).resolves.toBe(true);
    expect(asked).toBe(1);
  });

  /** The core regression: the sentence `RoleAdminService.update` has been making since Phase 0.5. */
  it('refuses a token minted before the version changed', async () => {
    const userId = seededUsers.get(ACME) ?? '';
    const minted = await versionOf(ACME, userId);
    // The token is already in somebody's browser. Only the world changes.
    await bumpIn(ACME, userId);

    await expect(asCaller({ permissionVersion: minted })).rejects.toThrowError();
  });

  /** And the token minted after it works — the refusal is about staleness, not about the user. */
  it('accepts the version minted after the change', async () => {
    const userId = seededUsers.get(ACME) ?? '';
    await bumpIn(ACME, userId);
    const current = await versionOf(ACME, userId);

    await expect(asCaller({ permissionVersion: current })).resolves.toBe(true);
  });

  /**
   * A token for somebody who is not there any more.
   *
   * `null` from the reader is "there is nobody here", and it refuses. This does not *replace* the
   * account-state checks — `revokeSessions` already ends a deleted user's sessions — it makes sure
   * a matching number cannot be the thing that lets one through.
   */
  it('refuses when the tenant has no row for the caller', async () => {
    await expect(
      asCaller({ userId: asId<UserId>(uuidv7()), permissionVersion: 1 }),
    ).rejects.toThrowError();
  });

  /**
   * Mandatory, and structural rather than incidental: `/auth/login` and the health checks carry no
   * credential, and giving them a Redis round trip to discover that would be a cost paid on every
   * unauthenticated request in the product.
   */
  it('asks nothing at all on a public route', async () => {
    await expect(asCaller({ permissionVersion: 999_999 }, publicRoute)).resolves.toBe(true);
    expect(asked).toBe(0);
  });

  /**
   * ADR-0018's machine caller is already current — its permissions are read from the database on
   * every request — and its provisional context reports version 0, so comparing it would refuse
   * every key in the product.
   */
  it('asks nothing for an API-key caller', async () => {
    await expect(asCaller({ channel: ActorChannel.API, permissionVersion: 0 })).resolves.toBe(true);
    expect(asked).toBe(0);
  });

  /**
   * The cache key, proven tenant-safe by behaviour rather than by reading it.
   *
   * Redis is the one store in the product two tenants share — ADR-0015 separates their *databases*
   * — so a key of `perm-version:<userId>` would be correct only for as long as identifiers never
   * collide. Here the same identifier is asked for under two tenants: the first warms an entry,
   * and the second must not read it.
   */
  it('does not answer one tenant from another tenant’s entry', async () => {
    const acmeUser = seededUsers.get(ACME) ?? '';
    const warmed = await runWithContext(
      { tenantId: ACME, userId: asId<UserId>(acmeUser) } as RequestContext,
      () => reader.currentFor(asId<UserId>(acmeUser)),
    );
    expect(warmed).not.toBeNull();

    // Same person identifier, different tenant. GLOBEX has no such row, so the only way to answer
    // anything but null is to have read ACME's entry.
    const acrossTheWall = await runWithContext(
      { tenantId: GLOBEX, userId: asId<UserId>(acmeUser) } as RequestContext,
      () => reader.currentFor(asId<UserId>(acmeUser)),
    );
    expect(acrossTheWall).toBeNull();
    expect(permissionVersionKey(ACME, acmeUser)).not.toBe(permissionVersionKey(GLOBEX, acmeUser));
  });

  /**
   * Refresh already re-reads the credential, so the rotated token carries the current number. That
   * is what makes the refusal above recoverable rather than a dead end: the browser refreshes and
   * carries on.
   */
  it('mints the current version on refresh, after a change', async () => {
    const signedIn = await service.signIn({
      ...context,
      email: 'ada@acme.test',
      password: 'correct horse battery staple',
    });
    const userId = seededUsers.get(ACME) ?? '';
    await bumpIn(ACME, userId);

    const rotated = await service.refresh(signedIn.refreshToken, context);
    const claims = await new JwtTokenService(config, clock).verify(rotated.accessToken);

    expect(claims.permVersion).toBe(await versionOf(ACME, userId));
    await expect(asCaller({ permissionVersion: claims.permVersion })).resolves.toBe(true);
  });
});
