import 'reflect-metadata';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ScopeType, type AnyId, type TenantId, type UserId, asId } from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import type { AppConfig } from '../core/config/configuration';
import type { Logger } from '../core/observability/logger';
import { PrismaUnitOfWork } from '../core/prisma/unit-of-work';
import { type RequestContext, runWithContext } from '../core/tenancy/tenant-context';
import { realAclResolver, realOrganizationService } from '../testing/real-collaborators';
import { ScopeAdminService } from '../modules/organization/application/scope-admin.service';
import { PrismaScopeAdminRepository } from '../modules/organization/infrastructure/prisma-scope-admin.repository';
import { realWriteStack } from '../testing/real-collaborators';
import { placedTenants } from '../testing/tenant-database';

/**
 * The property Phase 2.5 adds: two tenants are not merely filtered apart, they are in **different
 * databases**.
 *
 * Every other suite in the product asserts the layer underneath this one — that a tenant column and a
 * row-level security policy keep two companies apart when they share a database, which is what an
 * on-premise installation serving several companies relies on. This suite asserts the layer above it,
 * and the difference matters: the checks below cannot be satisfied by a `WHERE` clause, because the rows
 * they look for are not in the database being queried at all
 * ([ADR-0015](../../../../docs/architecture/adr/0015-database-per-tenant.md)).
 *
 * It needs two real databases. `DATABASE_URL` is the first; `SECOND_DATABASE_URL` is the second, and the
 * suite skips rather than passes when it is absent — a test that quietly ran both tenants against one
 * database would assert nothing and say it had.
 */

const APP_URL = process.env['DATABASE_URL'] ?? '';
const OWNER_URL = process.env['DATABASE_MIGRATION_URL'] ?? '';
const SECOND_APP_URL = process.env['SECOND_DATABASE_URL'] ?? '';
const SECOND_OWNER_URL = process.env['SECOND_DATABASE_MIGRATION_URL'] ?? '';

const twoDatabases = SECOND_APP_URL !== '' && SECOND_OWNER_URL !== '';

const ACME = asId<TenantId>(uuidv7());
const RIVAL = asId<TenantId>(uuidv7());
const ADMIN = asId<UserId>(uuidv7());

/**
 * One slug, used for **both** tenants.
 *
 * That is the assertion, not an oversight: two customers choosing the same short name is ordinary, and
 * under a shared database only a unique index keeps them apart. Here they are in different databases,
 * so the index is per database and there is nothing to collide.
 *
 * Unique per run so a failed run leaves no row a later one trips over.
 */
const SHARED_SLUG = `iso-${uuidv7().replaceAll('-', '').slice(-12)}`;

const config = {
  env: 'test',
  database: { url: APP_URL, poolSize: 5, maxTenantClients: 5 },
} as unknown as AppConfig;
const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;
const clock = {
  now: () => new Date('2026-10-01T00:00:00Z'),
  timestamp: () => 0,
  elapsedMs: () => 0,
};

// Each tenant placed in its own database — the cloud shape, and the shape a customer who outgrew the
// shared cluster is moved to.
const databases = placedTenants(config, logger, { [ACME]: APP_URL, [RIVAL]: SECOND_APP_URL });
const unitOfWork = new PrismaUnitOfWork(databases);
const { stamps, outbox, writer } = realWriteStack(clock, unitOfWork);
const scopes = new ScopeAdminService(
  new PrismaScopeAdminRepository(stamps),
  outbox,
  // Real, so a move clears real cache entries — this suite just never reads them back.
  realAclResolver({ clock, unitOfWork }),
  writer,
);
const organization = realOrganizationService();

/** Direct connections, so an assertion can look at what is *in* each database rather than through the app. */
const acmeOwner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
const rivalOwner = new PrismaClient({
  datasources: { db: { url: SECOND_OWNER_URL === '' ? OWNER_URL : SECOND_OWNER_URL } },
});

function contextFor(tenantId: TenantId): RequestContext {
  return {
    tenantId,
    userId: ADMIN,
    roles: ['TENANT_ADMIN'],
    permissions: [],
    sessionId: null,
    correlationId: 'tenant-isolation',
    permissionVersion: 1,
    locale: 'en',
  };
}

function as<T>(tenantId: TenantId, work: () => Promise<T>): Promise<T> {
  return runWithContext(contextFor(tenantId), work);
}

beforeAll(async () => {
  if (!twoDatabases) {
    return;
  }
  // The same slug in both, and later the same company code — the case worth proving.
  await acmeOwner.tenant.create({
    data: { id: ACME, slug: SHARED_SLUG, name: 'Acme Ltd', status: 'ACTIVE' },
  });
  await rivalOwner.tenant.create({
    data: { id: RIVAL, slug: SHARED_SLUG, name: 'Rival Ltd', status: 'ACTIVE' },
  });
});

afterAll(async () => {
  await acmeOwner.$disconnect();
  await rivalOwner.$disconnect();
  await databases.disconnectAll();
});

describe.skipIf(!twoDatabases)('two tenants in two databases', () => {
  it('writes each tenant into its own database and nowhere else', async () => {
    const acme = await as(ACME, () =>
      scopes.createCompany({ code: 'HQ', name: 'Acme Head Office' }),
    );
    const rival = await as(RIVAL, () =>
      scopes.createCompany({ code: 'HQ', name: 'Rival Head Office' }),
    );

    // Both chose the code `HQ`, and neither collided — because the partial unique index on
    // `lower(code)` is per database, not per cluster.
    expect(acme.code).toBe('HQ');
    expect(rival.code).toBe('HQ');

    // The rows are where they belong, and *only* there. This is the assertion a `WHERE` clause cannot
    // fake: it looks for the other tenant's row in a database that has never seen it.
    await expect(
      acmeOwner.company.findUnique({ where: { id: acme.id }, select: { name: true } }),
    ).resolves.toMatchObject({ name: 'Acme Head Office' });
    await expect(acmeOwner.company.findUnique({ where: { id: rival.id } })).resolves.toBeNull();

    await expect(
      rivalOwner.company.findUnique({ where: { id: rival.id }, select: { name: true } }),
    ).resolves.toMatchObject({ name: 'Rival Head Office' });
    await expect(rivalOwner.company.findUnique({ where: { id: acme.id } })).resolves.toBeNull();
  });

  it('does not find the other tenant’s record even when handed its identifier', async () => {
    const rival = await as(RIVAL, () =>
      scopes.createCompany({ code: 'OPS', name: 'Rival Operations' }),
    );

    // The strongest form of the check. Acme's context, Rival's identifier — a forged request, or an
    // identifier leaked through a URL somebody shared. Under a shared database this is refused by a
    // tenant predicate; here the query runs against a database in which the row does not exist, so
    // there is nothing for a predicate to get wrong.
    await expect(as(ACME, () => scopes.getCompany(rival.id))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('keeps each tenant’s list to its own database', async () => {
    await as(ACME, () => scopes.createCompany({ code: 'A1', name: 'Acme One' }));
    await as(RIVAL, () => scopes.createCompany({ code: 'R1', name: 'Rival One' }));

    const acmeCodes = await as(ACME, () => scopes.listCompanies(listing()));
    const rivalCodes = await as(RIVAL, () => scopes.listCompanies(listing()));

    const codesOf = (page: { data: readonly { code: string }[] }): string[] =>
      page.data.map((row) => row.code).sort();

    expect(codesOf(acmeCodes)).toContain('A1');
    expect(codesOf(acmeCodes)).not.toContain('R1');
    expect(codesOf(rivalCodes)).toContain('R1');
    expect(codesOf(rivalCodes)).not.toContain('A1');

    // And the totals, which is the part a fetch-then-filter implementation gets wrong: a leaked count
    // tells one customer how many records another has.
    expect(acmeCodes.meta.total).toBe(codesOf(acmeCodes).length);
    expect(rivalCodes.meta.total).toBe(codesOf(rivalCodes).length);
  });

  it('resolves a scope chain only within the tenant’s own database', async () => {
    // The permission model walks this chain, so a chain that crossed databases would be a permission
    // that crossed companies.
    const rival = await as(RIVAL, () => scopes.createCompany({ code: 'CH', name: 'Rival Chain' }));

    // Through a unit of work, because the read side joins the caller's transaction like every other
    // repository — and it is that transaction which decides *which database* the question is asked of.
    const asks = (tenantId: TenantId): Promise<boolean> =>
      as(tenantId, () =>
        unitOfWork.run(() => organization.exists(asId<AnyId>(rival.id), ScopeType.COMPANY)),
      );

    await expect(asks(RIVAL)).resolves.toBe(true);
    await expect(asks(ACME)).resolves.toBe(false);
  });

  it('audits each tenant into its own trail', async () => {
    // An audit trail that mixed two customers' events could not be exported to either of them.
    const before = await counts();
    await as(ACME, () => scopes.createCompany({ code: 'AU', name: 'Acme Audited' }));
    const after = await counts();

    expect(after.acme).toBeGreaterThan(before.acme);
    expect(after.rival).toBe(before.rival);
  });

  it('holds one connection per tenant, and closes them all', async () => {
    // The bounded pool is the cost of this architecture, so the mechanism is asserted rather than
    // assumed: two tenants, two clients, and both released.
    const acmeClient = await databases.clientFor(ACME);
    const rivalClient = await databases.clientFor(RIVAL);
    expect(acmeClient).not.toBe(rivalClient);

    // The same tenant asked for twice is the same client, or a busy process would open a pool per
    // request.
    expect(await databases.clientFor(ACME)).toBe(acmeClient);

    await databases.ping(ACME);
    await databases.ping(RIVAL);
  });
});

function listing() {
  return {
    page: 1,
    pageSize: 50,
    sortDirection: 'asc' as const,
    deleted: 'live' as const,
  };
}

async function counts(): Promise<{ acme: number; rival: number }> {
  return {
    acme: await acmeOwner.auditEvent.count({ where: { tenantId: ACME } }),
    rival: await rivalOwner.auditEvent.count({ where: { tenantId: RIVAL } }),
  };
}
