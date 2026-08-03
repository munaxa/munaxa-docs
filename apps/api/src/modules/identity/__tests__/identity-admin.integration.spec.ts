import 'reflect-metadata';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Permission, SystemRole, type TenantId, type UserId } from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import type { AppConfig } from '../../../core/config/configuration';
import type { Logger } from '../../../core/observability/logger';
import { PrismaService } from '../../../core/prisma/prisma.service';
import { PrismaUnitOfWork } from '../../../core/prisma/unit-of-work';
import { type RequestContext, runWithContext } from '../../../core/tenancy/tenant-context';
import { realWriteStack } from '../../../testing/real-collaborators';
import { RoleAdminService } from '../application/role-admin.service';
import { UserAdminService } from '../application/user-admin.service';
import { PrismaIdentityAdminRepository } from '../infrastructure/prisma-identity-admin.repository';
import { PrismaProvisioningRepository } from '../infrastructure/prisma-provisioning.repository';
import { ProvisioningService } from '../application/provisioning.service';
import { ScryptPasswordHasher } from '../infrastructure/scrypt-password-hasher';

/**
 * Administering people and access, against a real PostgreSQL.
 *
 * What only a database can answer here is mostly about *side effects that must be atomic with the
 * change*: that changing a role's permissions bumps every holder's `permission_version` in the same
 * transaction, that setting a password revokes every session family, and that the partial unique
 * index really does free an email address on delete and refuse it on restore.
 */

const OWNER_URL = process.env['DATABASE_MIGRATION_URL'] ?? '';
const APP_URL = process.env['DATABASE_URL'] ?? '';

const config = { env: 'test', database: { url: APP_URL, poolSize: 10 } } as unknown as AppConfig;
const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

/** Frozen: nothing here depends on time advancing, and a fixed instant keeps stamps assertable. */
const FIXED_NOW = new Date('2026-06-01T09:00:00.000Z');
const clock = { now: () => new Date(FIXED_NOW), timestamp: () => 0, elapsedMs: () => 0 };

const prisma = new PrismaService(config, logger);
const unitOfWork = new PrismaUnitOfWork(prisma);
const { stamps, writer, audit } = realWriteStack(clock, unitOfWork);
const passwords = new ScryptPasswordHasher();
const repository = new PrismaIdentityAdminRepository(stamps);
const users = new UserAdminService(repository, passwords, writer);
const roles = new RoleAdminService(repository, writer);
const provisioning = new ProvisioningService(
  new PrismaProvisioningRepository(prisma),
  passwords,
  clock,
  unitOfWork,
  audit,
);

const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });

let tenantId: TenantId;
let adminId: UserId;
let authorRoleId: string;

function contextFor(actor: UserId): RequestContext {
  return {
    tenantId,
    userId: actor,
    roles: [SystemRole.TENANT_ADMIN],
    permissions: [Permission.USER_MANAGE, Permission.ROLE_MANAGE],
    sessionId: null,
    correlationId: 'identity-admin',
    permissionVersion: 1,
    locale: 'en',
  };
}

function asAdmin<T>(work: () => Promise<T>): Promise<T> {
  return runWithContext(contextFor(adminId), work);
}

/** A password that satisfies the tenant's policy, so tests are about the rules and not the policy. */
const STRONG_PASSWORD = 'correct-horse-battery-staple-42';

beforeAll(async () => {
  if (!OWNER_URL || !APP_URL) {
    throw new Error('DATABASE_URL and DATABASE_MIGRATION_URL must both be set.');
  }

  // Provisioned rather than hand-seeded, so the eight roles exist exactly as they do in production.
  const provisioned = await provisioning.provision({
    slug: `identity-admin-${Date.now()}`,
    name: 'Identity Admin Test',
    adminEmail: 'root@identity-admin.test',
    adminPassword: STRONG_PASSWORD,
    adminDisplayName: 'Root Administrator',
  });
  tenantId = provisioned.tenantId;
  adminId = provisioned.adminUserId;

  const author = await owner.role.findFirst({
    where: { tenantId, key: SystemRole.AUTHOR },
    select: { id: true },
  });
  authorRoleId = author?.id ?? '';
});

afterAll(async () => {
  await owner.$disconnect();
  await prisma.$disconnect();
});

async function aUser(name: string): Promise<{ id: string; version: number }> {
  const created = await asAdmin(() =>
    users.create({
      email: `${name}-${uuidv7().slice(-8)}@identity-admin.test`,
      displayName: name,
      roleIds: [],
      departments: [],
    }),
  );
  return { id: created.id, version: created.version };
}

describe('creating a user', () => {
  it('starts as invited, with no password and no sessions', async () => {
    const created = await asAdmin(() =>
      users.create({
        email: 'Newcomer@Identity-Admin.test',
        displayName: '  Newcomer  ',
        roleIds: [authorRoleId],
        departments: [],
      }),
    );

    // Invited, not active: an account nobody has set a password for cannot sign in, and saying it is
    // active would be the product lying about its own state.
    expect(created.status).toBe('INVITED');
    expect(created.hasPassword).toBe(false);
    expect(created.roles.map((role) => role.key)).toEqual([SystemRole.AUTHOR]);
    // Whitespace collapsed, address kept as typed.
    expect(created.displayName).toBe('Newcomer');
    expect(created.email).toBe('Newcomer@Identity-Admin.test');
  });

  it('refuses an address already in use, whatever its case', async () => {
    await asAdmin(() =>
      users.create({
        email: 'twice@identity-admin.test',
        displayName: 'First',
        roleIds: [],
        departments: [],
      }),
    );

    await expect(
      asAdmin(() =>
        users.create({
          email: 'TWICE@identity-admin.test',
          displayName: 'Second',
          roleIds: [],
          departments: [],
        }),
      ),
    ).rejects.toMatchObject({ code: 'DUPLICATE' });
  });

  it('names a role that does not exist rather than dropping it', async () => {
    // A form that appeared to grant a role it did not is worse than one that refuses.
    await expect(
      asAdmin(() =>
        users.create({
          email: 'ghost@identity-admin.test',
          displayName: 'Ghost',
          roleIds: [uuidv7()],
          departments: [],
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses two primary departments', async () => {
    const company = await owner.company.findFirst({ where: { tenantId }, select: { id: true } });
    const entity = await owner.entity.findFirst({ where: { tenantId }, select: { id: true } });
    const first = uuidv7();
    const second = uuidv7();
    await owner.department.createMany({
      data: [
        { id: first, tenantId, entityId: entity?.id ?? '', code: 'PR1', name: 'One', path: first },
        {
          id: second,
          tenantId,
          entityId: entity?.id ?? '',
          code: 'PR2',
          name: 'Two',
          path: second,
        },
      ],
    });
    expect(company).not.toBeNull();

    // The partial unique index enforces this too. Checking first is what turns a constraint
    // violation into a message naming the field.
    await expect(
      asAdmin(() =>
        users.create({
          email: 'twoprimary@identity-admin.test',
          displayName: 'Two Primary',
          roleIds: [],
          departments: [
            { departmentId: first, isPrimary: true },
            { departmentId: second, isPrimary: true },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('changing what somebody may do', () => {
  it('bumps the permission version, so an outstanding token stops being accepted', async () => {
    const user = await aUser('Roles');
    const before = await owner.user.findUnique({
      where: { id: user.id },
      select: { permissionVersion: true },
    });

    await asAdmin(() => users.update(user.id, { roleIds: [authorRoleId] }, user.version));

    const after = await owner.user.findUnique({
      where: { id: user.id },
      select: { permissionVersion: true },
    });
    // The whole purpose of the column: a revoked role takes effect within one request rather than at
    // the end of a fifteen-minute token's life.
    expect(after?.permissionVersion).toBe((before?.permissionVersion ?? 0) + 1);
  });

  it('bumps it for a department change too, because membership is a subject the resolver matches on', async () => {
    const entity = await owner.entity.findFirst({ where: { tenantId }, select: { id: true } });
    const departmentId = uuidv7();
    await owner.department.create({
      data: {
        id: departmentId,
        tenantId,
        entityId: entity?.id ?? '',
        code: `DP${uuidv7().slice(-3)}`,
        name: 'Membership',
        path: departmentId,
      },
    });

    const user = await aUser('Member');
    const before = await owner.user.findUnique({
      where: { id: user.id },
      select: { permissionVersion: true },
    });

    await asAdmin(() =>
      users.update(user.id, { departments: [{ departmentId, isPrimary: true }] }, user.version),
    );

    const after = await owner.user.findUnique({
      where: { id: user.id },
      select: { permissionVersion: true },
    });
    expect(after?.permissionVersion).toBeGreaterThan(before?.permissionVersion ?? 0);
  });

  it('bumps every holder when a role’s permissions change', async () => {
    const role = await asAdmin(() =>
      roles.create({
        key: `custom-${uuidv7().slice(-6)}`,
        name: 'Custom',
        permissions: [Permission.DOCUMENT_VIEW],
      }),
    );
    const one = await aUser('HolderOne');
    const two = await aUser('HolderTwo');
    await asAdmin(() => users.update(one.id, { roleIds: [role.id] }, one.version));
    await asAdmin(() => users.update(two.id, { roleIds: [role.id] }, two.version));

    const before = await owner.user.findMany({
      where: { id: { in: [one.id, two.id] } },
      select: { id: true, permissionVersion: true },
      orderBy: { id: 'asc' },
    });

    const current = await asAdmin(() => roles.get(role.id));
    await asAdmin(() =>
      roles.update(
        role.id,
        { permissions: [Permission.DOCUMENT_VIEW, Permission.DOCUMENT_DOWNLOAD] },
        current.version,
      ),
    );

    const after = await owner.user.findMany({
      where: { id: { in: [one.id, two.id] } },
      select: { id: true, permissionVersion: true },
      orderBy: { id: 'asc' },
    });

    // Both holders, in the same transaction as the permission change. A window in which the role
    // says one thing and the tokens in flight say another is a window in which a revoked capability
    // still works.
    expect(after.map((row) => row.permissionVersion)).toEqual(
      before.map((row) => row.permissionVersion + 1),
    );
  });

  it('records a permission change under the action an investigation looks for', async () => {
    const role = await asAdmin(() =>
      roles.create({
        key: `audited-${uuidv7().slice(-6)}`,
        name: 'Audited',
        permissions: [Permission.DOCUMENT_VIEW],
      }),
    );
    const current = await asAdmin(() => roles.get(role.id));
    await asAdmin(() =>
      roles.update(role.id, { permissions: [Permission.DOCUMENT_PUBLISH] }, current.version),
    );

    const events = await owner.auditEvent.findMany({
      where: { tenantId, subjectId: role.id },
      orderBy: { sequence: 'asc' },
      select: { action: true, payload: true },
    });

    expect(events.at(-1)?.action).toBe('ROLE_PERMISSION_CHANGED');
    expect(events.at(-1)?.payload).toMatchObject({
      before: { permissions: [Permission.DOCUMENT_VIEW] },
      after: { permissions: [Permission.DOCUMENT_PUBLISH] },
    });
  });

  it('refuses a blind permission change, because the old set is not recoverable from the new one', async () => {
    const role = await asAdmin(() =>
      roles.create({ key: `blind-${uuidv7().slice(-6)}`, name: 'Blind', permissions: [] }),
    );

    await expect(
      asAdmin(() => roles.update(role.id, { permissions: [Permission.ORG_MANAGE] }, undefined)),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('refuses a permission the catalogue does not define', async () => {
    const role = await asAdmin(() =>
      roles.create({ key: `bogus-${uuidv7().slice(-6)}`, name: 'Bogus', permissions: [] }),
    );
    const current = await asAdmin(() => roles.get(role.id));

    // The wire schema refuses this too. This is the second check the pipeline is built around: the
    // DTO protects the parser, the service protects the invariant whoever called it.
    await expect(
      asAdmin(() => roles.update(role.id, { permissions: ['document:invent'] }, current.version)),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('deduplicates a repeated permission instead of violating the primary key', async () => {
    const role = await asAdmin(() =>
      roles.create({
        key: `dedupe-${uuidv7().slice(-6)}`,
        name: 'Dedupe',
        permissions: [Permission.DOCUMENT_VIEW, Permission.DOCUMENT_VIEW],
      }),
    );
    expect(role.permissions).toEqual([Permission.DOCUMENT_VIEW]);
  });
});

describe('the seeded roles', () => {
  it('cannot be deleted, however empty they are', async () => {
    const reader = await asAdmin(() =>
      roles.list({
        page: 1,
        pageSize: 25,
        sortDirection: 'asc',
        deleted: 'live',
        search: 'Reader',
      }),
    );
    const role = reader.data.find((row) => row.key === SystemRole.READER);
    expect(role).toBeDefined();

    // The product refers to these eight by key: the MFA policy names them, reports group by them,
    // and the seed finds them. Removing one breaks those silently.
    await expect(asAdmin(() => roles.delete(role?.id ?? '', role?.version))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('can have their permissions edited, which is the point of them being data', async () => {
    const list = await asAdmin(() =>
      roles.list({ page: 1, pageSize: 50, sortDirection: 'asc', deleted: 'live' }),
    );
    const approver = list.data.find((row) => row.key === SystemRole.APPROVER);
    expect(approver).toBeDefined();

    // A tenant whose approvers must also publish should not need a release.
    const updated = await asAdmin(() =>
      roles.update(
        approver?.id ?? '',
        { permissions: [...(approver?.permissions ?? []), Permission.DOCUMENT_PUBLISH] },
        approver?.version,
      ),
    );
    expect(updated.permissions).toContain(Permission.DOCUMENT_PUBLISH);
  });

  it('seeds a library manager with nothing tenant-wide, which is the matrix working', async () => {
    const list = await asAdmin(() =>
      roles.list({ page: 1, pageSize: 50, sortDirection: 'asc', deleted: 'live' }),
    );
    const manager = list.data.find((row) => row.key === SystemRole.LIBRARY_MANAGER);

    // Every cell in that column is `S`, `T` or `—`. Seeding an `S` as a tenant-level grant would make
    // it apply everywhere, and `document:delete` is one of them — a library manager would be able to
    // delete any document in a tenant that had configured no ACLs.
    expect(manager?.permissions).toEqual([]);
  });

  it('refuses to name a role a key another role already holds', async () => {
    await expect(
      asAdmin(() => roles.create({ key: 'reader', name: 'Impostor', permissions: [] })),
    ).rejects.toMatchObject({ code: 'DUPLICATE' });
  });
});

describe('setting a password', () => {
  it('ends every session, and makes an invited account active', async () => {
    const user = await aUser('Passworded');
    // Two live families, as a person with a laptop and a phone would have.
    await owner.sessionFamily.createMany({
      data: [
        { id: uuidv7(), tenantId, userId: user.id },
        { id: uuidv7(), tenantId, userId: user.id },
      ],
    });

    await asAdmin(() => users.setPassword(user.id, STRONG_PASSWORD, user.version));

    const families = await owner.sessionFamily.findMany({
      where: { tenantId, userId: user.id },
      select: { revokedAt: true, revokedReason: true },
    });
    // Whoever knew the old password may not be whoever should keep the session — and that is usually
    // exactly why an administrator is setting a new one.
    expect(families).toHaveLength(2);
    expect(families.every((family) => family.revokedAt !== null)).toBe(true);
    expect(families[0]?.revokedReason).toBe('PASSWORD_SET_BY_ADMINISTRATOR');

    const after = await asAdmin(() => users.get(user.id));
    expect(after.status).toBe('ACTIVE');
    expect(after.hasPassword).toBe(true);
  });

  it('applies the tenant’s password policy, because this is a password being set', async () => {
    const user = await aUser('Weak');

    await expect(
      asAdmin(() => users.setPassword(user.id, 'short', user.version)),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('records that it happened without recording what it was', async () => {
    const user = await aUser('Recorded');
    await asAdmin(() => users.setPassword(user.id, STRONG_PASSWORD, user.version));

    const events = await owner.auditEvent.findMany({
      where: { tenantId, subjectId: user.id },
      select: { action: true, payload: true },
    });
    const changed = events.find((event) => event.action === 'PASSWORD_CHANGED');

    expect(changed).toBeDefined();
    // The trail says a password was set, by whom, and that sessions ended. Never the password, and
    // never the hash — audit has no soft delete and no retention policy.
    expect(JSON.stringify(changed?.payload)).not.toContain(STRONG_PASSWORD);
    expect(JSON.stringify(changed?.payload)).not.toContain('scrypt$');
    expect(changed?.payload).toMatchObject({ after: { sessionsRevoked: true } });
  });
});

describe('status and deletion', () => {
  it('refuses to activate somebody who has no password', async () => {
    // An account that is ACTIVE and cannot sign in reads to an administrator as the product being
    // broken.
    const user = await aUser('Unactivatable');
    await expect(
      asAdmin(() => users.setStatus(user.id, 'ACTIVE', user.version)),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('ends every session when an account is disabled', async () => {
    const user = await aUser('Disabled');
    await asAdmin(() => users.setPassword(user.id, STRONG_PASSWORD, user.version));
    const withPassword = await asAdmin(() => users.get(user.id));
    await owner.sessionFamily.create({ data: { id: uuidv7(), tenantId, userId: user.id } });

    await asAdmin(() => users.setStatus(user.id, 'DISABLED', withPassword.version));

    const live = await owner.sessionFamily.count({
      where: { tenantId, userId: user.id, revokedAt: null },
    });
    expect(live).toBe(0);
  });

  it('refuses to let an administrator disable or delete themselves', async () => {
    const self = await asAdmin(() => users.get(adminId));

    // Not paternalism: a tenant whose last administrator locks themselves out needs a database
    // console to recover, and the mistake is one keystroke from the button that disables somebody
    // else. Reported as forbidden rather than not-found, because they plainly may know this account
    // exists — it is theirs.
    await expect(
      asAdmin(() => users.setStatus(adminId, 'DISABLED', self.version)),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(asAdmin(() => users.delete(adminId, self.version))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('frees the email address on delete and refuses a colliding restore', async () => {
    const email = `returner-${uuidv7().slice(-8)}@identity-admin.test`;
    const first = await asAdmin(() =>
      users.create({ email, displayName: 'First Spell', roleIds: [], departments: [] }),
    );
    await asAdmin(() => users.delete(first.id, first.version));

    // The partial index skips deleted rows, so a person who leaves and returns is re-invited rather
    // than resurrected.
    const second = await asAdmin(() =>
      users.create({ email, displayName: 'Second Spell', roleIds: [], departments: [] }),
    );
    expect(second.id).not.toBe(first.id);

    const deleted = await asAdmin(() => users.get(first.id));
    await expect(asAdmin(() => users.restore(first.id, deleted.version))).rejects.toMatchObject({
      code: 'DUPLICATE',
    });
  });

  it('ends every session when an account is deleted', async () => {
    const user = await aUser('Departing');
    await owner.sessionFamily.create({ data: { id: uuidv7(), tenantId, userId: user.id } });

    await asAdmin(() => users.delete(user.id, user.version));

    // The row is gone from every list, and the token would still verify. Both have to stop.
    expect(
      await owner.sessionFamily.count({ where: { tenantId, userId: user.id, revokedAt: null } }),
    ).toBe(0);
  });
});

describe('the permission catalogue', () => {
  it('splits a resource from its action at the first colon', () => {
    const catalogue = roles.catalogue();
    const history = catalogue.find((entry) => entry.key === Permission.DOCUMENT_HISTORY_VIEW);

    // `document:history:view` is one resource and one two-part action. Splitting at the last colon
    // would give a resource of `document:history`, and the matrix editor would render two separate
    // `document` groups.
    expect(history).toEqual({
      key: Permission.DOCUMENT_HISTORY_VIEW,
      resource: 'document',
      action: 'history:view',
      // Not inheritance-proof: only `*:manage` and `audit:*` are. A folder that breaks inheritance is
      // *meant* to be able to hide a document's history from someone who is not accountable for it —
      // what it may never hide is the administrative view of the subtree itself.
      survivesBrokenInheritance: false,
    });
  });

  it('marks the administrative permissions a broken-inheritance folder cannot hide', () => {
    const catalogue = roles.catalogue();
    const byKey = new Map(catalogue.map((entry) => [entry.key, entry]));

    // Otherwise a user could hide a subtree from the administrators accountable for it.
    expect(byKey.get(Permission.LIBRARY_MANAGE)?.survivesBrokenInheritance).toBe(true);
    expect(byKey.get(Permission.AUDIT_VIEW)?.survivesBrokenInheritance).toBe(true);
    expect(byKey.get(Permission.DOCUMENT_VIEW)?.survivesBrokenInheritance).toBe(false);
  });

  it('lists exactly what the catalogue defines, so the editor cannot invent one', () => {
    expect(roles.catalogue()).toHaveLength(Object.keys(Permission).length);
  });
});
