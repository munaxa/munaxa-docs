import 'reflect-metadata';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type AnyId, type TenantId, ScopeType, asId } from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import type { AppConfig } from '../../../core/config/configuration';
import type { Logger } from '../../../core/observability/logger';
import { PrismaService } from '../../../core/prisma/prisma.service';
import { PrismaUnitOfWork } from '../../../core/prisma/unit-of-work';
import { type RequestContext, runWithContext } from '../../../core/tenancy/tenant-context';
import { DefaultOrganizationService } from '../application/organization.service';
import { pathFor } from '../domain/scope-tree';
import { PrismaScopeRepository } from '../infrastructure/prisma-scope.repository';

/**
 * What the scope tree does is only half in TypeScript. The other half is row-level security,
 * the partial unique indexes, and whether a prefix query on `path` really returns a subtree and
 * nothing else — none of which a repository double can be wrong about, because a double is
 * written from the same belief as the code it stands in for.
 *
 * These run against a real PostgreSQL (`pnpm test:integration`) and are excluded from CI, which
 * has no database.
 */

const OWNER_URL = process.env['DATABASE_MIGRATION_URL'] ?? '';
const APP_URL = process.env['DATABASE_URL'] ?? '';

const ACME = asId<TenantId>(uuidv7());
const OTHER = asId<TenantId>(uuidv7());

const config = {
  env: 'test',
  database: { url: APP_URL, poolSize: 10 },
} as unknown as AppConfig;

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const prisma = new PrismaService(config, logger);
const unitOfWork = new PrismaUnitOfWork(prisma);
const service = new DefaultOrganizationService(new PrismaScopeRepository());
const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });

function contextFor(tenantId: TenantId): RequestContext {
  return {
    tenantId,
    userId: null,
    roles: [],
    permissions: [],
    sessionId: null,
    correlationId: 'organization-integration',
    permissionVersion: 0,
    locale: 'en',
  };
}

/** Runs through the application's role, so row-level security is in force as it is in production. */
function asTenant<T>(tenantId: TenantId, work: () => Promise<T>): Promise<T> {
  return runWithContext(contextFor(tenantId), () => unitOfWork.run(work));
}

type OwnerTx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

/**
 * Arranges a fixture through the owning role.
 *
 * The context still has to be set: `FORCE ROW LEVEL SECURITY` applies to the table owner too,
 * so a context-less session cannot insert a tenant-scoped row at all. That is the point of
 * forcing it — there is no role in this system for which the policy is advisory.
 *
 * One transaction per call, because a statement that is *expected* to fail aborts the one it
 * runs in; anything that must succeed afterwards needs a fresh one.
 */
function asOwner<T>(tenantId: TenantId | null, work: (tx: OwnerTx) => Promise<T>): Promise<T> {
  return owner.$transaction(async (tx) => {
    if (tenantId !== null) {
      await tx.$executeRawUnsafe("SELECT set_config('app.tenant_id', $1, true)", tenantId);
    }
    return work(tx);
  });
}

/**
 * The shape both tenants get. Identical on purpose: the isolation tests are only meaningful
 * when the other tenant holds something that would be a plausible answer if it leaked.
 *
 *   company ── entity ── Quality ── Documentation ── Records
 *                     └─ Finance
 */
interface Fixture {
  companyId: string;
  entityId: string;
  branchId: string;
  quality: string;
  documentation: string;
  records: string;
  finance: string;
}

const fixtures = new Map<TenantId, Fixture>();

async function seed(tenantId: TenantId, slug: string): Promise<Fixture> {
  // `tenant` carries no `tenant_id` and so has no policy: it is the row the policies key on.
  await owner.tenant.create({ data: { id: tenantId, slug, name: slug, status: 'ACTIVE' } });

  const ids = {
    companyId: uuidv7(),
    entityId: uuidv7(),
    branchId: uuidv7(),
    quality: uuidv7(),
    documentation: uuidv7(),
    records: uuidv7(),
    finance: uuidv7(),
  };

  await asOwner(tenantId, async (tx) => {
    await tx.company.create({
      data: { id: ids.companyId, tenantId, code: 'HQ', name: 'Head Office' },
    });
    await tx.entity.create({
      data: { id: ids.entityId, tenantId, companyId: ids.companyId, code: 'OPS', name: 'Operations' },
    });
    await tx.branch.create({
      data: { id: ids.branchId, tenantId, entityId: ids.entityId, code: 'MAIN', name: 'Main Site' },
    });

    const department = (id: string, parentId: string | null, parentPath: string | null, code: string) =>
      tx.department.create({
        data: {
          id,
          tenantId,
          entityId: ids.entityId,
          parentId,
          code,
          name: code,
          path: pathFor(parentPath, id),
        },
      });

    await department(ids.quality, null, null, 'QA');
    await department(ids.documentation, ids.quality, ids.quality, 'DOC');
    await department(ids.records, ids.documentation, `${ids.quality}.${ids.documentation}`, 'REC');
    await department(ids.finance, null, null, 'FIN');
  });

  return ids;
}

function fixture(tenantId: TenantId): Fixture {
  const found = fixtures.get(tenantId);
  if (!found) {
    throw new Error('Fixture was not seeded.');
  }
  return found;
}

beforeAll(async () => {
  if (!OWNER_URL || !APP_URL) {
    throw new Error('DATABASE_URL and DATABASE_MIGRATION_URL must both be set.');
  }
  fixtures.set(ACME, await seed(ACME, `acme-org-${Date.now()}`));
  fixtures.set(OTHER, await seed(OTHER, `other-org-${Date.now()}`));
});

afterAll(async () => {
  await owner.$disconnect();
});

describe('resolving a scope chain', () => {
  it('walks tenant → company → entity → department, ancestors first', async () => {
    const { companyId, entityId, quality, documentation, records } = fixture(ACME);

    const chain = await asTenant(ACME, () =>
      service.scopeChainFor(asId<AnyId>(records), ScopeType.DEPARTMENT),
    );

    // The order is the meaning: the resolver applies grants outermost-first, so a tenant-wide
    // deny has to be seen before the department-level allow that overrides it.
    expect(chain.map((node) => node.type)).toEqual([
      ScopeType.TENANT,
      ScopeType.COMPANY,
      ScopeType.ENTITY,
      ScopeType.DEPARTMENT,
      ScopeType.DEPARTMENT,
      ScopeType.DEPARTMENT,
    ]);
    expect(chain.map((node) => node.id)).toEqual([
      ACME,
      companyId,
      entityId,
      quality,
      documentation,
      records,
    ]);
  });

  it('stops at the company for an entity, and at the tenant for a company', async () => {
    const { companyId, entityId } = fixture(ACME);

    const forEntity = await asTenant(ACME, () =>
      service.scopeChainFor(asId<AnyId>(entityId), ScopeType.ENTITY),
    );
    const forCompany = await asTenant(ACME, () =>
      service.scopeChainFor(asId<AnyId>(companyId), ScopeType.COMPANY),
    );

    expect(forEntity.map((node) => node.id)).toEqual([ACME, companyId, entityId]);
    expect(forCompany.map((node) => node.id)).toEqual([ACME, companyId]);
  });

  it('returns nothing for a node that does not exist', async () => {
    // Not a chain of one. A caller that received `[tenant]` for an unknown department would
    // resolve it against the tenant-wide grant and let a typo become access.
    const chain = await asTenant(ACME, () =>
      service.scopeChainFor(asId<AnyId>(uuidv7()), ScopeType.DEPARTMENT),
    );

    expect(chain).toEqual([]);
  });

  it('does not resolve another tenant’s department', async () => {
    // The identifier is real and the row exists — it just belongs to somebody else. Row-level
    // security is what makes this an empty chain rather than a cross-tenant answer.
    const chain = await asTenant(ACME, () =>
      service.scopeChainFor(asId<AnyId>(fixture(OTHER).records), ScopeType.DEPARTMENT),
    );

    expect(chain).toEqual([]);
  });

  it('excludes a soft-deleted department', async () => {
    const { entityId } = fixture(ACME);
    const deleted = uuidv7();
    await asOwner(ACME, (tx) =>
      tx.department.create({
        data: {
          id: deleted,
          tenantId: ACME,
          entityId,
          code: 'GONE',
          name: 'Gone',
          path: deleted,
          deletedAt: new Date(),
        },
      }),
    );

    // A department that was removed has to stop conferring access at once. Leaving it resolvable
    // would keep every ACL granted on it alive after the thing it was granted on is gone.
    expect(
      await asTenant(ACME, () => service.scopeChainFor(asId<AnyId>(deleted), ScopeType.DEPARTMENT)),
    ).toEqual([]);
  });
});

describe('subtree membership', () => {
  it('reaches everything under a department, including the node itself', async () => {
    const { quality, documentation, records } = fixture(ACME);

    const reached = await asTenant(ACME, () => service.departmentsReachedBy([asId<AnyId>(quality)]));

    // Membership in "Quality" is membership in what sits under it — otherwise an ACL granted on
    // a parent department would not reach the people the org chart says are in it.
    expect(new Set(reached.map((node) => node.id))).toEqual(
      new Set([quality, documentation, records]),
    );
  });

  it('does not reach a sibling', async () => {
    const { quality, finance } = fixture(ACME);

    const reached = await asTenant(ACME, () => service.departmentsReachedBy([asId<AnyId>(quality)]));

    expect(reached.map((node) => node.id)).not.toContain(finance);
  });

  it('does not mistake a shared prefix for a descendant', async () => {
    // The separator is the whole defence. A path stored without it would make any department
    // whose identifier merely begins with another's a member of its subtree — this asserts the
    // prefix query really does stop at the boundary, in SQL and not just in the unit test.
    const { entityId, quality } = fixture(ACME);
    const impostor = uuidv7();
    await asOwner(ACME, (tx) =>
      tx.department.create({
        data: {
          id: impostor,
          tenantId: ACME,
          entityId,
          code: 'IMP',
          name: 'Impostor',
          // Deliberately malformed: the same characters as a child of Quality, without the dot.
          path: `${quality}${impostor}`,
        },
      }),
    );

    const reached = await asTenant(ACME, () => service.departmentsReachedBy([asId<AnyId>(quality)]));

    expect(reached.map((node) => node.id)).not.toContain(impostor);
  });

  it('takes several roots in one query', async () => {
    const { quality, finance, documentation, records } = fixture(ACME);

    const reached = await asTenant(ACME, () =>
      service.departmentsReachedBy([asId<AnyId>(quality), asId<AnyId>(finance)]),
    );

    expect(new Set(reached.map((node) => node.id))).toEqual(
      new Set([quality, documentation, records, finance]),
    );
  });

  it('reaches nothing for another tenant’s department', async () => {
    const reached = await asTenant(ACME, () =>
      service.departmentsReachedBy([asId<AnyId>(fixture(OTHER).quality)]),
    );

    expect(reached).toEqual([]);
  });
});

describe('the constraints the database holds', () => {
  it('refuses a duplicate code in the same entity, regardless of case', async () => {
    const { entityId } = fixture(ACME);
    const id = uuidv7();

    // `lower(code)` in the index, because people type these and "QA" and "qa" are the same
    // department to everyone but the database.
    // Asserted on the outcome rather than the message: Prisma cannot name an index it did not
    // create, and reports "(not available)" for one declared in raw SQL. What matters is that
    // the row is refused and the entity still holds exactly one QA.
    await expect(
      asOwner(ACME, (tx) =>
        tx.department.create({
          data: { id, tenantId: ACME, entityId, code: 'qa', name: 'Duplicate', path: id },
        }),
      ),
    ).rejects.toThrowError(/Unique constraint failed/);

    const remaining = await asOwner(ACME, (tx) =>
      tx.department.findMany({ where: { entityId, deletedAt: null }, select: { code: true } }),
    );
    expect(remaining.filter((row) => row.code.toLowerCase() === 'qa')).toHaveLength(1);
  });

  it('allows the same code in another entity', async () => {
    const { companyId } = fixture(ACME);
    const secondEntity = uuidv7();
    const id = uuidv7();

    // Scoped to the entity, not the tenant: two entities of the same company each having a
    // "QA" is the ordinary case, not a collision.
    await asOwner(ACME, async (tx) => {
      await tx.entity.create({
        data: { id: secondEntity, tenantId: ACME, companyId, code: 'ALT', name: 'Alternative' },
      });
      await tx.department.create({
        data: { id, tenantId: ACME, entityId: secondEntity, code: 'QA', name: 'Quality', path: id },
      });
    });

    const inAcme = await asOwner(ACME, (tx) => tx.department.count({ where: { code: 'QA' } }));
    const inOther = await asOwner(OTHER, (tx) => tx.department.count({ where: { code: 'QA' } }));

    expect(inAcme).toBe(2);
    // And the other tenant's own 'QA' is untouched — and invisible from here.
    expect(inOther).toBe(1);
  });

  it('lets a code be reused once the department holding it is soft-deleted', async () => {
    // The partial index skips deleted rows. Without that, deleting a department would burn its
    // code forever and the only way back would be a hard delete of audited history.
    const { entityId } = fixture(ACME);
    const first = uuidv7();
    const second = uuidv7();

    await asOwner(ACME, async (tx) => {
      await tx.department.create({
        data: { id: first, tenantId: ACME, entityId, code: 'TEMP', name: 'Temporary', path: first },
      });
      await tx.department.update({ where: { id: first }, data: { deletedAt: new Date() } });
    });

    await expect(
      asOwner(ACME, (tx) =>
        tx.department.create({
          data: { id: second, tenantId: ACME, entityId, code: 'TEMP', name: 'Reused', path: second },
        }),
      ),
    ).resolves.toMatchObject({ code: 'TEMP' });
  });

  it('allows a person only one primary department', async () => {
    const { quality, finance } = fixture(ACME);
    const userId = uuidv7();

    await asOwner(ACME, async (tx) => {
      await tx.user.create({
        data: {
          id: userId,
          tenantId: ACME,
          email: `member-${userId}@example.test`,
          emailNormalized: `member-${userId}@example.test`,
          displayName: 'Member',
          status: 'ACTIVE',
        },
      });
      await tx.userDepartment.create({
        data: { tenantId: ACME, userId, departmentId: quality, isPrimary: true },
      });
    });

    // A second primary would make "which department does their numbering come from" a question
    // with two answers, decided by whichever row a query happened to return first.
    await expect(
      asOwner(ACME, (tx) =>
        tx.userDepartment.create({
          data: { tenantId: ACME, userId, departmentId: finance, isPrimary: true },
        }),
      ),
    ).rejects.toThrowError(/Unique constraint failed/);

    // A second non-primary membership is ordinary, and stays allowed.
    await expect(
      asOwner(ACME, (tx) =>
        tx.userDepartment.create({
          data: { tenantId: ACME, userId, departmentId: finance, isPrimary: false },
        }),
      ),
    ).resolves.toBeDefined();

    const memberships = await asOwner(ACME, (tx) => tx.userDepartment.findMany({ where: { userId } }));
    expect(memberships).toHaveLength(2);
    expect(memberships.filter((row) => row.isPrimary)).toHaveLength(1);
  });

  it('keeps every organisation table behind row-level security', async () => {
    // `FORCE` matters as much as `ENABLE`: without it the owning role bypasses its own policies,
    // and every check above would be passing for the wrong reason.
    const rows = await owner.$queryRawUnsafe<
      { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE relname IN ('company', 'entity', 'branch', 'department', 'user_department')`,
    );

    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect({
        table: row.relname,
        enabled: row.relrowsecurity,
        forced: row.relforcerowsecurity,
      }).toEqual({ table: row.relname, enabled: true, forced: true });
    }
  });

  it('refuses to delete an entity that still holds departments', async () => {
    // `onDelete: Restrict`. An entity that vanished under a department would leave a path whose
    // ancestry names a row that is no longer there, and a chain the resolver cannot walk.
    await expect(
      asOwner(ACME, (tx) => tx.entity.delete({ where: { id: fixture(ACME).entityId } })),
    ).rejects.toThrowError();
  });
});
