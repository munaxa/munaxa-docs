import 'reflect-metadata';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type TenantId, type UserId, asId, idsInPath, pathFor } from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import type { AppConfig } from '../../../core/config/configuration';
import type { Logger } from '../../../core/observability/logger';

import { PrismaUnitOfWork } from '../../../core/prisma/unit-of-work';
import { type RequestContext, runWithContext } from '../../../core/tenancy/tenant-context';
import { realAclResolver, realWriteStack } from '../../../testing/real-collaborators';
import { ScopeAdminService } from '../application/scope-admin.service';
import { OrganizationNodeKind } from '../domain/node-kind';
import type { DepartmentRow } from '../application/ports';
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

/**
 * Slice 124 — a restore under a parent that is still in the recycle bin.
 *
 * Every `create*` refuses a parent that is not live, and `moveDepartment` refuses one too. A delete
 * can only reach a parent once its children are gone, so deleting a child, then its parent, then
 * restoring the child was the one way to produce a live node beneath a retired one — and
 * `PrismaScopeChainReader` refuses to assemble a chain across a retired node, so everything that
 * then hangs from the restored node is a `404` to every caller. The ACL suite asserts that
 * consequence; this one asserts the refusal, once for each edge a node can hang from.
 */
describe('restoring beneath a parent that is still deleted', () => {
  let n = 0;
  // Its own namespace, so no code here is one another block in this file also mints. Nothing is
  // shared between the blocks but the tenant, and a code is part of what a node claims.
  const code = (prefix: string): string => {
    n += 1;
    return `RST${prefix}${String(n).padStart(3, '0')}`;
  };

  const retire = async (
    kind: (typeof OrganizationNodeKind)[keyof typeof OrganizationNodeKind],
    id: string,
    read: () => Promise<{ version: number }>,
  ) => asTenant(ACME, async () => service.delete(kind, id, (await read()).version));

  const bringBack = async (
    kind: (typeof OrganizationNodeKind)[keyof typeof OrganizationNodeKind],
    id: string,
    read: () => Promise<{ version: number }>,
  ) => asTenant(ACME, async () => service.restore(kind, id, (await read()).version));

  it('refuses a department whose parent department is deleted, and leaves it in the bin', async () => {
    const { entityId } = fixture(ACME);
    const parent = await asTenant(ACME, () =>
      service.createDepartment({ entityId, code: code('RP'), name: 'Retired parent' }),
    );
    const child = await asTenant(ACME, () =>
      service.createDepartment({ entityId, parentId: parent.id, code: code('RC'), name: 'Child' }),
    );
    await retire(OrganizationNodeKind.DEPARTMENT, child.id, () => service.getDepartment(child.id));
    await retire(OrganizationNodeKind.DEPARTMENT, parent.id, () =>
      service.getDepartment(parent.id),
    );

    await expect(
      bringBack(OrganizationNodeKind.DEPARTMENT, child.id, () =>
        asTenant(ACME, () => service.getDepartment(child.id)),
      ),
    ).rejects.toMatchObject({ fieldErrors: [{ field: 'parentId', message: 'deleted' }] });

    const row = await ownerRead((client) =>
      client.department.findFirstOrThrow({ where: { id: child.id }, select: { deletedAt: true } }),
    );
    expect(row.deletedAt).not.toBeNull();
  });

  it('refuses a department whose entity is deleted', async () => {
    const { companyId } = fixture(ACME);
    const entity = await asTenant(ACME, () =>
      service.createEntity({ companyId, code: code('RE'), name: 'Retired entity' }),
    );
    const department = await asTenant(ACME, () =>
      service.createDepartment({ entityId: entity.id, code: code('RD'), name: 'Under it' }),
    );
    await retire(OrganizationNodeKind.DEPARTMENT, department.id, () =>
      service.getDepartment(department.id),
    );
    await retire(OrganizationNodeKind.ENTITY, entity.id, () => service.getEntity(entity.id));

    await expect(
      bringBack(OrganizationNodeKind.DEPARTMENT, department.id, () =>
        asTenant(ACME, () => service.getDepartment(department.id)),
      ),
    ).rejects.toMatchObject({ fieldErrors: [{ field: 'entityId', message: 'deleted' }] });
  });

  it('refuses an entity whose company is deleted', async () => {
    const company = await asTenant(ACME, () =>
      service.createCompany({ code: code('RK'), name: 'Retired company' }),
    );
    const entity = await asTenant(ACME, () =>
      service.createEntity({ companyId: company.id, code: code('RN'), name: 'Under it' }),
    );
    await retire(OrganizationNodeKind.ENTITY, entity.id, () => service.getEntity(entity.id));
    await retire(OrganizationNodeKind.COMPANY, company.id, () => service.getCompany(company.id));

    await expect(
      bringBack(OrganizationNodeKind.ENTITY, entity.id, () =>
        asTenant(ACME, () => service.getEntity(entity.id)),
      ),
    ).rejects.toMatchObject({ fieldErrors: [{ field: 'companyId', message: 'deleted' }] });
  });

  it('refuses a branch whose entity is deleted', async () => {
    const { companyId } = fixture(ACME);
    const entity = await asTenant(ACME, () =>
      service.createEntity({ companyId, code: code('RB'), name: 'Retired entity' }),
    );
    const branch = await asTenant(ACME, () =>
      service.createBranch({ entityId: entity.id, code: code('RS'), name: 'Site' }),
    );
    await retire(OrganizationNodeKind.BRANCH, branch.id, () => service.getBranch(branch.id));
    await retire(OrganizationNodeKind.ENTITY, entity.id, () => service.getEntity(entity.id));

    await expect(
      bringBack(OrganizationNodeKind.BRANCH, branch.id, () =>
        asTenant(ACME, () => service.getBranch(branch.id)),
      ),
    ).rejects.toMatchObject({ fieldErrors: [{ field: 'entityId', message: 'deleted' }] });
  });

  it('restores the child once its parent is back — the way out the refusal points to', async () => {
    const { entityId } = fixture(ACME);
    const parent = await asTenant(ACME, () =>
      service.createDepartment({ entityId, code: code('WP'), name: 'Returning parent' }),
    );
    const child = await asTenant(ACME, () =>
      service.createDepartment({ entityId, parentId: parent.id, code: code('WC'), name: 'Child' }),
    );
    await retire(OrganizationNodeKind.DEPARTMENT, child.id, () => service.getDepartment(child.id));
    await retire(OrganizationNodeKind.DEPARTMENT, parent.id, () =>
      service.getDepartment(parent.id),
    );

    await bringBack(OrganizationNodeKind.DEPARTMENT, parent.id, () =>
      asTenant(ACME, () => service.getDepartment(parent.id)),
    );
    await bringBack(OrganizationNodeKind.DEPARTMENT, child.id, () =>
      asTenant(ACME, () => service.getDepartment(child.id)),
    );

    const rows = await ownerRead((client) =>
      client.department.findMany({
        where: { id: { in: [parent.id, child.id] } },
        select: { deletedAt: true },
      }),
    );
    expect(rows.filter((row) => row.deletedAt === null)).toHaveLength(2);
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

/**
 * A move rewrites the paths it read, and only those — Slice 67.
 *
 * `moveDepartment` reads its subtree, computes every descendant's new path from that snapshot, and
 * writes them back. The moved node's own write was version-guarded; the descendants' writes were
 * not, and the repository said why: a descendant's *path* "is derived data owned by this module,
 * not a field anybody edits, so there is no concurrent edit to lose to".
 *
 * There is one, and it is this same method: `moveDepartment` edits a descendant's `path` **and the
 * `parent_id` of the node it was asked to move**, so two moves inside one subtree are two writers
 * of one row. The second mover's guard protected the node it acted on; nothing protected that node
 * from the first mover's unguarded rewrite of it as somebody else's descendant.
 *
 * What came out was a row whose `path` and whose `parent_id` named different parents — and `path`
 * is the one that decides access. `PrismaAclResolver.departmentsOf` is `idsInPath(row.path)`, so a
 * member of that department carried the ancestors the path named as ACL subjects: an entry granted
 * on the ancestry it had left reached them, and the ancestry it had joined did not.
 *
 * These tests are the two administrators, at once, in both directions — and the third is the case
 * the guard must *not* refuse.
 *
 * **What changed under them in Slice 112, and what did not.** A move now holds the subtree it is
 * about to rewrite, and the parent it is moving to, before it reads any of it. Every pair below
 * touches a row inside the other's subtree, so none of them can both be deciding any more: they
 * queue, and whichever goes second reads the tree the first one left and is right about it. The
 * barriers are therefore gone — parking the first move now holds the very row the second one needs,
 * which is the interleaving the lock exists to forbid — and what each test asserts is the ordered
 * outcome rather than the race.
 *
 * The guard the block is named for is untouched and still in the repository, and the reason it is
 * kept rather than removed is that it is what makes the ordering *checkable*: it is the statement
 * that would refuse if a snapshot ever were stale, and every assertion below is that it does not
 * have to.
 */
describe('a move that rewrites a subtree it no longer owns', () => {
  let treeNumber = 0;

  /** `parent → child → grandchild` with a `sibling` beside the child, plus two roots to move to. */
  async function tree(): Promise<{
    parent: DepartmentRow;
    child: DepartmentRow;
    grandchild: DepartmentRow;
    sibling: DepartmentRow;
    elsewhere: DepartmentRow;
    destination: DepartmentRow;
  }> {
    const { entityId } = fixture(ACME);
    treeNumber += 1;
    const suffix = `M${String(treeNumber).padStart(2, '0')}${String(Date.now()).slice(-4)}`;
    const parent = await asTenant(ACME, () =>
      service.createDepartment({ entityId, code: `PA${suffix}`, name: 'Parent' }),
    );
    const child = await asTenant(ACME, () =>
      service.createDepartment({
        entityId,
        parentId: parent.id,
        code: `CH${suffix}`,
        name: 'Child',
      }),
    );
    const grandchild = await asTenant(ACME, () =>
      service.createDepartment({
        entityId,
        parentId: child.id,
        code: `GC${suffix}`,
        name: 'Grandchild',
      }),
    );
    const sibling = await asTenant(ACME, () =>
      service.createDepartment({
        entityId,
        parentId: parent.id,
        code: `SB${suffix}`,
        name: 'Sibling',
      }),
    );
    const destination = await asTenant(ACME, () =>
      service.createDepartment({ entityId, code: `DE${suffix}`, name: 'Destination' }),
    );
    const elsewhere = await asTenant(ACME, () =>
      service.createDepartment({ entityId, code: `EL${suffix}`, name: 'Elsewhere' }),
    );
    return { parent, child, grandchild, sibling, destination, elsewhere };
  }

  async function rowOf(id: string): Promise<{ parentId: string | null; path: string }> {
    const row = await owner.department.findUniqueOrThrow({
      where: { id },
      select: { parentId: true, path: true },
    });
    return row;
  }

  /** Every live department's path, derived from the parent it actually points at. */
  async function pathsDisagreeingWithTheirParent(): Promise<string[]> {
    const rows = await owner.department.findMany({
      where: { tenantId: ACME, deletedAt: null },
      select: { id: true, parentId: true, path: true },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    return rows
      .filter((row) => {
        const parent = row.parentId === null ? null : byId.get(row.parentId);
        return row.path !== pathFor(parent?.path ?? null, row.id);
      })
      .map((row) => row.id);
  }

  it('moves a subtree when nothing contends', async () => {
    // The control. Without it every assertion below passes on a service that moves nothing.
    const { parent, child, destination } = await tree();
    const moved = await asTenant(ACME, () =>
      service.moveDepartment(parent.id, destination.id, parent.version),
    );

    expect(moved.path).toBe(pathFor(destination.path, parent.id));
    expect((await rowOf(child.id)).path).toBe(pathFor(moved.path, child.id));
    expect(await pathsDisagreeingWithTheirParent()).toEqual([]);
  });

  it('orders the two when a descendant moves out of the subtree', async () => {
    /*
     * Two administrators, at once: one moves the parent, the other moves the child out from under
     * it. The second one's snapshot used to be able to go stale, and the guard refused it. The two
     * now share the child and the grandchild — they are in the first move's subtree and are the
     * second move's own — so they queue instead, and both are right.
     */
    const { parent, child, grandchild, destination, elsewhere } = await tree();

    const outcomes = await Promise.allSettled([
      asTenant(ACME, () => service.moveDepartment(parent.id, destination.id, parent.version)),
      asTenant(ACME, () => service.moveDepartment(child.id, elsewhere.id, child.version)),
    ]);

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled']);

    // Whichever order they took, the child describes the ancestry it has and not the one it left:
    // `departmentsOf` is `idsInPath(path)`, so a stale path is a stale set of ACL subjects.
    const movedChild = await rowOf(child.id);
    expect(movedChild.parentId).toBe(elsewhere.id);
    expect(movedChild.path).toBe(pathFor(elsewhere.path, child.id));
    expect(idsInPath(movedChild.path)).not.toContain(parent.id);
    // And the grandchild went with it rather than being left behind under either mover's snapshot.
    expect((await rowOf(grandchild.id)).path).toBe(pathFor(movedChild.path, grandchild.id));
    expect((await rowOf(parent.id)).path).toBe(pathFor(destination.path, parent.id));
    expect(await pathsDisagreeingWithTheirParent()).toEqual([]);
  });

  it('orders the two when the descendant only moved within the same subtree', async () => {
    /*
     * The case the guard used to answer here, and what answers it now — Slice 112.
     *
     * This was the second half of Slice 67: a descendant that moves to another branch of the *same*
     * subtree leaves the rest of the snapshot wrong about it too, so the whole move was refused
     * together rather than the one unrecognised row being skipped.
     *
     * It is no longer a stale snapshot, because the two moves can no longer both be deciding. The
     * grandchild's new parent is the sibling, whose path names the parent, and a move now holds the
     * node, the parent and the parent's ancestors before it reads anything — so these two meet on
     * the parent and queue. Whichever goes second reads the tree the first one left and is right
     * about it, which is why both succeed and nothing is refused.
     *
     * The guard itself is untouched and still proven, by the test above: there the descendant moves
     * *out* of the subtree, to a root of its own, so the two moves share no row, both decide at
     * once exactly as before, and the loser is still told `VERSION_CONFLICT`. Barriered here would
     * only park the first move holding the row the second one needs, which is the interleaving the
     * lock exists to forbid, so this runs them with nothing holding either.
     */
    const { parent, child, grandchild, sibling, destination } = await tree();

    const outcomes = await Promise.allSettled([
      asTenant(ACME, () => service.moveDepartment(parent.id, destination.id, parent.version)),
      asTenant(ACME, () => service.moveDepartment(grandchild.id, sibling.id, grandchild.version)),
    ]);

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled']);

    // Whichever order they took, the tree they left agrees with itself: the subtree hangs from the
    // destination, and the grandchild hangs from the sibling inside it.
    const movedParent = await rowOf(parent.id);
    expect(movedParent.path).toBe(pathFor(destination.path, parent.id));
    expect((await rowOf(child.id)).path).toBe(pathFor(movedParent.path, child.id));
    const movedSibling = await rowOf(sibling.id);
    expect(movedSibling.path).toBe(pathFor(movedParent.path, sibling.id));
    expect((await rowOf(grandchild.id)).path).toBe(pathFor(movedSibling.path, grandchild.id));
    expect(await pathsDisagreeingWithTheirParent()).toEqual([]);
  });

  it('still moves when a descendant is put in the recycle bin at the same time', async () => {
    /*
     * The other side of the guard: what must *not* become a conflict.
     *
     * Soft-deleting a leaf does not move anything, so a move has nothing to lose to it, and neither
     * operation may be refused because the other happened. The two now order — the delete writes a
     * row inside the subtree the move holds — and both still succeed, which is the guarantee this
     * test has always been about.
     *
     * Which path the deleted row ends up with depends on which went first, and deliberately is not
     * asserted: `departmentSubtree` never sees a row already in the bin, so a leaf deleted before
     * the move keeps the ancestry it had, and one deleted after it is carried. That was true before
     * this lock and is unchanged by it.
     */
    const { parent, child, grandchild, destination } = await tree();

    const outcomes = await Promise.allSettled([
      asTenant(ACME, () => service.moveDepartment(parent.id, destination.id, parent.version)),
      asTenant(ACME, () =>
        service.delete(OrganizationNodeKind.DEPARTMENT, grandchild.id, grandchild.version),
      ),
    ]);

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled']);

    const movedParent = await rowOf(parent.id);
    expect(movedParent.path).toBe(pathFor(destination.path, parent.id));
    expect((await rowOf(child.id)).path).toBe(pathFor(movedParent.path, child.id));
    expect(
      await owner.department.count({ where: { id: grandchild.id, deletedAt: { not: null } } }),
    ).toBe(1);
    expect(await pathsDisagreeingWithTheirParent()).toEqual([]);
  });
});

/**
 * Two moves that would put each department inside the other — Slice 112.
 *
 * ## What the code says
 *
 * `moveDepartment` is documented as the operation the permission model depends on: it "rewrites
 * derived data the ACL resolver reads", and the tree arithmetic it uses says why a cycle may never
 * be written — "a node cannot be its own parent, and it cannot move under one of its own
 * descendants. Either produces a path containing the node twice and a walk that never terminates —
 * cheap to refuse here, and expensive to discover afterwards, because by then the tree is already
 * corrupt." The check that refuses it is `checkPlacement`, and this suite already pins it for one
 * administrator: a move under the node's own descendant is `PARENT_IS_DESCENDANT`.
 *
 * ## What it did
 *
 * `checkPlacement` compares two rows — the node's path and the candidate parent's — and
 * `subtreeFitsUnder` measures a third thing, the snapshot about to be rewritten. All of it is
 * read. The only thing held is the version of the single row the caller named, and Slice 67 added
 * a guard on the *descendants'* parents; neither covers the department at the other end of the
 * move.
 *
 * So two administrators reorganising at once decided from the same tree and wrote different parts
 * of it. Two roots moved under each other read each other's old paths, neither saw a cycle, and
 * both commits stood: each row named the other as its parent and carried the other in its path.
 * The same held one level down, where the two lock sets a narrower fix would have taken are
 * disjoint — moving each root under the *other's child* crossed the two subtrees with nothing in
 * common to contend on.
 *
 * That state is the one the guard exists to prevent. `PrismaAclResolver.departmentsOf` is
 * `idsInPath(row.path)`, so each department's members then carried the other department as an ACL
 * subject — a grant reaching upward, against the direction this model says permission flows — and
 * neither department was reachable from the top of its entity's tree at all.
 *
 * ## What proves it
 *
 * The fix is mutual exclusion, so the interleaving the defect needs is the one the fix forbids and
 * a two-caller turnstile downstream of the lock would hang rather than reproduce. The evidence is
 * the shape Slices 104, 107, 108 and 110 settled on: the **outcome**, from the two moves run
 * concurrently with no barrier — deterministic because the situation is symmetric, so whichever
 * move arrives second is refused for the same reason a single administrator would be — and the
 * **mechanism**, from a second database session probing with `FOR UPDATE NOWAIT` while a move is
 * parked mid-transaction, including the probes that must come back free.
 *
 * What is held is the subtree the move rewrites and the row it is moving to: everything the move
 * writes, plus the one row outside it that its answer depends on. That is what makes two crossing
 * moves meet — for this node to end up inside the other's subtree, the other's destination has to
 * lie inside this one's — and it is also what keeps the lock free of deadlock, because a move that
 * has finished locking never waits for a department row again.
 */
describe('two moves that would put each department inside the other', () => {
  /**
   * The real repository, subclassed: a place to stand inside a move's transaction, after the
   * service has taken its lock and read the tree, and before anything is written.
   *
   * One caller only. A second would be held by the very lock under test and could never arrive.
   */
  class ParkedMove extends PrismaScopeAdminRepository {
    reached: (() => void) | null = null;
    admit: Promise<void> | null = null;
    target: string | null = null;

    override async moveDepartment(
      input: Parameters<PrismaScopeAdminRepository['moveDepartment']>[0],
    ): Promise<void> {
      const gate = this.admit;
      if (gate !== null && input.id === this.target) {
        this.admit = null;
        this.reached?.();
        await gate;
      }
      return super.moveDepartment(input);
    }
  }

  let crossings = 0;
  /** A second entity under the same company, so "only this entity" is falsifiable. */
  let elsewhereEntityId = '';

  beforeAll(async () => {
    const { companyId } = fixture(ACME);
    const entity = await asTenant(ACME, () =>
      service.createEntity({ companyId, code: 'X112', name: 'Second Operations' }),
    );
    elsewhereEntityId = entity.id;
  });

  /** A root department, or a child of one, in whichever entity is named. */
  function department(
    entityId: string,
    code: string,
    parentId: string | null,
  ): Promise<DepartmentRow> {
    return asTenant(ACME, () =>
      service.createDepartment({
        entityId,
        ...(parentId === null ? {} : { parentId }),
        code,
        name: code,
      }),
    );
  }

  /** Two independent roots in the tenant's main entity, each with a child of its own. */
  async function twoSubtrees(): Promise<{
    left: DepartmentRow;
    leftChild: DepartmentRow;
    right: DepartmentRow;
    rightChild: DepartmentRow;
  }> {
    const { entityId } = fixture(ACME);
    crossings += 1;
    const suffix = `X${String(crossings).padStart(2, '0')}${String(Date.now()).slice(-4)}`;
    const left = await department(entityId, `LF${suffix}`, null);
    const leftChild = await department(entityId, `LC${suffix}`, left.id);
    const right = await department(entityId, `RG${suffix}`, null);
    const rightChild = await department(entityId, `RC${suffix}`, right.id);
    return { left, leftChild, right, rightChild };
  }

  /** Every live department whose path disagrees with the parent it points at. */
  async function inconsistentPaths(): Promise<string[]> {
    const rows = await owner.department.findMany({
      where: { tenantId: ACME, deletedAt: null },
      select: { id: true, parentId: true, path: true },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    return rows
      .filter((row) => {
        const parent = row.parentId === null ? null : byId.get(row.parentId);
        return row.path !== pathFor(parent?.path ?? null, row.id);
      })
      .map((row) => row.id);
  }

  async function pathOf(id: string): Promise<string> {
    return (await owner.department.findUniqueOrThrow({ where: { id }, select: { path: true } }))
      .path;
  }

  /**
   * Whether a second session can take a department row for itself without waiting.
   *
   * `owner` is a separate `PrismaClient` and so a separate backend, which is the only way to ask
   * whether a lock is held: a probe on the same connection would be inside the transaction holding
   * it. `NOWAIT` rather than a wait with a deadline — the question is whether the row is held
   * *now*. `55P03` is PostgreSQL's "could not obtain lock", and here it is the answer.
   */
  async function probe(departmentId: string): Promise<'LOCKED' | 'FREE'> {
    try {
      await owner.$queryRawUnsafe(
        'SELECT id FROM department WHERE id = $1::uuid FOR UPDATE NOWAIT',
        departmentId,
      );
      return 'FREE';
    } catch (error) {
      if (/55P03|could not obtain lock/i.test(String(error))) {
        return 'LOCKED';
      }
      throw error;
    }
  }

  /** Both moves at once, with nothing holding either: the fix is what has to order them. */
  async function bothAtOnce(
    first: { id: string; parentId: string; version: number },
    second: { id: string; parentId: string; version: number },
  ): Promise<{ moved: number; refusals: unknown[] }> {
    const outcomes = await Promise.allSettled([
      asTenant(ACME, () => service.moveDepartment(first.id, first.parentId, first.version)),
      asTenant(ACME, () => service.moveDepartment(second.id, second.parentId, second.version)),
    ]);
    return {
      moved: outcomes.filter((outcome) => outcome.status === 'fulfilled').length,
      refusals: outcomes.flatMap((outcome) =>
        outcome.status === 'rejected' ? [outcome.reason as unknown] : [],
      ),
    };
  }

  it('moves one root under another when nothing contends', async () => {
    // The control. Without it every assertion below passes on a service that moves nothing, and
    // it is also what says the lock did not turn an ordinary reorganisation into a refusal.
    const { left, right } = await twoSubtrees();
    const moved = await asTenant(ACME, () =>
      service.moveDepartment(left.id, right.id, left.version),
    );

    expect(moved.path).toBe(pathFor(right.path, left.id));
    expect(await inconsistentPaths()).toEqual([]);
  });

  it('lets one of two crossing moves through and refuses the other', async () => {
    const { left, right } = await twoSubtrees();

    const { moved, refusals } = await bothAtOnce(
      { id: left.id, parentId: right.id, version: left.version },
      { id: right.id, parentId: left.id, version: right.version },
    );

    // Symmetric, so it does not matter which one arrives second: the loser is told what a single
    // administrator is told for the same request.
    expect(moved).toBe(1);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({
      code: 'VALIDATION_FAILED',
      fieldErrors: [{ field: 'parentId', message: 'PARENT_IS_DESCENDANT' }],
    });

    // One inside the other, and only one way round: whichever went first, exactly one of the two
    // now carries the other in its path, so neither set of members holds the other department as
    // an ACL subject in both directions.
    const [leftPath, rightPath] = [await pathOf(left.id), await pathOf(right.id)];
    expect(
      Number(idsInPath(leftPath).includes(right.id)) +
        Number(idsInPath(rightPath).includes(left.id)),
    ).toBe(1);
    expect(await inconsistentPaths()).toEqual([]);
  });

  it('refuses the crossing move when neither department is a root', async () => {
    /*
     * One level down, where two roots are not the whole of it: each root moves under the *other's*
     * child. The two sets meet because each move's destination lies inside the other's subtree —
     * which is exactly the condition a cycle needs — so holding the subtree and the destination is
     * enough for them to find each other.
     */
    const { left, leftChild, right, rightChild } = await twoSubtrees();

    const { moved, refusals } = await bothAtOnce(
      { id: left.id, parentId: rightChild.id, version: left.version },
      { id: right.id, parentId: leftChild.id, version: right.version },
    );

    expect(moved).toBe(1);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({
      code: 'VALIDATION_FAILED',
      fieldErrors: [{ field: 'parentId', message: 'PARENT_IS_DESCENDANT' }],
    });
    expect(
      Number(idsInPath(await pathOf(left.id)).includes(right.id)) +
        Number(idsInPath(await pathOf(right.id)).includes(left.id)),
    ).toBe(1);
    expect(await inconsistentPaths()).toEqual([]);
  });

  it('holds the subtree it will rewrite and the parent it is moving to', async () => {
    const { left, leftChild, right, rightChild } = await twoSubtrees();
    const bystander = await department(
      fixture(ACME).entityId,
      `BY${String(Date.now()).slice(-6)}`,
      null,
    );
    const outside = await department(elsewhereEntityId, `OU${String(Date.now()).slice(-6)}`, null);

    const parking = new ParkedMove(stamps);
    parking.target = left.id;
    const racing = new ScopeAdminService(
      parking,
      outbox,
      realAclResolver({ clock, unitOfWork }),
      writer,
    );

    let reached: () => void = () => undefined;
    const atTheWrite = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let admit: () => void = () => undefined;
    parking.admit = new Promise<void>((resolve) => {
      admit = resolve;
    });
    parking.reached = reached;

    // Moved under the *child* of the other root, so the destination has a parent of its own — a
    // row the move reads through and must leave alone.
    const moving = asTenant(ACME, () =>
      racing.moveDepartment(left.id, rightChild.id, left.version),
    );
    await atTheWrite;

    // The node, everything under it — which is every row this move goes on to write — and the
    // parent it is moving to, which the comparison read but will not write.
    expect(await probe(left.id)).toBe('LOCKED');
    expect(await probe(leftChild.id)).toBe('LOCKED');
    expect(await probe(rightChild.id)).toBe('LOCKED');

    /*
     * And the probes that must come back free, which are what say this is a lock and not a table.
     *
     * `right` is the destination's own parent: the move reads it only through the destination's
     * path, never writes it, and cannot make it a descendant of anything, so it is not held. The
     * bystander shares the entity and the outsider does not, and neither is anywhere this move
     * reaches.
     */
    expect(await probe(right.id)).toBe('FREE');
    expect(await probe(bystander.id)).toBe('FREE');
    expect(await probe(outside.id)).toBe('FREE');

    admit();
    await moving;

    expect(await probe(left.id)).toBe('FREE');
    expect(await inconsistentPaths()).toEqual([]);
  });

  /**
   * A department planted with an identifier and a path this suite chooses.
   *
   * The scope tree never lets a caller choose either — the path "is the only field a client can
   * never send" — so the two cases below reach past the service to the table, exactly as
   * `organization.integration.spec.ts` does for its own prefix case. What is under test is still
   * the production statement: the move that reads these rows goes through `ScopeAdminService`.
   */
  async function plant(input: {
    id: string;
    code: string;
    entityId: string;
    parentId: string | null;
    path: string;
  }): Promise<void> {
    await owner.department.create({
      data: {
        id: input.id,
        tenantId: ACME,
        entityId: input.entityId,
        code: input.code,
        name: input.code,
        ...(input.parentId !== null && { parentId: input.parentId }),
        path: input.path,
        updatedAt: new Date(now),
      },
    });
  }

  /**
   * Identifiers whose *order* this suite fixes, and whose uniqueness survives a second run.
   *
   * The leading group decides where each row sorts; the trailing group is drawn fresh, because
   * `id` is unique across the whole table and a literal would collide the next time the suite runs
   * against the same database.
   */
  function orderedIds(): { a: string; b: string; node: string; destination: string } {
    const suffix = uuidv7().replaceAll('-', '').slice(-12);
    const tail = `0000-4000-8000-${suffix}`;
    return {
      a: `00000000-${tail}`,
      b: `00000001-${tail}`,
      node: `88888888-${tail}`,
      destination: `ffffffff-${tail}`,
    };
  }

  /**
   * Waits until some backend is blocked behind another transaction.
   *
   * The database's own view of who is waiting, polled — not a delay picked to be long enough.
   * This returns the moment the move is genuinely parked and never before.
   *
   * Narrowed to a backend running *this* statement and blocked by somebody, rather than to any
   * ungranted lock anywhere: a suite that happened to hold a row elsewhere would otherwise satisfy
   * the condition before the move had reached its lock at all.
   */
  async function waitUntilBlocked(): Promise<void> {
    for (let attempt = 0; attempt < 20_000; attempt += 1) {
      const [row] = await owner.$queryRaw<{ waiting: bigint }[]>`
        SELECT count(*) AS waiting
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND cardinality(pg_blocking_pids(pid)) > 0
          AND query LIKE '%FROM department%FOR UPDATE%'`;
      if (Number(row?.waiting ?? 0) > 0) {
        return;
      }
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
    }
    throw new Error('The move never blocked on the held row.');
  }

  it('takes the rows it locks in identifier order', async () => {
    /*
     * Why `ORDER BY id` is load-bearing, made observable — Slice 112.
     *
     * The clause is what stops two moves deadlocking: every move acquires its whole set in one
     * total order, so the wait-for graph between them cannot contain a cycle. Nothing about a
     * *single* move's outcome shows that, and a second mover cannot be barriered into place —
     * it would be held by the very lock under test. So this asserts the ordering directly: while
     * a move is blocked on one row of its set, every row below that one must already be held and
     * every row above it must not.
     *
     * The four rows are planted with identifiers whose order is fixed and deliberately disagrees
     * with both of the orders the statement would otherwise be served in — the order they were
     * written (`node`, `destination`, `a`, `b`) and the order of their paths (`node`, `a`, `b`,
     * `destination`, because a child sorts directly under its parent). In identifier order the
     * node is third, so a move blocked on it has taken its two children and not yet reached its
     * destination. Under either of the other orders the node comes first and nothing else is held.
     */
    const { entityId } = fixture(ACME);
    const id = orderedIds();
    const suffix = String(Date.now()).slice(-6);

    // Written first, so "the order they were written" puts the node ahead of everything else.
    await plant({ id: id.node, code: `ON${suffix}`, entityId, parentId: null, path: id.node });
    await plant({
      id: id.destination,
      code: `OD${suffix}`,
      entityId,
      parentId: null,
      path: id.destination,
    });
    await plant({
      id: id.a,
      code: `OA${suffix}`,
      entityId,
      parentId: id.node,
      path: pathFor(id.node, id.a),
    });
    await plant({
      id: id.b,
      code: `OB${suffix}`,
      entityId,
      parentId: id.node,
      path: pathFor(id.node, id.b),
    });

    // A second session holds the node — the third row the move must take — and nothing else.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let taken: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => {
      taken = resolve;
    });
    const holder = owner.$transaction(async (tx) => {
      await tx.$queryRawUnsafe('SELECT id FROM department WHERE id = $1::uuid FOR UPDATE', id.node);
      taken();
      await held;
    });
    await holding;

    const moving = asTenant(ACME, () => service.moveDepartment(id.node, id.destination, 1));
    await waitUntilBlocked();

    // Below the row it is blocked on: already taken. Above it: not yet reached.
    expect(await probe(id.a)).toBe('LOCKED');
    expect(await probe(id.b)).toBe('LOCKED');
    expect(await probe(id.destination)).toBe('FREE');

    release();
    await holder;
    const moved = await moving;

    expect(moved.path).toBe(pathFor(id.destination, id.node));
    expect(await inconsistentPaths()).toEqual([]);
  });

  it('does not lock a department whose path merely shares a prefix', async () => {
    /*
     * Why the separator in `|| '.%'` is load-bearing — Slice 112.
     *
     * `organization.integration.spec.ts` already plants a department whose path is another's
     * identifier with the next one appended and no dot between them, and says why: "The separator
     * is the whole defence. A path stored without it would make any department whose identifier
     * merely begins with another's a member of its subtree." That case pins the read side. This
     * one pins the lock, which asks the same question of the same column and would otherwise
     * answer it differently: without the dot the move would hold a row that is not in its subtree,
     * is not its destination, and that it will never write.
     */
    const { entityId } = fixture(ACME);
    const suffix = String(Date.now()).slice(-6);
    const node = await department(entityId, `PN${suffix}`, null);
    const impostorId = uuidv7();

    try {
      await plant({
        id: impostorId,
        code: `PI${suffix}`,
        entityId,
        parentId: null,
        // Deliberately malformed: the same characters as a child of the node, without the dot.
        path: `${node.path}${impostorId}`,
      });

      const parking = new ParkedMove(stamps);
      parking.target = node.id;
      const racing = new ScopeAdminService(
        parking,
        outbox,
        realAclResolver({ clock, unitOfWork }),
        writer,
      );

      let reached: () => void = () => undefined;
      const atTheWrite = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let admit: () => void = () => undefined;
      parking.admit = new Promise<void>((resolve) => {
        admit = resolve;
      });
      parking.reached = reached;

      const destination = await department(entityId, `PD${suffix}`, null);
      const moving = asTenant(ACME, () =>
        racing.moveDepartment(node.id, destination.id, node.version),
      );
      await atTheWrite;

      expect(await probe(node.id)).toBe('LOCKED');
      expect(await probe(destination.id)).toBe('LOCKED');
      // The whole of the case: a shared prefix is not a subtree.
      expect(await probe(impostorId)).toBe('FREE');

      admit();
      await moving;
    } finally {
      await owner.department.delete({ where: { id: impostorId } });
    }

    expect(await inconsistentPaths()).toEqual([]);
  });
});
