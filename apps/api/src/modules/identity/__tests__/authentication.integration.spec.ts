import 'reflect-metadata';

import { PrismaClient } from '@prisma/client';
import { beforeAll, describe, expect, it } from 'vitest';

import { type TenantId, Permission, asId } from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import type { AppConfig } from '../../../core/config/configuration';
import type { Logger } from '../../../core/observability/logger';
import { PrismaService } from '../../../core/prisma/prisma.service';
import { PrismaUnitOfWork } from '../../../core/prisma/unit-of-work';
import { DefaultAuthenticationService } from '../application/authentication.service';
import { JwtTokenService } from '../infrastructure/jwt.token-service';
import { PrismaCredentialRepository } from '../infrastructure/prisma-credential.repository';
import { PrismaSessionRepository } from '../infrastructure/prisma-session.repository';
import { PrismaTenantDirectory } from '../infrastructure/prisma-tenant.directory';
import { RandomRefreshTokenFactory } from '../infrastructure/random-refresh-token.factory';
import { ScryptPasswordHasher } from '../infrastructure/scrypt-password-hasher';
import type { AuditWriter } from '../../../core/audit/audit-writer.port';
import { FakeClock } from '../../../testing/fake-ports';

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

const prisma = new PrismaService(config, logger);
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
const service = new DefaultAuthenticationService(
  new PrismaCredentialRepository(),
  new PrismaSessionRepository(clock),
  new PrismaTenantDirectory(prisma),
  hasher,
  new JwtTokenService(config, clock),
  new RandomRefreshTokenFactory(config),
  clock,
  unitOfWork,
  auditWriter,
  logger,
);

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
