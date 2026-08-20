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
/** The tenant's own, shaped like the controller. Theirs. */
const CUSTOM_CONTROLLER = uuidv7();

const CONTROLLER_HOLDER = uuidv7();
const AUDITOR_HOLDER = uuidv7();
const READER_HOLDER = uuidv7();
const CUSTOM_HOLDER = uuidv7();

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
     * What excludes it is the **key**, and that is worth stating rather than leaving to the reader,
     * because the `is_system = true` clause beside it looks like the thing doing the work and is
     * not. `20260803162912_identity` creates `uq_role_tenant_key` — a plain unique index on
     * `(tenant_id, key)`, unconditional, so soft-deleted rows occupy it too — which means the two
     * seeded keys can only ever name the product's own rows. Deleting the `is_system` clause
     * therefore fails nothing here, and no fixture in this file can make it fail: it is
     * belt-and-braces carried over from `20260817120000_operational_read_permissions`, where the
     * third rule needed it because a *shape* rather than a key was being matched.
     */
    expect(await permissionsOf(CUSTOM_CONTROLLER)).toEqual(['document:create', 'retention:manage']);
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
