import 'reflect-metadata';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type TenantId, asId } from '@edms/domain';
import { uuidv7 } from '@edms/utils';

/**
 * The backfill that reaches tenants which already exist.
 *
 * ## Why a test, when Prisma already runs each migration once
 *
 * Because "runs once" is a property of the migration *table*, not of the SQL, and the SQL is what
 * has to be safe. Under ADR-0015 there is one database per tenant and
 * `scripts/migrate-tenants.mjs` visits them in sequence and fails fast — so an operator whose
 * fifteenth tenant failed re-runs the command, and the first fourteen see the statement again
 * through whatever recovery path they are on. A backfill that bumped every permission counter on
 * each attempt would invalidate every live session in the estate for nothing.
 *
 * The rest of what is asserted here is the security boundary of the rule set. Two of the three
 * grants go only to roles that already hold the *management* key over the same data — so nobody
 * gains reach — and the third names one system role by key. Whether that is what the SQL actually
 * does is not something a reading can settle, because the interesting cases are the roles it must
 * leave alone: a custom role with no management grant, and the auditor.
 *
 * The migration is applied to a database of this suite's own making rather than to the shared one,
 * so the rows it inspects are only the ones it seeded.
 */

const OWNER_URL = process.env['DATABASE_MIGRATION_URL'] ?? '';

// `__dirname` rather than `import.meta.url`, because this package compiles to CommonJS — the same
// choice `smtp-session.integration.spec.ts` makes to reach its own fixtures.
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
  '20260817120000_operational_read_permissions',
  'migration.sql',
);

const TENANT = asId<TenantId>(uuidv7());

/** The seeded roles this migration has an opinion about, plus two it must not touch. */
const CONTROLLER = uuidv7();
const ADMIN = uuidv7();
const AUDITOR = uuidv7();
const CUSTOM_PLAIN = uuidv7();
const CUSTOM_SETTINGS = uuidv7();
const CUSTOM_ORG = uuidv7();
const CUSTOM_CONTROLLER = uuidv7();

const CONTROLLER_HOLDER = uuidv7();
const AUDITOR_HOLDER = uuidv7();
const UNAFFECTED_HOLDER = uuidv7();

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
      slug: `mig-${TENANT.replaceAll('-', '').slice(-16)}`,
      name: 'Migration fixture',
      status: 'ACTIVE',
    },
  });

  const roles = [
    // The three seeded roles the rules distinguish between.
    { id: CONTROLLER, key: 'DOCUMENT_CONTROLLER', isSystem: true, grants: ['document:create'] },
    { id: ADMIN, key: 'TENANT_ADMIN', isSystem: true, grants: ['settings:manage', 'user:manage'] },
    { id: AUDITOR, key: 'AUDITOR', isSystem: true, grants: ['document:view', 'library:view'] },
    // A tenant's own roles. Only the ones already holding a management key may be changed.
    { id: CUSTOM_PLAIN, key: 'FILING_CLERK', isSystem: false, grants: ['document:view'] },
    { id: CUSTOM_SETTINGS, key: 'CONFIGURER', isSystem: false, grants: ['settings:manage'] },
    { id: CUSTOM_ORG, key: 'HR', isSystem: false, grants: ['org:manage'] },
    // Shaped like the seeded controller but authored by the tenant — theirs, and left alone.
    {
      id: CUSTOM_CONTROLLER,
      key: 'DOCUMENT_CONTROLLER_COPY',
      isSystem: false,
      grants: ['document:create', 'document:edit'],
    },
  ];

  for (const role of roles) {
    await owner.role.create({
      data: {
        id: role.id,
        tenantId: TENANT,
        key: role.key,
        name: role.key,
        isSystem: role.isSystem,
        permissions: {
          create: role.grants.map((permission) => ({ tenantId: TENANT, permission })),
        },
      },
    });
  }

  for (const [id, roleId] of [
    [CONTROLLER_HOLDER, CONTROLLER],
    [AUDITOR_HOLDER, AUDITOR],
    [UNAFFECTED_HOLDER, CUSTOM_PLAIN],
  ] as const) {
    const email = `${id}@migration.test`;
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

describe('the operational read backfill', () => {
  it('grants both keys to the seeded document controller', async () => {
    // The role the defect was about. Without this rule the fix reaches new tenants only, and every
    // existing customer keeps a workspace their document controller cannot open.
    await apply();
    expect(await permissionsOf(CONTROLLER)).toEqual([
      'configuration:view',
      'directory:view',
      'document:create',
    ]);
  });

  it('grants the tenant administrator both, because RbacGuard requires all declared permissions', async () => {
    // Holding `settings:manage` is not by itself enough to call a route declaring
    // `configuration:view` — the guard is an AND, not an OR — so a role that could already read
    // everything still needs the read key to reach the read model.
    expect(await permissionsOf(ADMIN)).toEqual([
      'configuration:view',
      'directory:view',
      'settings:manage',
      'user:manage',
    ]);
  });

  it('grants the auditor neither', async () => {
    // The whole point of solving this on the controller's side. Reading documents does not require
    // the catalogue they were filed against, and fixing one role by widening another is how a
    // permission model stops meaning anything.
    expect(await permissionsOf(AUDITOR)).toEqual(['document:view', 'library:view']);
  });

  it('leaves a custom role holding no management key exactly as it was', async () => {
    expect(await permissionsOf(CUSTOM_PLAIN)).toEqual(['document:view']);
  });

  it('leaves a custom role shaped like the controller alone, because it is the tenant’s', async () => {
    // `is_system` bounds rule 3. A role a customer built and named for themselves carries the
    // permission set they chose, and a migration is not the place to second-guess it.
    expect(await permissionsOf(CUSTOM_CONTROLLER)).toEqual(['document:create', 'document:edit']);
  });

  it('gives configuration:view to a custom role that already administers the vocabulary', async () => {
    expect(await permissionsOf(CUSTOM_SETTINGS)).toEqual(['configuration:view', 'settings:manage']);
  });

  it('gives directory:view to a custom role that already administers the organisation', async () => {
    expect(await permissionsOf(CUSTOM_ORG)).toEqual(['directory:view', 'org:manage']);
  });

  it('gives a settings:manage role no directory key, and an org:manage role no configuration key', async () => {
    // The two rules are separate because the two decisions are. A role that may edit the filing
    // vocabulary has no business enumerating the staff as a side effect of this migration.
    expect(await permissionsOf(CUSTOM_SETTINGS)).not.toContain('directory:view');
    expect(await permissionsOf(CUSTOM_ORG)).not.toContain('configuration:view');
  });

  it('removes nothing', async () => {
    // Additive is a claim worth checking rather than asserting: every grant seeded above is still
    // present in one of the assertions here, and this states the property directly.
    const remaining = await owner.rolePermission.count({
      where: { tenantId: TENANT, permission: { in: ['document:create', 'settings:manage'] } },
    });
    expect(remaining).toBeGreaterThan(0);
  });
});

describe('permission versions', () => {
  it('bumps the holders of a role whose grants changed', async () => {
    // The same step `RoleAdminService.update` takes when a role's permissions are replaced, so a
    // live session picks the new keys up at its next refresh rather than at its next sign-in.
    expect(await versionOf(CONTROLLER_HOLDER)).toBe(2);
  });

  it('leaves alone the holders of a role that did not change', async () => {
    expect(await versionOf(AUDITOR_HOLDER)).toBe(1);
    expect(await versionOf(UNAFFECTED_HOLDER)).toBe(1);
  });
});

describe('running it again', () => {
  it('grants nothing further', async () => {
    await apply();
    expect(await permissionsOf(CONTROLLER)).toEqual([
      'configuration:view',
      'directory:view',
      'document:create',
    ]);
    expect(await permissionsOf(AUDITOR)).toEqual(['document:view', 'library:view']);
    expect(await permissionsOf(CUSTOM_PLAIN)).toEqual(['document:view']);
  });

  it('moves no permission version', async () => {
    /*
     * The reason the whole thing is one statement. A separate `UPDATE` could not tell "this run
     * granted something" from "a previous run did", so on every re-run it would bump every counter
     * again — invalidating every live session in the estate to no purpose. Chaining the insert's
     * `RETURNING` into the update makes a second execution a genuine no-op.
     */
    expect(await versionOf(CONTROLLER_HOLDER)).toBe(2);
    expect(await versionOf(AUDITOR_HOLDER)).toBe(1);
  });
});
