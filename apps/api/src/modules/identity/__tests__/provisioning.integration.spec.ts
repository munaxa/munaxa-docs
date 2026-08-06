import 'reflect-metadata';

import { PrismaClient } from '@prisma/client';
import { beforeAll, describe, expect, it } from 'vitest';

import { ALL_SYSTEM_ROLES, Permission } from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import type { AppConfig } from '../../../core/config/configuration';
import type { Logger } from '../../../core/observability/logger';

import { PrismaUnitOfWork } from '../../../core/prisma/unit-of-work';
import { FakeClock } from '../../../testing/fake-ports';
import type { AuditWriter } from '../../../core/audit/audit-writer.port';
import { ProvisioningService } from '../application/provisioning.service';
import { PrismaProvisioningRepository } from '../infrastructure/prisma-provisioning.repository';
import { PlatformPasswordHasher } from '../infrastructure/platform-password.hasher';
import { everyTenantRegistry, sharedDatabase } from '../../../testing/tenant-database';

const OWNER_URL = process.env['DATABASE_MIGRATION_URL'] ?? '';
const APP_URL = process.env['DATABASE_URL'] ?? '';

const slug = `boot-${uuidv7().replaceAll('-', '').slice(-12)}`;
/**
 * The tenant's identifier, declared here rather than returned by provisioning.
 *
 * That inversion is the change ADR-0015 makes to this bootstrap: the identifier is what routes every
 * later request to this tenant's database, so it is configuration an operator holds *before*
 * provisioning runs — and a re-run against a database that already carries it has to use the same
 * value, or it would seed a second organisation beside the first.
 */
const TENANT_ID = uuidv7();
const PASSWORD = 'correct horse battery staple';

const config = { env: 'test', database: { url: APP_URL, poolSize: 5 } } as unknown as AppConfig;
const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const prisma = sharedDatabase(config, logger, APP_URL);
const unitOfWork = new PrismaUnitOfWork(prisma);

/**
 * The chain is the Audit module's to test, and reaching into its infrastructure for a writer
 * would cross a boundary the architecture forbids. What matters here is only *that* an event is
 * written, and with what action.
 */
const written: string[] = [];
const audit: AuditWriter = {
  write: (_actor, entry) => {
    written.push(entry.action);
    return Promise.resolve();
  },
  writeStandalone: () => Promise.resolve(),
};

const service = new ProvisioningService(
  new PrismaProvisioningRepository(),
  new PlatformPasswordHasher(),
  new FakeClock(new Date('2026-01-01T00:00:00Z')),
  unitOfWork,
  audit,
  // The registry, because the tenant identifier is now configuration rather than something
  // provisioning invents: it is what routes every later request to this database, so an operator holds
  // it before the bootstrap runs.
  everyTenantRegistry(APP_URL, { [slug]: TENANT_ID }),
);

function command(overrides: Record<string, string> = {}) {
  return {
    slug,
    name: 'Bootstrap Ltd',
    adminEmail: 'ada@bootstrap.test',
    adminPassword: PASSWORD,
    adminDisplayName: 'Ada Lovelace',
    ...overrides,
  };
}

beforeAll(() => {
  if (!OWNER_URL || !APP_URL) {
    throw new Error('DATABASE_URL and DATABASE_MIGRATION_URL must both be set.');
  }
});

describe('provisioning a tenant against PostgreSQL', () => {
  it('creates the organisation, the eight seeded roles and one person who can sign in', async () => {
    const result = await service.provision(command());

    const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
    const seen = await owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SELECT set_config('app.tenant_id', $1, true)", result.tenantId);
      const role = await tx.role.findUnique({
        where: { id: result.roleId },
        include: { permissions: true },
      });
      const roles = await tx.role.findMany({
        where: { tenantId: result.tenantId },
        select: { key: true, isSystem: true },
      });
      const user = await tx.user.findUnique({
        where: { id: result.adminUserId },
        include: { roles: true },
      });
      return { role, roles, user };
    });
    await owner.$disconnect();

    expect(seen.role?.key).toBe('TENANT_ADMIN');

    // All eight, so that making a colleague an author is a role assignment rather than a
    // matrix-design exercise — and all eight marked `isSystem`, so their keys cannot be renamed and
    // the rows cannot be deleted.
    expect(new Set(seen.roles.map((role) => role.key))).toEqual(new Set(ALL_SYSTEM_ROLES));
    expect(seen.roles.every((role) => role.isSystem)).toBe(true);

    // The administrator holds everything the product defines *except* approval. Authority to approve
    // comes from being assigned a task, never from seniority — `08-permission-model.md` §6 calls this
    // out as one of its two deliberate rows, and a first administrator who could approve their own
    // documents would make every control in the product optional for the person who configured it.
    const granted = new Set(seen.role?.permissions.map((row) => row.permission));
    expect(granted.has(Permission.DOCUMENT_APPROVE)).toBe(false);
    expect(granted.has(Permission.DOCUMENT_REJECT)).toBe(false);
    // And it does hold the ones that make a tenant administrable, which is the other half of why a
    // count alone would be a weak assertion.
    for (const permission of [
      Permission.USER_MANAGE,
      Permission.ROLE_MANAGE,
      Permission.ORG_MANAGE,
      Permission.SETTINGS_MANAGE,
    ]) {
      expect(granted.has(permission)).toBe(true);
    }
    expect(seen.user?.status).toBe('ACTIVE');
    // Platform PHC format, at this product's cost rather than the platform's lighter default.
    // Pinning the parameters is the point: N=2^17 is what Munaxa Docs committed to, and adopting
    // the platform's N=2^14 would weaken every new password without failing anything else.
    expect(seen.user?.passwordHash).toMatch(/^\$scrypt\$v=1\$n=131072,r=8,p=1\$/);
    expect(seen.user?.roles).toHaveLength(1);
    expect(written).toContain('TENANT_PROVISIONED');
  });

  it('refuses to provision the same organisation twice', async () => {
    // Matched on the message: an unmatched `toThrowError()` is satisfied by a connection error
    // too, which is how this passed once while the database was down.
    await expect(service.provision(command())).rejects.toThrowError(/already exists/);
  });

  it('applies the password policy, unlike sign-in', async () => {
    // This is a password being *set*, which is exactly where the policy belongs.
    await expect(
      service.provision(command({ slug: `${slug}-b`, adminPassword: 'short' })),
    ).rejects.toThrowError(/not acceptable/);
  });

  it('refuses a password containing the account it protects', async () => {
    await expect(
      service.provision(command({ slug: `${slug}-c`, adminPassword: 'ada@bootstrap.test-2026' })),
    ).rejects.toThrowError(/CONTAINS_IDENTIFIER/);
  });

  it('rejects a malformed organisation name before touching the database', async () => {
    await expect(service.provision(command({ slug: 'Not A Slug' }))).rejects.toThrowError(
      /lower-case/,
    );
  });
});
