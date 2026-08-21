import 'reflect-metadata';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type TenantId, asId } from '@edms/domain';
import { uuidv7 } from '@edms/utils';

/**
 * The backfill that closes the two holes in `08-permission-model.md` §6's only all-column row.
 *
 * ## Why a test, when Prisma already runs each migration once
 *
 * Because "runs once" is a property of the migration *table*, not of the SQL, and the SQL is what
 * has to be safe. Under ADR-0015 there is one database per tenant and
 * `scripts/migrate-tenants.mjs` visits them in sequence and fails fast — so an operator whose
 * fifteenth tenant failed re-runs the command, and the first fourteen see the statement again. A
 * backfill that bumped every permission counter on each attempt would invalidate every live session
 * in the estate for nothing. `operational-read-migration.integration.spec.ts` makes the same point
 * about its own statement, and the two are separate files because they are separate statements with
 * separate rule sets.
 *
 * ## What is actually interesting here
 *
 * Not that the two roles gain the key — that much a reading settles. The cases a reading cannot
 * settle are the ones the statement must leave alone: a role a tenant built for itself that happens
 * to be shaped like the controller, a seeded role that already holds the key (whose holders must
 * *not* have their sessions invalidated for a grant that did not change), and a deleted role.
 *
 * The migration is applied to a database of this suite's own making rather than to the shared one,
 * so the rows it inspects are only the ones it seeded.
 */

const OWNER_URL = process.env['DATABASE_MIGRATION_URL'] ?? '';

// `__dirname` rather than `import.meta.url`, because this package compiles to CommonJS — the same
// choice its sibling migration spec makes to reach its own fixture.
const MIGRATION = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
  'prisma',
  'migrations',
  '20260820223000_seeded_roles_own_inbox',
  'migration.sql',
);

const TENANT = asId<TenantId>(uuidv7());

const CONTROLLER = uuidv7();
const AUDITOR = uuidv7();
/** Already holds it, so nothing about this role or its holder may move. */
const READER = uuidv7();
/** Seeded, keyed, and withdrawn. Restoring a role restores what it had. */
const DELETED_AUDITOR = uuidv7();
/**
 * A second tenant, whose seeded `AUDITOR` is withdrawn and whose own live `AUDITOR` replaced it.
 *
 * `uq_role_tenant_key` is partial (`WHERE "deleted_at" IS NULL`), so it reserves a key only among
 * live roles, and `roleKeyTaken` filters the same way on purpose: a role in the recycle bin does
 * not hold its name hostage. A customer may therefore withdraw a seeded role and take its key.
 *
 * It needs a tenant of its own precisely *because* the index works: the tenant above keeps its
 * seeded `AUDITOR` live, and a second live `AUDITOR` beside it is the one thing PostgreSQL refuses.
 * The migration's `WHERE` is not tenant-scoped — it sweeps the database — so both tenants are in
 * range of one statement, and this is the only fixture for which `is_system = true` does any work.
 */
const OTHER_TENANT = asId<TenantId>(uuidv7());
const OTHER_DELETED_AUDITOR = uuidv7();
const CUSTOM_KEYED_AUDITOR = uuidv7();
/** The tenant's own, shaped like the controller. Theirs. */
const CUSTOM_CONTROLLER = uuidv7();

const CONTROLLER_HOLDER = uuidv7();
const AUDITOR_HOLDER = uuidv7();
const READER_HOLDER = uuidv7();
const CUSTOM_HOLDER = uuidv7();
const CUSTOM_KEYED_HOLDER = uuidv7();

const INBOX = 'notification:manage';

let owner: PrismaClient;

async function apply(): Promise<void> {
  await owner.$executeRawUnsafe(readFileSync(MIGRATION, 'utf8'));
}

async function permissionsOf(roleId: string): Promise<readonly string[]> {
  const rows = await owner.rolePermission.findMany({
    where: { roleId },
    select: { permission: true },
  });
  return rows.map((row) => row.permission).sort();
}

async function versionOf(userId: string): Promise<number> {
  const row = await owner.user.findUniqueOrThrow({
    where: { id: userId },
    select: { permissionVersion: true },
  });
  return row.permissionVersion;
}

beforeAll(async () => {
  if (!OWNER_URL) {
    throw new Error('DATABASE_MIGRATION_URL must be set.');
  }
  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });

  await owner.tenant.create({
    data: {
      id: TENANT,
      slug: `inbox-${TENANT.replaceAll('-', '').slice(-16)}`,
      name: 'Inbox migration fixture',
      status: 'ACTIVE',
    },
  });

  const roles = [
    // The two the statement is about: seeded, keyed, and missing the row.
    {
      id: CONTROLLER,
      key: 'DOCUMENT_CONTROLLER',
      isSystem: true,
      deleted: false,
      grants: ['document:create', 'retention:manage', 'audit:view'],
    },
    {
      id: AUDITOR,
      key: 'AUDITOR',
      isSystem: true,
      deleted: false,
      grants: ['document:view', 'audit:view'],
    },
    // Seeded and already holding it. The `ON CONFLICT` path, and the one whose holder must not be
    // bumped: a session invalidated for a grant that did not change is a cost paid for nothing.
    { id: READER, key: 'READER', isSystem: true, deleted: false, grants: [INBOX] },
    // Withdrawn. Restoring a role restores the permissions it had.
    {
      id: DELETED_AUDITOR,
      key: 'AUDITOR',
      isSystem: true,
      deleted: true,
      grants: ['document:view'],
    },
    // Shaped like the controller and authored by the tenant.
    {
      id: CUSTOM_CONTROLLER,
      key: 'DOCUMENT_CONTROLLER_COPY',
      isSystem: false,
      deleted: false,
      grants: ['document:create', 'retention:manage'],
    },
  ];

  for (const role of roles) {
    await owner.role.create({
      data: {
        id: role.id,
        tenantId: TENANT,
        key: role.key,
        name: role.id,
        isSystem: role.isSystem,
        ...(role.deleted ? { deletedAt: new Date('2026-01-01T00:00:00.000Z') } : {}),
        permissions: {
          create: role.grants.map((permission) => ({ tenantId: TENANT, permission })),
        },
      },
    });
  }

  for (const [id, roleId] of [
    [CONTROLLER_HOLDER, CONTROLLER],
    [AUDITOR_HOLDER, AUDITOR],
    [READER_HOLDER, READER],
    [CUSTOM_HOLDER, CUSTOM_CONTROLLER],
  ] as const) {
    const email = `${id}@inbox-migration.test`;
    await owner.user.create({
      data: {
        id,
        tenantId: TENANT,
        email,
        emailNormalized: email,
        displayName: id,
        status: 'ACTIVE',
        roles: { create: [{ tenantId: TENANT, roleId }] },
      },
    });
  }

  // The second tenant: its seeded `AUDITOR` withdrawn, its own `AUDITOR` live in the key that
  // freed. Only the partial index makes this pair storable, and only `is_system` keeps the
  // statement off the customer's row.
  await owner.tenant.create({
    data: {
      id: OTHER_TENANT,
      slug: `inbox2-${OTHER_TENANT.replaceAll('-', '').slice(-16)}`,
      name: 'Inbox migration fixture — key reuse',
      status: 'ACTIVE',
    },
  });

  for (const role of [
    {
      id: OTHER_DELETED_AUDITOR,
      isSystem: true,
      deletedAt: new Date('2026-01-01T00:00:00.000Z'),
      grants: ['document:view'],
    },
    { id: CUSTOM_KEYED_AUDITOR, isSystem: false, deletedAt: null, grants: ['report:view'] },
  ]) {
    await owner.role.create({
      data: {
        id: role.id,
        tenantId: OTHER_TENANT,
        key: 'AUDITOR',
        name: role.id,
        isSystem: role.isSystem,
        ...(role.deletedAt === null ? {} : { deletedAt: role.deletedAt }),
        permissions: {
          create: role.grants.map((permission) => ({ tenantId: OTHER_TENANT, permission })),
        },
      },
    });
  }

  const email = `${CUSTOM_KEYED_HOLDER}@inbox-migration.test`;
  await owner.user.create({
    data: {
      id: CUSTOM_KEYED_HOLDER,
      tenantId: OTHER_TENANT,
      email,
      emailNormalized: email,
      displayName: CUSTOM_KEYED_HOLDER,
      status: 'ACTIVE',
      roles: { create: [{ tenantId: OTHER_TENANT, roleId: CUSTOM_KEYED_AUDITOR }] },
    },
  });
}, 120_000);

afterAll(async () => {
  await owner?.$disconnect();
});

describe('the seeded inbox backfill', () => {
  it('gives the document controller the inbox it was already being sent rows in', async () => {
    // `retentionDue` resolves recipients as `holdersOfPermission('retention:manage')`, which this
    // role holds — so before this ran the product wrote it retention reviews and then refused it
    // `/v1/notifications`.
    await apply();
    expect(await permissionsOf(CONTROLLER)).toEqual([
      'audit:view',
      'document:create',
      INBOX,
      'retention:manage',
    ]);
  });

  it('gives the auditor the inbox the chain-broken alert lands in', async () => {
    // `chainBroken` resolves recipients as `holdersOfPermission('audit:view')` — this row's own
    // key. An auditor who cannot open the inbox the audit alert is delivered to is the defect.
    expect(await permissionsOf(AUDITOR)).toEqual(['audit:view', 'document:view', INBOX]);
  });

  it('adds nothing to a seeded role that already held it', async () => {
    expect(await permissionsOf(READER)).toEqual([INBOX]);
  });

  it('leaves a withdrawn role withdrawn', async () => {
    // Not "the auditor gets it wherever the key appears": restoring a role restores what it had,
    // and a deleted role is not a statement anybody is relying on.
    expect(await permissionsOf(DELETED_AUDITOR)).toEqual(['document:view']);
  });

  it('leaves a custom role shaped like the controller alone, because it is the tenant’s', async () => {
    /*
     * A role a customer built and named for themselves carries the permission set they chose —
     * even for a row the product grants to all of its own.
     *
     * What excludes *this* one is the key: `DOCUMENT_CONTROLLER_COPY` is not `DOCUMENT_CONTROLLER`.
     * The `is_system` clause is exercised by `CUSTOM_KEYED_AUDITOR` below, which takes a seeded key
     * a withdrawn role has freed.
     */
    expect(await permissionsOf(CUSTOM_CONTROLLER)).toEqual(['document:create', 'retention:manage']);
  });

  it('leaves a tenant-authored role alone even when it carries a seeded key', async () => {
    /*
     * The assertion `is_system` exists for, and — corrected in Slice 22 — the one this file
     * previously said could not be written.
     *
     * It said so on a false premise, and the migration's own header still carries it: that
     * `20260803162912_identity` creates `uq_role_tenant_key` as a plain unconditional unique index,
     * so the two seeded keys could only ever name the product's own rows and `is_system = true` was
     * belt-and-braces. It creates it as a **partial** index:
     *
     *     CREATE UNIQUE INDEX "uq_role_tenant_key" ON "role" ("tenant_id", "key")
     *       WHERE "deleted_at" IS NULL;
     *
     * so a key is reserved only among *live* roles — `roleKeyTaken` filters the same way on
     * purpose, because a role in the recycle bin does not hold its name hostage. A customer may
     * therefore withdraw a seeded role and create their own under its key, and in that state
     * `key IN ('DOCUMENT_CONTROLLER', 'AUDITOR')` alone reaches a role they authored and chose the
     * permissions for. `is_system` is the only clause between the statement and that row.
     *
     * **The correction lives here rather than in the migration**, deliberately. That file has been
     * applied, and an applied migration is immutable: `scripts/migrate-tenants.mjs` runs
     * `prisma migrate deploy` across one database per tenant in sequence and fails fast, so a
     * checksum this repository edited after the fact is the last thing to introduce there. Prisma
     * 6.19 happens not to verify the checksum of an already-applied migration on `deploy` or on
     * `status` — measured, not assumed — but the deprecation warning it prints on every run is
     * about Prisma 7, and "the current version tolerates it" is not a property to build on.
     *
     * So the migration keeps a stale sentence and this keeps the truth, with the fixture below
     * making the clause it describes fail loudly if anybody acts on that sentence.
     */
    expect(await permissionsOf(CUSTOM_KEYED_AUDITOR)).toEqual(['report:view']);
    // And the withdrawn seeded row beside it is left where it is, by `deleted_at IS NULL`.
    expect(await permissionsOf(OTHER_DELETED_AUDITOR)).toEqual(['document:view']);
  });

  it('removes nothing', async () => {
    // Additive is a claim worth checking rather than asserting.
    const remaining = await owner.rolePermission.count({
      where: { tenantId: TENANT, permission: { in: ['audit:view', 'retention:manage'] } },
    });
    expect(remaining).toBe(4);
  });
});

describe('permission versions', () => {
  it('bumps the holders of the two roles whose grants changed', async () => {
    // The same step `RoleAdminService.update` takes when a role's permissions are replaced, so a
    // live session picks the new key up at its next refresh rather than at its next sign-in.
    expect(await versionOf(CONTROLLER_HOLDER)).toBe(2);
    expect(await versionOf(AUDITOR_HOLDER)).toBe(2);
  });

  it('leaves alone the holders of roles that did not change', async () => {
    // The reader already held it and the custom role was never in scope. Invalidating either
    // session would be a cost paid for a grant that did not move.
    expect(await versionOf(READER_HOLDER)).toBe(1);
    expect(await versionOf(CUSTOM_HOLDER)).toBe(1);
    expect(await versionOf(CUSTOM_KEYED_HOLDER)).toBe(1);
  });
});

describe('running it again', () => {
  it('grants nothing further', async () => {
    await apply();
    expect(await permissionsOf(CONTROLLER)).toEqual([
      'audit:view',
      'document:create',
      INBOX,
      'retention:manage',
    ]);
    expect(await permissionsOf(AUDITOR)).toEqual(['audit:view', 'document:view', INBOX]);
    expect(await permissionsOf(CUSTOM_CONTROLLER)).toEqual(['document:create', 'retention:manage']);
    expect(await permissionsOf(CUSTOM_KEYED_AUDITOR)).toEqual(['report:view']);
  });

  it('moves no permission version', async () => {
    /*
     * The reason the whole thing is one statement. A separate `UPDATE` could not tell "this run
     * granted something" from "a previous run did", so on every re-run it would bump every counter
     * again — invalidating every live session in the estate to no purpose.
     */
    expect(await versionOf(CONTROLLER_HOLDER)).toBe(2);
    expect(await versionOf(AUDITOR_HOLDER)).toBe(2);
    expect(await versionOf(READER_HOLDER)).toBe(1);
  });
});
