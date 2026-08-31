import 'reflect-metadata';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type TenantId, type UserId, asId } from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import type { AppConfig } from '../../../core/config/configuration';
import type { Logger } from '../../../core/observability/logger';

import { PrismaUnitOfWork } from '../../../core/prisma/unit-of-work';
import { type RequestContext, runWithContext } from '../../../core/tenancy/tenant-context';
import { realAclResolver, realWriteStack } from '../../../testing/real-collaborators';
import { ScopeAdminService } from '../application/scope-admin.service';
import { OrganizationNodeKind } from '../domain/node-kind';
import { PrismaScopeAdminRepository } from '../infrastructure/prisma-scope-admin.repository';
import { sharedDatabase } from '../../../testing/tenant-database';

/**
 * The scope tree's writes, against a real PostgreSQL.
 *
 * What only a database can answer, and what this covers: that the partial unique indexes really do
 * free a code on soft delete and refuse it while live, that a version-guarded `updateMany` really
 * does make the second writer lose, that a move rewrites a whole subtree in one transaction and
 * leaves no half-moved tree, that the audit event and the outbox row commit *with* the change, and
 * that none of it reaches another tenant's rows.
 *
 * Run with `pnpm test:integration` against the compose stack, after migrations and post-migration
 * SQL. Excluded from CI, which has no database.
 */

const OWNER_URL = process.env['DATABASE_MIGRATION_URL'] ?? '';
const APP_URL = process.env['DATABASE_URL'] ?? '';

const ACME = asId<TenantId>(uuidv7());
const OTHER = asId<TenantId>(uuidv7());
const ADMIN = uuidv7();

const config = { env: 'test', database: { url: APP_URL, poolSize: 10 } } as unknown as AppConfig;
const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

/** A clock the test controls, so "one instant" is falsifiable and identifiers are ordered. */
let now = new Date('2026-05-01T09:00:00.000Z');
const clock = {
  now: () => new Date(now),
  timestamp: () => 0,
  elapsedMs: () => 0,
};

const prisma = sharedDatabase(config, logger, APP_URL);
const unitOfWork = new PrismaUnitOfWork(prisma);
// The real audit writer and the real outbox writer, composed as the container composes them: half
// of what this suite asserts is that they commit *with* the change, and a double cannot be wrong
// about that.
const { stamps, outbox, writer } = realWriteStack(clock, unitOfWork);
const service = new ScopeAdminService(
  new PrismaScopeAdminRepository(stamps),
  outbox,
  // Real, so a move clears real cache entries — this suite just never reads them back.
  realAclResolver({ clock, unitOfWork }),
  writer,
);

const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });

function contextFor(tenantId: TenantId): RequestContext {
  return {
    tenantId,
    userId: asId<UserId>(ADMIN),
    roles: ['TENANT_ADMIN'],
    permissions: [],
    sessionId: null,
    correlationId: `scope-admin-${tenantId}`,
    permissionVersion: 1,
    locale: 'en',
  };
}

/** Runs through the application's role, so row-level security is in force as in production. */
function asTenant<T>(tenantId: TenantId, work: () => Promise<T>): Promise<T> {
  return runWithContext(contextFor(tenantId), work);
}

interface Fixture {
  readonly companyId: string;
  readonly entityId: string;
}

const fixtures = new Map<TenantId, Fixture>();

async function seed(tenantId: TenantId, slug: string): Promise<Fixture> {
  await owner.tenant.create({ data: { id: tenantId, slug, name: slug, status: 'ACTIVE' } });
  await owner.user.create({
    data: {
      id: tenantId === ACME ? ADMIN : uuidv7(),
      tenantId,
      email: `admin@${slug}.test`,
      emailNormalized: `admin@${slug}.test`,
      displayName: 'Administrator',
      status: 'ACTIVE',
    },
  });

  const company = await asTenant(tenantId, () =>
    service.createCompany({ code: 'HQ', name: 'Head Office' }),
  );
  const entity = await asTenant(tenantId, () =>
    service.createEntity({ companyId: company.id, code: 'OPS', name: 'Operations' }),
  );
  return { companyId: company.id, entityId: entity.id };
}

function fixture(tenantId: TenantId): Fixture {
  const found = fixtures.get(tenantId);
  if (!found) {
    throw new Error('Fixture was not seeded.');
  }
  return found;
}

/**
 * Reads made as the owner name their tenant explicitly.
 *
 * `edms_owner` is a superuser, so it bypasses row-level security whether or not it is forced. An
 * unqualified count here would tally every tenant the suite has created.
 */
function ownerRead<T>(work: (client: PrismaClient) => Promise<T>): Promise<T> {
  return work(owner);
}

beforeAll(async () => {
  if (!OWNER_URL || !APP_URL) {
    throw new Error('DATABASE_URL and DATABASE_MIGRATION_URL must both be set.');
  }
  fixtures.set(ACME, await seed(ACME, `admin-acme-${Date.now()}`));
  fixtures.set(OTHER, await seed(OTHER, `admin-other-${Date.now()}`));
});

afterAll(async () => {
  await owner.$disconnect();
  await prisma.disconnectAll();
});

describe('creating a node', () => {
  it('stamps who and when from one clock reading', async () => {
    now = new Date('2026-05-02T10:00:00.000Z');
    const created = await asTenant(ACME, () =>
      service.createCompany({ code: 'SUB', name: 'Subsidiary' }),
    );

    // Same instant for both, and the acting user on both. A row whose created_at and updated_at
    // differ makes "was this ever edited?" unanswerable.
    expect(created.createdAt).toEqual(created.updatedAt);
    expect(created.createdAt.toISOString()).toBe('2026-05-02T10:00:00.000Z');
    expect(created.createdBy).toBe(ADMIN);
    expect(created.updatedBy).toBe(ADMIN);
    expect(created.version).toBe(1);
  });

  it('writes the audit event in the same transaction as the row', async () => {
    const created = await asTenant(ACME, () =>
      service.createCompany({ code: 'AUD', name: 'Audited' }),
    );

    const events = await ownerRead((client) =>
      client.auditEvent.findMany({
        where: { tenantId: ACME, subjectId: created.id },
        select: { action: true, payload: true, actorId: true },
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe('ORG_CHANGED');
    expect(events[0]?.actorId).toBe(ADMIN);
    // The payload says what happened, because the catalogue names an action per area rather than
    // per verb.
    expect(events[0]?.payload).toMatchObject({
      operation: 'CREATED',
      after: { code: 'AUD', name: 'Audited' },
    });
  });

  it('refuses a duplicate code, case-insensitively, before the index has to', async () => {
    await asTenant(ACME, () => service.createCompany({ code: 'DUP', name: 'First' }));

    // The partial unique index would refuse this anyway; checking first turns a constraint
    // violation into a 409 that names the field.
    await expect(
      asTenant(ACME, () => service.createCompany({ code: 'dup', name: 'Second' })),
    ).rejects.toMatchObject({ code: 'DUPLICATE' });
  });

  it('allows another tenant the same code', async () => {
    // Uniqueness is per tenant. Two customers both having an "HQ" is the ordinary case.
    await expect(
      asTenant(OTHER, () => service.createCompany({ code: 'DUP', name: 'Theirs' })),
    ).resolves.toMatchObject({ code: 'DUP' });
  });

  it('rolls the audit event back with a rejected change', async () => {
    const before = await ownerRead((client) =>
      client.auditEvent.count({ where: { tenantId: ACME } }),
    );

    await expect(
      asTenant(ACME, () => service.createCompany({ code: 'not a code', name: 'Invalid' })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    // The trail must never claim a change that did not happen. This is the half of "atomic with
    // the change" that a passing happy path does not demonstrate.
    expect(
      await ownerRead((client) => client.auditEvent.count({ where: { tenantId: ACME } })),
    ).toBe(before);
  });

  it('does not accept another tenant’s company as a parent', async () => {
    // Reported as "not found", not "forbidden": telling the two apart would confirm that the
    // identifier belongs to somebody.
    await expect(
      asTenant(ACME, () =>
        service.createEntity({ companyId: fixture(OTHER).companyId, code: 'X', name: 'Leak' }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('editing a node', () => {
  it('bumps the version and moves only the change stamps', async () => {
    now = new Date('2026-05-03T11:00:00.000Z');
    const created = await asTenant(ACME, () =>
      service.createCompany({ code: 'EDT', name: 'Before' }),
    );

    now = new Date('2026-05-04T12:00:00.000Z');
    const updated = await asTenant(ACME, () =>
      service.updateCompany(created.id, { name: 'After' }, created.version),
    );

    expect(updated.name).toBe('After');
    expect(updated.version).toBe(created.version + 1);
    expect(updated.createdAt).toEqual(created.createdAt);
    expect(updated.updatedAt.toISOString()).toBe('2026-05-04T12:00:00.000Z');
  });

  it('refuses a stale version rather than overwriting', async () => {
    const created = await asTenant(ACME, () => service.createCompany({ code: 'CNF', name: 'One' }));
    await asTenant(ACME, () => service.updateCompany(created.id, { name: 'Two' }, created.version));

    // The second administrator loses, loudly. Both screens showing success while one edit vanished
    // is the failure this exists to prevent.
    await expect(
      asTenant(ACME, () => service.updateCompany(created.id, { name: 'Three' }, created.version)),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });

    const row = await ownerRead((client) =>
      client.company.findFirst({ where: { id: created.id }, select: { name: true } }),
    );
    expect(row?.name).toBe('Two');
  });

  it('records only the fields that changed, with their previous values', async () => {
    const created = await asTenant(ACME, () => service.createCompany({ code: 'PAY', name: 'Old' }));
    await asTenant(ACME, () => service.updateCompany(created.id, { name: 'New' }, created.version));

    const events = await ownerRead((client) =>
      client.auditEvent.findMany({
        where: { tenantId: ACME, subjectId: created.id },
        orderBy: { sequence: 'asc' },
        select: { payload: true },
      }),
    );

    // Changed fields only, never a snapshot of the row: a full copy would make the trail a second
    // store of the data it describes, with no soft delete and no retention policy.
    expect(events[1]?.payload).toEqual({
      operation: 'UPDATED',
      before: { name: 'Old' },
      after: { name: 'New' },
    });
  });
});

describe('deleting and restoring', () => {
  it('refuses to delete a company that still holds an entity, and says how many', async () => {
    const { companyId } = fixture(ACME);
    const company = await asTenant(ACME, () => service.getCompany(companyId));

    // Cascading would make "delete this company" a one-click way to remove every department in it.
    await expect(
      asTenant(ACME, () =>
        service.delete(OrganizationNodeKind.COMPANY, companyId, company.version),
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      fieldErrors: [{ field: 'entities', message: '1' }],
    });
  });

  it('soft-deletes an empty node, leaving the row in place', async () => {
    const created = await asTenant(ACME, () =>
      service.createCompany({ code: 'DEL', name: 'Doomed' }),
    );

    await asTenant(ACME, () =>
      service.delete(OrganizationNodeKind.COMPANY, created.id, created.version),
    );

    const row = await ownerRead((client) =>
      client.company.findFirst({
        where: { id: created.id },
        select: { deletedAt: true, deletedBy: true },
      }),
    );
    expect(row?.deletedAt).not.toBeNull();
    expect(row?.deletedBy).toBe(ADMIN);
  });

  it('frees the code for reuse, and takes it back on restore', async () => {
    const first = await asTenant(ACME, () => service.createCompany({ code: 'REU', name: 'First' }));
    const afterDelete = await asTenant(ACME, () => service.getCompany(first.id));
    await asTenant(ACME, () =>
      service.delete(OrganizationNodeKind.COMPANY, first.id, afterDelete.version),
    );

    // The partial index skips deleted rows, so the code is available again.
    const second = await asTenant(ACME, () =>
      service.createCompany({ code: 'REU', name: 'Second' }),
    );
    expect(second.code).toBe('REU');

    // And restoring the first would now collide. Checked before the write, so the caller gets a
    // conflict naming the code rather than a raw constraint violation.
    const deleted = await asTenant(ACME, () => service.getCompany(first.id));
    await expect(
      asTenant(ACME, () =>
        service.restore(OrganizationNodeKind.COMPANY, first.id, deleted.version),
      ),
    ).rejects.toMatchObject({ code: 'DUPLICATE' });
  });

  it('restores a node whose code is still free', async () => {
    const created = await asTenant(ACME, () =>
      service.createCompany({ code: 'BAK', name: 'Back' }),
    );
    const live = await asTenant(ACME, () => service.getCompany(created.id));
    await asTenant(ACME, () =>
      service.delete(OrganizationNodeKind.COMPANY, created.id, live.version),
    );

    const deleted = await asTenant(ACME, () => service.getCompany(created.id));
    await asTenant(ACME, () =>
      service.restore(OrganizationNodeKind.COMPANY, created.id, deleted.version),
    );

    const restored = await asTenant(ACME, () => service.getCompany(created.id));
    expect(restored.deletedAt).toBeNull();
    expect(restored.deletedBy).toBeNull();
  });

  it('treats restoring a live node as already done', async () => {
    // Two administrators clicking restore is not a conflict; the second wants the end state the
    // first produced.
    const created = await asTenant(ACME, () =>
      service.createCompany({ code: 'IDM', name: 'Idem' }),
    );
    await expect(
      asTenant(ACME, () =>
        service.restore(OrganizationNodeKind.COMPANY, created.id, created.version),
      ),
    ).resolves.toBeUndefined();
  });
});

describe('moving a department', () => {
  /**
   * A counter, not a slice of a uuid.
   *
   * `uuidv7` encodes the timestamp in its leading hex digits, so `uuidv7().slice(0, 4)` is the same
   * four characters for every call in a test run — which made every tree after the first collide on
   * its department codes.
   */
  let treeNumber = 0;

  async function tree(): Promise<{
    quality: string;
    docs: string;
    records: string;
    finance: string;
  }> {
    const { entityId } = fixture(ACME);
    treeNumber += 1;
    const suffix = String(treeNumber).padStart(3, '0');
    const quality = await asTenant(ACME, () =>
      service.createDepartment({ entityId, code: `QA${suffix}`, name: 'Quality' }),
    );
    const docs = await asTenant(ACME, () =>
      service.createDepartment({
        entityId,
        parentId: quality.id,
        code: `DC${suffix}`,
        name: 'Documentation',
      }),
    );
    const records = await asTenant(ACME, () =>
      service.createDepartment({
        entityId,
        parentId: docs.id,
        code: `RC${suffix}`,
        name: 'Records',
      }),
    );
    const finance = await asTenant(ACME, () =>
      service.createDepartment({ entityId, code: `FN${suffix}`, name: 'Finance' }),
    );
    return { quality: quality.id, docs: docs.id, records: records.id, finance: finance.id };
  }

  it('derives the path from the parent, never from the client', async () => {
    const { quality, docs, records } = await tree();

    const rows = await ownerRead((client) =>
      client.department.findMany({
        where: { tenantId: ACME, id: { in: [quality, docs, records] } },
        select: { id: true, path: true },
      }),
    );
    const byId = new Map(rows.map((row) => [row.id, row.path]));

    expect(byId.get(quality)).toBe(quality);
    expect(byId.get(docs)).toBe(`${quality}.${docs}`);
    expect(byId.get(records)).toBe(`${quality}.${docs}.${records}`);
  });

  it('rewrites the whole subtree, not just the node', async () => {
    const { quality, docs, records, finance } = await tree();
    const moved = await asTenant(ACME, () => service.getDepartment(docs));

    await asTenant(ACME, () => service.moveDepartment(docs, finance, moved.version));

    const rows = await ownerRead((client) =>
      client.department.findMany({
        where: { tenantId: ACME, id: { in: [docs, records] } },
        select: { id: true, path: true, parentId: true },
      }),
    );
    const byId = new Map(rows.map((row) => [row.id, row]));

    // The grandchild moved with its parent. A move that rewrote only the node would leave `records`
    // pointing at a path whose ancestry no longer exists, and the ACL resolver would walk it.
    expect(byId.get(docs)?.path).toBe(`${finance}.${docs}`);
    expect(byId.get(docs)?.parentId).toBe(finance);
    expect(byId.get(records)?.path).toBe(`${finance}.${docs}.${records}`);
    expect(await asTenant(ACME, () => service.getDepartment(quality))).toMatchObject({
      childCount: 0,
    });
  });

  it('publishes the move through the outbox, in the same transaction', async () => {
    const { docs, finance } = await tree();
    const moved = await asTenant(ACME, () => service.getDepartment(docs));

    await asTenant(ACME, () => service.moveDepartment(docs, finance, moved.version));

    const messages = await ownerRead((client) =>
      client.outboxMessage.findMany({
        where: { tenantId: ACME, aggregateId: docs, eventType: 'organization.department-moved' },
        select: { payload: true, processedAt: true },
      }),
    );

    expect(messages).toHaveLength(1);
    // Stored as an object, not a string containing JSON — a consumer reading this back must get
    // the payload rather than its serialisation.
    expect(messages[0]?.payload).toMatchObject({ departmentId: docs, toParentId: finance });
    expect(messages[0]?.processedAt).toBeNull();
  });

  it('refuses a move under the department’s own descendant', async () => {
    const { quality, records } = await tree();
    const node = await asTenant(ACME, () => service.getDepartment(quality));

    // Either half of a cycle produces a path containing the node twice and a walk that never
    // terminates.
    await expect(
      asTenant(ACME, () => service.moveDepartment(quality, records, node.version)),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      fieldErrors: [{ field: 'parentId', message: 'PARENT_IS_DESCENDANT' }],
    });
  });

  it('refuses a blind move, even though an edit allows one', async () => {
    const { docs, finance } = await tree();

    // A move's effect — every ACL granted along the old chain ceasing to apply — is not undone by
    // moving the node back, so it may not be performed against a state nobody has seen.
    await expect(
      asTenant(ACME, () => service.moveDepartment(docs, finance, undefined)),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('leaves the tree untouched when a move is refused', async () => {
    const { quality, docs, records } = await tree();
    const node = await asTenant(ACME, () => service.getDepartment(quality));

    await expect(
      asTenant(ACME, () => service.moveDepartment(quality, records, node.version)),
    ).rejects.toThrow();

    // Nothing partially applied: the rejection happened before any write, and the transaction would
    // have rolled back anything that had.
    const rows = await ownerRead((client) =>
      client.department.findMany({
        where: { tenantId: ACME, id: { in: [quality, docs, records] } },
        select: { id: true, path: true },
      }),
    );
    const byId = new Map(rows.map((row) => [row.id, row.path]));
    expect(byId.get(records)).toBe(`${quality}.${docs}.${records}`);
  });

  it('refuses a parent in another entity', async () => {
    const { companyId } = fixture(ACME);
    const otherEntity = await asTenant(ACME, () =>
      service.createEntity({ companyId, code: `ALT${uuidv7().slice(0, 3)}`, name: 'Alternative' }),
    );
    const foreign = await asTenant(ACME, () =>
      service.createDepartment({ entityId: otherEntity.id, code: 'FGN', name: 'Foreign' }),
    );
    const { docs } = await tree();
    const node = await asTenant(ACME, () => service.getDepartment(docs));

    // The chain the ACL resolver walks must not cross a legal boundary halfway up.
    await expect(
      asTenant(ACME, () => service.moveDepartment(docs, foreign.id, node.version)),
    ).rejects.toMatchObject({
      fieldErrors: [{ field: 'parentId', message: 'PARENT_IN_ANOTHER_ENTITY' }],
    });
  });
});

describe('listing', () => {
  it('pages, and reports a total that ignores the page', async () => {
    const page = await asTenant(ACME, () =>
      service.listCompanies({ page: 1, pageSize: 2, sortDirection: 'asc', deleted: 'live' }),
    );

    expect(page.data.length).toBeLessThanOrEqual(2);
    expect(page.meta.total).toBeGreaterThan(2);
    expect(page.meta.hasMore).toBe(true);
  });

  it('searches by name and by code, case-insensitively', async () => {
    await asTenant(ACME, () => service.createCompany({ code: 'SRCH', name: 'Findable Limited' }));

    const byName = await asTenant(ACME, () =>
      service.listCompanies({
        page: 1,
        pageSize: 25,
        sortDirection: 'asc',
        deleted: 'live',
        search: 'findable',
      }),
    );
    const byCode = await asTenant(ACME, () =>
      service.listCompanies({
        page: 1,
        pageSize: 25,
        sortDirection: 'asc',
        deleted: 'live',
        search: 'srch',
      }),
    );

    expect(byName.data.map((row) => row.code)).toContain('SRCH');
    expect(byCode.data.map((row) => row.code)).toContain('SRCH');
  });

  it('treats a wildcard in the search term as literal text', async () => {
    // The term arrives from a query string. If `%` were a wildcard, a search box would be a way to
    // enumerate a tenant's whole configuration.
    const page = await asTenant(ACME, () =>
      service.listCompanies({
        page: 1,
        pageSize: 25,
        sortDirection: 'asc',
        deleted: 'live',
        search: '%',
      }),
    );
    expect(page.data).toHaveLength(0);
  });

  it('shows only deleted rows for a recycle bin, with a total to match', async () => {
    const created = await asTenant(ACME, () =>
      service.createCompany({ code: 'BIN', name: 'Binned' }),
    );
    await asTenant(ACME, () =>
      service.delete(OrganizationNodeKind.COMPANY, created.id, created.version),
    );

    const bin = await asTenant(ACME, () =>
      service.listCompanies({ page: 1, pageSize: 25, sortDirection: 'asc', deleted: 'deleted' }),
    );

    // Filtered in the database, not fetched and filtered afterwards — otherwise `total` is a lie
    // and the page boundaries are wrong.
    expect(bin.data.map((row) => row.id)).toContain(created.id);
    expect(bin.data.every((row) => row.deletedAt !== null)).toBe(true);
    expect(bin.meta.total).toBe(bin.data.length);
  });

  it('never returns another tenant’s rows', async () => {
    const mine = await asTenant(ACME, () =>
      service.listCompanies({ page: 1, pageSize: 100, sortDirection: 'asc', deleted: 'all' }),
    );
    const theirs = await asTenant(OTHER, () =>
      service.listCompanies({ page: 1, pageSize: 100, sortDirection: 'asc', deleted: 'all' }),
    );

    const mineIds = new Set(mine.data.map((row) => row.id));
    expect(theirs.data.some((row) => mineIds.has(row.id))).toBe(false);
    expect(theirs.data.map((row) => row.id)).not.toContain(fixture(ACME).companyId);
  });

  it('does not read another tenant’s node by identifier', async () => {
    await expect(
      asTenant(ACME, () => service.getCompany(fixture(OTHER).companyId)),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('a suspended tenant', () => {
  it('can be read but not changed', async () => {
    const suspended = asId<TenantId>(uuidv7());
    await owner.tenant.create({
      data: { id: suspended, slug: `susp-${Date.now()}`, name: 'Suspended', status: 'SUSPENDED' },
    });

    // Read-only everywhere, checked once in the writer rather than eighteen times in eighteen
    // services (`08-permission-model.md` §4).
    await expect(
      asTenant(suspended, () => service.createCompany({ code: 'NOPE', name: 'Refused' })),
    ).rejects.toMatchObject({ code: 'TENANT_READ_ONLY' });

    await expect(
      asTenant(suspended, () =>
        service.listCompanies({ page: 1, pageSize: 25, sortDirection: 'asc', deleted: 'live' }),
      ),
    ).resolves.toMatchObject({ data: [] });
  });
});

/**
 * Finding a department past the first page — Slice 13, against a real PostgreSQL and 150 rows.
 *
 * The counterpart to the people case in `identity-admin.integration.spec.ts`, and the same
 * arithmetic: `/directory/departments` is fetched as one page of a hundred sorted ascending, so a
 * department at position 101 or beyond was simply not offered and a native `<select>` had no way to
 * ask for more. Departments are ACL subjects, so that is a unit of the organisation nobody could
 * grant a permission to.
 *
 * Departments needed no search-field narrowing: `listDepartments` matches `name` and `code`, and
 * `DepartmentOption` carries both, so it can only be probed for what it already shows.
 */
describe('a picker with more departments than one page', () => {
  const PREFIX = 'Zz Unit';
  const LAST = `${PREFIX} 150`;
  const ONE_PAGE = {
    page: 1,
    pageSize: 100,
    sortBy: 'name',
    sortDirection: 'asc',
    deleted: 'live',
  } as const;

  let deletedName: string;

  beforeAll(async () => {
    const { entityId } = fixture(ACME);
    for (let index = 1; index <= 150; index += 1) {
      const suffix = String(index).padStart(3, '0');
      await asTenant(ACME, () =>
        service.createDepartment({ entityId, code: `ZZU${suffix}`, name: `${PREFIX} ${suffix}` }),
      );
    }

    deletedName = `${PREFIX} 077`;
    const page = await asTenant(ACME, () =>
      service.listDepartments({ ...ONE_PAGE, search: deletedName }),
    );
    const departed = page.data[0];
    if (departed !== undefined) {
      await asTenant(ACME, () =>
        service.delete(OrganizationNodeKind.DEPARTMENT, departed.id, departed.version),
      );
    }
  }, 180_000);

  it('cannot offer the department at all without a search', async () => {
    const page = await asTenant(ACME, () => service.listDepartments({ ...ONE_PAGE }));

    expect(page.data).toHaveLength(100);
    expect(page.data.map((row) => row.name)).not.toContain(LAST);
    expect(page.meta.hasMore).toBe(true);
  });

  it('returns exactly that department when it is searched for', async () => {
    const page = await asTenant(ACME, () => service.listDepartments({ ...ONE_PAGE, search: LAST }));

    expect(page.data.map((row) => row.name)).toStrictEqual([LAST]);
  });

  it('matches by code as well, which is what the option carries beside the name', async () => {
    const page = await asTenant(ACME, () =>
      service.listDepartments({ ...ONE_PAGE, search: 'zzu150' }),
    );

    expect(page.data.map((row) => row.name)).toStrictEqual([LAST]);
  });

  it('never returns a deleted department, however precisely it is named', async () => {
    const page = await asTenant(ACME, () =>
      service.listDepartments({ ...ONE_PAGE, search: deletedName }),
    );

    expect(page.data).toStrictEqual([]);
  });

  it('answers an empty list when nothing matches', async () => {
    const page = await asTenant(ACME, () =>
      service.listDepartments({ ...ONE_PAGE, search: 'no such unit anywhere' }),
    );

    expect(page.data).toStrictEqual([]);
    expect(page.meta.total).toBe(0);
  });

  it('cannot search into another tenant', async () => {
    // The second tenant this suite already runs against, asked the same question.
    const elsewhere = await asTenant(OTHER, () =>
      service.listDepartments({ ...ONE_PAGE, search: LAST }),
    );

    expect(elsewhere.data).toStrictEqual([]);
  });
});

/**
 * Two callers, each parked at the statement that claims a code.
 *
 * Gated on an explicit marker rather than on "the turnstile is armed", so a suite that arms once
 * and then performs ordinary setup through the same repository does not park its own calls, take
 * ordinals no slot was armed for, and leave the caller it does want to hold waiting for ever.
 */
class Turnstile<TMarker> {
  readonly arrivals: TMarker[] = [];
  readonly reached: Promise<void>[] = [];
  private readonly announce: (() => void)[] = [];
  private readonly admissions: Promise<void>[] = [];
  private readonly admits: (() => void)[] = [];

  arm(callers: number): number {
    const base = this.reached.length;
    for (let index = 0; index < callers; index += 1) {
      let arrive: () => void = () => undefined;
      this.reached.push(
        new Promise<void>((resolve) => {
          arrive = resolve;
        }),
      );
      this.announce.push(arrive);
      let admit: () => void = () => undefined;
      this.admissions.push(
        new Promise<void>((resolve) => {
          admit = resolve;
        }),
      );
      this.admits.push(admit);
    }
    return base;
  }

  async park(marker: TMarker): Promise<void> {
    const ordinal = this.arrivals.length;
    this.arrivals.push(marker);
    this.announce[ordinal]?.();
    await this.admissions[ordinal];
  }

  release(ordinal: number): void {
    this.admits[ordinal]?.();
  }
}

/**
 * One code, one live node, however the second claim on it arrives — Slice 66.
 *
 * Every scope kind carries a partial unique index on `(parent, lower(code)) WHERE deleted_at IS
 * NULL`, and every `…CodeTaken` reads that same condition — `mode: 'insensitive'` against the
 * index's `lower(code)`, which the repository's own comment says is deliberate. So the check and
 * the constraint describe one state, asked at two moments, and an administrator who claims the code
 * in between leaves the write to meet the index.
 *
 * This suite already pins the ordered answer: restoring a company whose code was re-used expects
 * `DUPLICATE`, "naming the code rather than a raw constraint violation". These are the same two
 * administrators, at once.
 */
describe('one code, one live node, however the second claim arrives', () => {
  const turnstile = new Turnstile<string>();
  /** Which write this test wants to stop at, and nothing else stops. */
  let parkOn: string | null = null;

  /** The real repository, subclassed: each override only adds a place to stand before its write. */
  class ParkingScopeRepository extends PrismaScopeAdminRepository {
    override async insertDepartment(
      input: Parameters<PrismaScopeAdminRepository['insertDepartment']>[0],
    ): Promise<void> {
      if (parkOn === `create:${input.code}`) {
        await turnstile.park(`create:${input.code}`);
      }
      return super.insertDepartment(input);
    }

    override async setDeleted(
      kind: Parameters<PrismaScopeAdminRepository['setDeleted']>[0],
      id: string,
      version: number,
      deleted: boolean,
    ): Promise<void> {
      if (!deleted && parkOn === `restore:${id}`) {
        await turnstile.park(`restore:${id}`);
      }
      return super.setDeleted(kind, id, version, deleted);
    }
  }

  const parking = new ScopeAdminService(
    new ParkingScopeRepository(stamps),
    outbox,
    realAclResolver({ clock, unitOfWork }),
    writer,
  );

  async function liveDepartments(entityId: string, code: string): Promise<number> {
    return owner.department.count({
      where: { entityId, code: { equals: code, mode: 'insensitive' }, deletedAt: null },
    });
  }

  it('creates the department when nothing contends', async () => {
    // The control. Without it every assertion below passes on a service that creates nothing.
    const { entityId } = fixture(ACME);
    const code = `SOLO${String(Date.now()).slice(-5)}`;
    const created = await asTenant(ACME, () =>
      parking.createDepartment({ entityId, code, name: 'Solo' }),
    );

    expect(created.id).toBeTruthy();
    expect(await liveDepartments(entityId, code)).toBe(1);
  });

  it('reports a failure that is not a duplicate as itself', async () => {
    /*
     * The narrowing, asserted. Translating *every* failure from a claiming write into "that code is
     * already in use" would hide a genuine fault behind a plausible refusal, so the predicate is
     * `P2002` on the kind's own model and nothing else. A department under an entity that does not
     * exist violates the foreign key instead, and must surface as itself.
     *
     * Driven at the repository, because the service refuses an unknown entity before it ever
     * reaches the insert — which is correct, and is exactly why the repository's own narrowing
     * needs its own proof.
     */
    const repository = new PrismaScopeAdminRepository(stamps);
    const outcome = await asTenant(ACME, () =>
      unitOfWork.run(() =>
        repository.insertDepartment({
          id: uuidv7(),
          entityId: uuidv7(),
          branchId: null,
          parentId: null,
          code: `ORPH${String(Date.now()).slice(-5)}`,
          name: 'Orphan',
          path: 'orphan',
        }),
      ),
    ).then(
      () => ({ kind: 'inserted' as const, error: undefined }),
      (error: unknown) => ({ kind: 'refused' as const, error }),
    );

    expect(outcome.kind).toBe('refused');
    expect(outcome.error).not.toMatchObject({ code: 'DUPLICATE' });
  });

  it('refuses the loser the way the ordered second caller is refused', async () => {
    const { entityId } = fixture(ACME);
    const code = `CONT${String(Date.now()).slice(-5)}`;
    expect(await liveDepartments(entityId, code)).toBe(0);
    parkOn = `create:${code}`;
    const base = turnstile.arm(2);

    // Each from its own scope, so each opens its own transaction. Both reach the insert only after
    // their own `departmentCodeTaken` answered "free", which is what parking here proves.
    const one = asTenant(ACME, () => parking.createDepartment({ entityId, code, name: 'One' }));
    await turnstile.reached[base];
    const two = asTenant(ACME, () => parking.createDepartment({ entityId, code, name: 'Two' }));
    await turnstile.reached[base + 1];

    expect(turnstile.arrivals.slice(-2)).toEqual([`create:${code}`, `create:${code}`]);

    turnstile.release(base);
    const winner = await one.then(
      (value) => ({ kind: 'created' as const, value }),
      (error: unknown) => ({ kind: 'refused' as const, error }),
    );
    turnstile.release(base + 1);
    const loser = await two.then(
      () => ({ kind: 'created' as const, error: undefined }),
      (error: unknown) => ({ kind: 'refused' as const, error }),
    );

    expect(winner.kind).toBe('created');
    expect(await liveDepartments(entityId, code)).toBe(1);
    expect(loser.kind).toBe('refused');
    expect(loser.error).toMatchObject({ code: 'DUPLICATE' });
    // The department's duplicate, not another node kind's: a refusal naming the wrong resource
    // would send an administrator to the wrong screen.
    expect((loser.error as Error).message).toContain('department');
  });

  it('refuses a restore whose code is claimed while the restore is deciding', async () => {
    const { entityId } = fixture(ACME);
    const code = `RECY${String(Date.now()).slice(-5)}`;
    const first = await asTenant(ACME, () =>
      parking.createDepartment({ entityId, code, name: 'First Spell' }),
    );
    await asTenant(ACME, () =>
      parking.delete(OrganizationNodeKind.DEPARTMENT, first.id, first.version),
    );
    expect(await liveDepartments(entityId, code)).toBe(0);

    const deleted = await asTenant(ACME, () => parking.getDepartment(first.id));
    parkOn = `restore:${first.id}`;
    const base = turnstile.arm(1);

    const restoring = asTenant(ACME, () =>
      parking.restore(OrganizationNodeKind.DEPARTMENT, first.id, deleted.version),
    );
    await turnstile.reached[base];

    // The code is taken again while the restore is parked — the sequence the partial index exists
    // to permit, arriving in the window between the check and the write.
    const second = await asTenant(ACME, () =>
      parking.createDepartment({ entityId, code, name: 'Second Spell' }),
    );
    expect(second.id).not.toBe(first.id);
    expect(await liveDepartments(entityId, code)).toBe(1);

    turnstile.release(base);
    const outcome = await restoring.then(
      () => ({ kind: 'restored' as const, error: undefined }),
      (error: unknown) => ({ kind: 'refused' as const, error }),
    );

    expect(await liveDepartments(entityId, code)).toBe(1);
    expect(outcome.kind).toBe('refused');
    expect(outcome.error).toMatchObject({ code: 'DUPLICATE' });
  });
});
