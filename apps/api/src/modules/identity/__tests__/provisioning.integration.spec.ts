import 'reflect-metadata';

import { PrismaClient } from '@prisma/client';
import { beforeAll, describe, expect, it } from 'vitest';

import { ALL_PERMISSIONS } from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import type { AppConfig } from '../../../core/config/configuration';
import type { Logger } from '../../../core/observability/logger';
import { PrismaService } from '../../../core/prisma/prisma.service';
import { PrismaUnitOfWork } from '../../../core/prisma/unit-of-work';
import { FakeClock } from '../../../testing/fake-ports';
import type { AuditWriter } from '../../../core/audit/audit-writer.port';
import { ProvisioningService } from '../application/provisioning.service';
import { PrismaProvisioningRepository } from '../infrastructure/prisma-provisioning.repository';
import { ScryptPasswordHasher } from '../infrastructure/scrypt-password-hasher';

const OWNER_URL = process.env['DATABASE_MIGRATION_URL'] ?? '';
const APP_URL = process.env['DATABASE_URL'] ?? '';

const slug = `boot-${uuidv7().replaceAll('-', '').slice(-12)}`;
const PASSWORD = 'correct horse battery staple';

const config = { env: 'test', database: { url: APP_URL, poolSize: 5 } } as unknown as AppConfig;
const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const prisma = new PrismaService(config, logger);
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
  new PrismaProvisioningRepository(prisma),
  new ScryptPasswordHasher(),
  new FakeClock(new Date('2026-01-01T00:00:00Z')),
  unitOfWork,
  audit,
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
  it('creates the organisation, an administrator role and one person who can sign in', async () => {
    const result = await service.provision(command());

    const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
    const seen = await owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SELECT set_config('app.tenant_id', $1, true)", result.tenantId);
      const role = await tx.role.findUnique({
        where: { id: result.roleId },
        include: { permissions: true },
      });
      const user = await tx.user.findUnique({
        where: { id: result.adminUserId },
        include: { roles: true },
      });
      return { role, user };
    });
    await owner.$disconnect();

    expect(seen.role?.key).toBe('TENANT_ADMIN');
    // A first administrator who cannot grant themselves what they need is a tenant that needs a
    // database console to finish setting up.
    expect(seen.role?.permissions).toHaveLength(ALL_PERMISSIONS.length);
    expect(seen.user?.status).toBe('ACTIVE');
    expect(seen.user?.passwordHash).toMatch(/^scrypt\$/);
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
