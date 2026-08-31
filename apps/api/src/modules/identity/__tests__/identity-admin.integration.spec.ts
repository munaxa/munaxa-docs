import 'reflect-metadata';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Permission, SystemRole, type TenantId, type UserId, UserStatus, asId } from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import { DuplicateError } from '../../../core/errors/application-errors';
import type { AppConfig } from '../../../core/config/configuration';
import type { Logger } from '../../../core/observability/logger';

import { PrismaUnitOfWork } from '../../../core/prisma/unit-of-work';
import { type RequestContext, runWithContext } from '../../../core/tenancy/tenant-context';
import { realAclResolver, realWriteStack } from '../../../testing/real-collaborators';
import { RoleAdminService } from '../application/role-admin.service';
import { UserAdminService } from '../application/user-admin.service';
import { PrismaIdentityAdminRepository } from '../infrastructure/prisma-identity-admin.repository';
import { PrismaProvisioningRepository } from '../infrastructure/prisma-provisioning.repository';
import { ProvisioningService } from '../application/provisioning.service';
import { ScryptPasswordHasher } from '../infrastructure/scrypt-password-hasher';
import { personOptionQuerySchema } from '@edms/contracts';

import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';

import { AuthenticationGuard } from '../../../core/auth/authentication.guard';
import { FakeCache } from '../../../testing/fake-ports';
import { CachedPermissionVersionReader } from '../infrastructure/cached-permission-version.reader';
import { everyTenantRegistry, sharedDatabase } from '../../../testing/tenant-database';

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

const prisma = sharedDatabase(config, logger, APP_URL);
const unitOfWork = new PrismaUnitOfWork(prisma);
const { stamps, writer, audit } = realWriteStack(clock, unitOfWork);
const passwords = new ScryptPasswordHasher();
/**
 * A real, observable cache — because the permission version is only authoritative if the entry
 * that caches it is cleared when the number moves. Slice 31 put that invalidation inside
 * `bumpPermissionVersion`, and this is where it is proven.
 */
const cache = new FakeCache(clock);
const repository = new PrismaIdentityAdminRepository(stamps, cache);
const versions = new CachedPermissionVersionReader(cache, unitOfWork);
/**
 * The resolver is here only so a membership change can clear the ACL cache — Slice 37. Composed
 * through the testing module rather than by importing `library/infrastructure/`, which the
 * cross-module boundary lint forbids from anything under `src/modules/**`. It shares this suite's
 * `cache`, so what it clears is the same map everything else here reads.
 */
const users = new UserAdminService(
  repository,
  passwords,
  writer,
  realAclResolver({ clock, unitOfWork, config, cache }),
);
const roles = new RoleAdminService(
  repository,
  writer,
  realAclResolver({ clock, unitOfWork, config, cache }),
);
/** The placement this suite provisions into — declared, because the identifier is configuration now. */
const PROVISION_SLUG = `identity-admin-${String(Date.now())}`;
const PROVISION_TENANT = uuidv7();

const provisioning = new ProvisioningService(
  new PrismaProvisioningRepository(),
  passwords,
  clock,
  unitOfWork,
  audit,
  everyTenantRegistry(APP_URL, { [PROVISION_SLUG]: PROVISION_TENANT }),
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
    slug: PROVISION_SLUG,
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
  await prisma.disconnectAll();
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
            { departmentId: first, isPrimary: true, isManager: false },
            { departmentId: second, isPrimary: true, isManager: false },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

/**
 * Ending an account, and what "ending" reaches — Slice 32.
 *
 * `revokeSessions` ends the refresh families, which is what a *session* is in the database. It
 * cannot reach an access token: that is a signed statement in somebody's browser, and until
 * Slice 31 nothing in the product could reach one either. Now something can, and these are the
 * three revocations that were still waiting out the token's life.
 *
 * Asserted through the guard rather than through the counter, because the counter moving is not
 * the claim — the claim is the sentence on `setStatus`: "a disabled user holds no active session".
 */
describe('ending an account', () => {
  /** The refusal `AuthenticationGuard` gives, for a token carrying `version`. */
  async function accepts(userId: string, version: number): Promise<boolean> {
    const guard = new AuthenticationGuard(new Reflector(), versions);
    const request = {
      getHandler: () => () => {},
      getClass: () => class Controller {},
    } as unknown as ExecutionContext;
    try {
      return await runWithContext(
        { ...contextFor(asId<UserId>(userId)), permissionVersion: version },
        () => guard.canActivate(request),
      );
    } catch {
      return false;
    }
  }

  /**
   * The positive control, first: a token minted now is accepted, so every refusal below is about
   * the administrative act and not about the harness.
   */
  it('accepts the token an active user is holding', async () => {
    const user = await aUser('Untouched');
    const minted = await asAdmin(() => versions.currentFor(asId<UserId>(user.id)));

    await expect(accepts(user.id, minted ?? 0)).resolves.toBe(true);
  });

  it('stops accepting the token of somebody who has been disabled', async () => {
    const user = await aUser('Disabled');
    // A password and an activation first, because activating somebody without one is refused and a
    // disabled account is only interesting if it could sign in beforehand. Both of those *also*
    // end sessions, so the version a token would carry is read afterwards — reading it first made
    // this case pass with the disable bump removed, which is what mutation testing is for.
    await asAdmin(() => users.setPassword(user.id, STRONG_PASSWORD, undefined));
    const withPassword = await asAdmin(() => users.get(user.id));
    await asAdmin(() => users.setStatus(user.id, UserStatus.ACTIVE, withPassword.version));
    const active = await asAdmin(() => users.get(user.id));
    const minted = (await asAdmin(() => versions.currentFor(asId<UserId>(user.id)))) ?? 0;
    await expect(accepts(user.id, minted)).resolves.toBe(true);

    await asAdmin(() => users.setStatus(user.id, UserStatus.DISABLED, active.version));

    // The token is still in their browser and still signed. Nothing about it changed.
    await expect(accepts(user.id, minted)).resolves.toBe(false);
  });

  it('stops accepting the token of somebody who has been deleted', async () => {
    const user = await aUser('Deleted');
    const minted = (await asAdmin(() => versions.currentFor(asId<UserId>(user.id)))) ?? 0;

    await asAdmin(() => users.delete(user.id, user.version));

    await expect(accepts(user.id, minted)).resolves.toBe(false);
  });

  /**
   * The compromise response. `setPassword` says why it revokes: "the person whose password this
   * was may not be the person who should keep the session open, and that is usually why an
   * administrator is here". A token that outlives the reset by a quarter of an hour is exactly the
   * thing that sentence is about.
   */
  it('stops accepting the token held when an administrator resets the password', async () => {
    const user = await aUser('Reset');
    const minted = (await asAdmin(() => versions.currentFor(asId<UserId>(user.id)))) ?? 0;

    await asAdmin(() => users.setPassword(user.id, STRONG_PASSWORD, undefined));

    await expect(accepts(user.id, minted)).resolves.toBe(false);
  });
});

describe('changing what somebody may do', () => {
  /**
   * Named for what it proves — Slice 31, and it did not until then.
   *
   * This case has asserted `after === before + 1` since Phase 0.5 while being called "so an
   * outstanding token stops being accepted". The number moving was never the claim; nothing
   * compared it, so no token stopped being accepted and the name was aspirational. It now asserts
   * the mechanism that makes the sentence true: the number moves **and** the cached answer that
   * `AuthenticationGuard` reads moves with it, in the same transaction as the role change.
   *
   * The cache is read through the real reader rather than inspected directly, because a test that
   * reached into the entry would still pass if the guard asked a differently-spelled key.
   */
  it('bumps the permission version, so an outstanding token stops being accepted', async () => {
    const user = await aUser('Roles');
    const userId = asId<UserId>(user.id);

    // The number a token minted now would carry — and, as a side effect, a warm cache entry, which
    // is the state a busy tenant is always in and the one an invalidation has to survive.
    const minted = await asAdmin(() => versions.currentFor(userId));
    expect(minted).not.toBeNull();

    await asAdmin(() => users.update(user.id, { roleIds: [authorRoleId] }, user.version));

    const row = await owner.user.findUnique({
      where: { id: user.id },
      select: { permissionVersion: true },
    });
    expect(row?.permissionVersion).toBe((minted ?? 0) + 1);

    // The half that was missing. Without the invalidation inside `bumpPermissionVersion` this
    // still answers `minted`, the guard finds a match, and the outstanding token goes on working
    // for the rest of its life.
    await expect(asAdmin(() => versions.currentFor(userId))).resolves.toBe((minted ?? 0) + 1);
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
      users.update(
        user.id,
        { departments: [{ departmentId, isPrimary: true, isManager: false }] },
        user.version,
      ),
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
    //
    // `notification:manage` is the one exception, added by Phase 12 and held by every role: its
    // scope is the holder's own inbox, and no route under `/notifications` takes a user identifier
    // for it to widen. It confers no reach over anything of the tenant's, which is what this
    // assertion is about.
    expect(manager?.permissions).toEqual([Permission.NOTIFICATION_MANAGE]);
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

/**
 * Finding somebody past the first page — Slice 13, against a real PostgreSQL and 150 real rows.
 *
 * ## The defect, stated as arithmetic
 *
 * The permission subject pickers were `<select>` elements filled from one page of a hundred
 * options, sorted by display name ascending, with `search` never sent. A person sorting at position
 * 101 or beyond is therefore *not in the list*, and a native `<select>` has no way to ask for more:
 * they cannot be granted a permission at all.
 *
 * That is not a hypothesis about scale, it is `LIMIT 100 OFFSET 0` over an ordered set, so it is
 * proved here the only way worth proving it — by putting 150 people in a database and looking.
 *
 * ## Why the search-field assertions are here too
 *
 * `listUsers` searches `displayName` **and `email`** by default, which is right for the screen that
 * administers accounts. `/directory/people` returns an identifier and a label and never the
 * address, so matching on a column it does not return would make it an existence oracle: type a
 * guessed address, and a row coming back confirms it belongs to this tenant. The operational route
 * passes `searchFields: ['displayName']`, and both halves of that are asserted — the administrative
 * default still finds by email, and the operational one does not.
 */
describe('a picker with more people than one page', () => {
  /** Sorts after everything else this suite creates, so position is a property of the data. */
  const PREFIX = 'Zz Picker';
  const LAST = `${PREFIX} 150`;
  /** One page, at `MAX_PAGE_SIZE` — the largest request the API will accept at all. */
  const ONE_PAGE = {
    page: 1,
    pageSize: 100,
    sortBy: 'displayName',
    sortDirection: 'asc',
    deleted: 'live',
  } as const;

  let deletedPersonName: string;

  beforeAll(async () => {
    for (let index = 1; index <= 150; index += 1) {
      await owner.user.create({
        data: {
          id: uuidv7(),
          tenantId,
          email: `picker-${String(index).padStart(3, '0')}@identity-admin.test`,
          emailNormalized: `picker-${String(index).padStart(3, '0')}@identity-admin.test`,
          displayName: `${PREFIX} ${String(index).padStart(3, '0')}`,
          status: 'ACTIVE',
          updatedAt: FIXED_NOW,
        },
      });
    }
    // `Zz Picker 150` is the one the picker must be able to reach: the 149 siblings sorting before
    // it guarantee it sits beyond a hundred rows whatever else this suite has created.

    deletedPersonName = `${PREFIX} 077`;
    const departed = await owner.user.findFirstOrThrow({
      where: { tenantId, displayName: deletedPersonName },
    });
    await owner.user.update({
      where: { id: departed.id },
      data: { deletedAt: FIXED_NOW },
    });
  }, 120_000);

  it('cannot offer the person at all without a search', async () => {
    const page = await asAdmin(() =>
      users.list({ ...ONE_PAGE, status: UserStatus.ACTIVE, searchFields: ['displayName'] }),
    );

    expect(page.data).toHaveLength(100);
    expect(page.data.map((row) => row.displayName)).not.toContain(LAST);
    // And it says so, which is what lets a client know the list is a page rather than the tenant.
    expect(page.meta.hasMore).toBe(true);
    expect(page.meta.total).toBeGreaterThan(100);
  });

  it('returns exactly that person when they are searched for', async () => {
    const page = await asAdmin(() =>
      users.list({
        ...ONE_PAGE,
        status: UserStatus.ACTIVE,
        searchFields: ['displayName'],
        search: LAST,
      }),
    );

    expect(page.data.map((row) => row.displayName)).toStrictEqual([LAST]);
    expect(page.meta.hasMore).toBe(false);
  });

  it('matches case-insensitively, because nobody types a name the way it is stored', async () => {
    const page = await asAdmin(() =>
      users.list({
        ...ONE_PAGE,
        status: UserStatus.ACTIVE,
        searchFields: ['displayName'],
        search: 'zz picker 150',
      }),
    );

    expect(page.data.map((row) => row.displayName)).toStrictEqual([LAST]);
  });

  it('returns several when several match, still bounded to one page', async () => {
    const page = await asAdmin(() =>
      users.list({
        ...ONE_PAGE,
        status: UserStatus.ACTIVE,
        searchFields: ['displayName'],
        search: PREFIX,
      }),
    );

    expect(page.data.length).toBeLessThanOrEqual(100);
    expect(page.meta.total).toBe(149); // 150 seeded, one soft-deleted below.
  });

  it('answers an empty list when nothing matches, rather than failing', async () => {
    const page = await asAdmin(() =>
      users.list({
        ...ONE_PAGE,
        status: UserStatus.ACTIVE,
        searchFields: ['displayName'],
        search: 'nobody by that name at all',
      }),
    );

    expect(page.data).toStrictEqual([]);
    expect(page.meta.total).toBe(0);
    expect(page.meta.hasMore).toBe(false);
  });

  it('never returns a deleted person, however precisely they are named', async () => {
    // The operational route has no word for `deleted` — `optionListQuerySchema` omits the parameter
    // — so this is what the controller always sends, and searching cannot reach past it.
    const page = await asAdmin(() =>
      users.list({
        ...ONE_PAGE,
        status: UserStatus.ACTIVE,
        searchFields: ['displayName'],
        search: deletedPersonName,
      }),
    );

    expect(page.data).toStrictEqual([]);
  });

  it('cannot search into another tenant', async () => {
    /*
     * `listUsers` scopes to the ambient tenant, so the same term run under a different tenant finds
     * nothing — the boundary is the query's, not the term's.
     */
    const elsewhere = await runWithContext(
      { ...contextFor(adminId), tenantId: uuidv7() as TenantId },
      () =>
        users.list({
          ...ONE_PAGE,
          status: UserStatus.ACTIVE,
          searchFields: ['displayName'],
          search: LAST,
        }),
    );

    expect(elsewhere.data).toStrictEqual([]);
  });

  it('searches only the label the picker shows, never the address behind it', async () => {
    /*
     * The disclosure this narrowing closes. `/directory/people` returns `{id, displayName}`; if it
     * matched `email` as well, a caller holding `directory:view` could type a guessed address and
     * learn from a row coming back that it belongs to this tenant — an existence oracle for a field
     * the endpoint deliberately withholds.
     */
    const operational = await asAdmin(() =>
      users.list({
        ...ONE_PAGE,
        status: UserStatus.ACTIVE,
        searchFields: ['displayName'],
        search: 'picker-150@identity-admin.test',
      }),
    );

    expect(operational.data).toStrictEqual([]);
  });

  it('still finds by email for the screen that administers accounts', async () => {
    // The other half: the administrative default is unchanged, because finding somebody by the
    // address you have is the whole point of the users screen.
    const administrative = await asAdmin(() =>
      users.list({ ...ONE_PAGE, search: 'picker-150@identity-admin.test' }),
    );

    expect(administrative.data.map((row) => row.displayName)).toStrictEqual([LAST]);
  });

  it('refuses to be asked for the whole catalogue', () => {
    /*
     * `pageQuerySchema` **rejects** a page size above `MAX_PAGE_SIZE` rather than clamping it, so
     * "give me everything" is not a request any client can spell. Asserted at the schema, because
     * that is where the bound lives.
     */
    expect(() => personOptionQuerySchema.parse({ page: '1', pageSize: '5000' })).toThrow();
    expect(personOptionQuerySchema.parse({ page: '1', pageSize: '100' }).pageSize).toBe(100);
  });
});

/**
 * Searching the roles an ACL entry may name — Slice 13.
 *
 * ## Why this fixture is small on purpose
 *
 * The people and department cases above seed 150 rows, because a tenant with more than a hundred
 * staff or organisational units is ordinary and the >100 failure is a thing customers actually hit.
 * A role catalogue is not that kind of list: the product seeds eight, they are a deliberately
 * curated statement of who does what, and a tenant with more than a hundred of them has a different
 * problem than pagination. Seeding 150 to make a point about `LIMIT 100` would be inventing a
 * scenario to test rather than testing one.
 *
 * The code path is the same `searchConditions` over the same `orderByFor` and `pageArgs`, already
 * proved against 150 rows twice. What is genuinely worth asserting for roles is the *narrowing*:
 * `listRoles` matches `name`, `key` **and `description`** by default, and `/acl/roles` returns an
 * identifier and a name — so matching the other two would let a permission editor probe for fields
 * it is never shown.
 */
describe('the roles an ACL entry may name', () => {
  const ONE_PAGE = {
    page: 1,
    pageSize: 100,
    sortBy: 'name',
    sortDirection: 'asc',
    deleted: 'live',
  } as const;

  beforeAll(async () => {
    await asAdmin(() =>
      roles.create({
        key: 'ZZ_PICKER_ROLE',
        name: 'Zz Findable Reviewer',
        description: 'A description nobody choosing a subject is shown.',
        permissions: [],
      }),
    );
  }, 60_000);

  it('finds a role by the name it shows', async () => {
    const page = await asAdmin(() =>
      roles.list({ ...ONE_PAGE, searchFields: ['name'], search: 'findable' }),
    );

    expect(page.data.map((row) => row.name)).toStrictEqual(['Zz Findable Reviewer']);
  });

  it('does not let a permission editor search the stable key', async () => {
    const page = await asAdmin(() =>
      roles.list({ ...ONE_PAGE, searchFields: ['name'], search: 'ZZ_PICKER_ROLE' }),
    );

    expect(page.data).toStrictEqual([]);
  });

  it('does not let a permission editor search the description', async () => {
    const page = await asAdmin(() =>
      roles.list({ ...ONE_PAGE, searchFields: ['name'], search: 'nobody choosing a subject' }),
    );

    expect(page.data).toStrictEqual([]);
  });

  it('still searches all three for the screen that administers roles', async () => {
    // The administrative default is unchanged: an administrator editing roles searches the key and
    // the description because both are on the screen in front of them.
    const byKey = await asAdmin(() => roles.list({ ...ONE_PAGE, search: 'ZZ_PICKER_ROLE' }));

    expect(byKey.data.map((row) => row.name)).toStrictEqual(['Zz Findable Reviewer']);
  });

  it('cannot search into another tenant', async () => {
    const elsewhere = await runWithContext(
      { ...contextFor(adminId), tenantId: uuidv7() as TenantId },
      () => roles.list({ ...ONE_PAGE, searchFields: ['name'], search: 'findable' }),
    );

    expect(elsewhere.data).toStrictEqual([]);
  });
});

/**
 * Two callers, each parked at the statement that inserts the account.
 *
 * Ordinals are assigned by arrival and the arrival order is fixed rather than observed: the second
 * caller is not started until the first has parked, so the first is always ordinal zero.
 */
class Turnstile<TMarker> {
  readonly arrivals: TMarker[] = [];
  readonly reached: Promise<void>[] = [];
  private readonly announce: (() => void)[] = [];
  private readonly admissions: Promise<void>[] = [];
  private readonly admits: (() => void)[] = [];
  private armed = false;

  arm(callers: number): void {
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
    this.armed = true;
  }

  async park(marker: TMarker): Promise<void> {
    if (!this.armed) {
      return;
    }
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
 * One address, one account, however many administrators invite it at once — Slice 63.
 *
 * `create` asks `emailTaken` and then inserts. Those are two statements in one transaction, and two
 * administrators are two transactions: both read the address as free, and both insert against
 * `uq_user_tenant_email` — the partial index on `(tenant_id, email_normalized) WHERE deleted_at IS
 * NULL`, which is the same condition `emailTaken` reads, asked a moment later.
 *
 * The data is safe: the index admits one. What the loser is *told* is not. A raw `P2002` is neither
 * a `DomainError` nor an `HttpException`, so `AllExceptionsFilter` answers `500`, where the same
 * request a moment later in sequence is refused with `DuplicateError` — "this address is already in
 * use", which is what an administrator can act on.
 */
describe('one address, one account, however many administrators invite it at once', () => {
  const turnstile = new Turnstile<string>();

  /** The real repository, subclassed: the override only adds a place to stand before the insert. */
  class ParkingIdentityAdminRepository extends PrismaIdentityAdminRepository {
    override async insertUser(
      input: Parameters<PrismaIdentityAdminRepository['insertUser']>[0],
    ): Promise<void> {
      await turnstile.park(input.emailNormalized);
      return super.insertUser(input);
    }
  }

  let parking: UserAdminService;

  beforeAll(() => {
    parking = new UserAdminService(
      new ParkingIdentityAdminRepository(stamps, cache),
      passwords,
      writer,
      realAclResolver({ clock, unitOfWork, config, cache }),
    );
  });

  async function accountsWith(email: string): Promise<number> {
    return owner.user.count({
      where: { tenantId, emailNormalized: email.toLowerCase(), deletedAt: null },
    });
  }

  it('creates the account when nothing contends', async () => {
    // The control. Without it every assertion below passes on a service that creates nothing.
    const email = `solo-${uuidv7().slice(-8)}@identity-admin.test`;
    const created = await asAdmin(() =>
      parking.create({ email, displayName: 'Solo', roleIds: [], departments: [] }),
    );

    expect(created.id).toBeTruthy();
    expect(await accountsWith(email)).toBe(1);
  });

  it('refuses a second invitation of the same address when the two are ordered', async () => {
    // The sequential answer the concurrent one has to match, and the reason the failure below is
    // about concurrency rather than about the duplicate check being absent.
    const email = `ordered-${uuidv7().slice(-8)}@identity-admin.test`;
    await asAdmin(() =>
      parking.create({ email, displayName: 'First', roleIds: [], departments: [] }),
    );

    await expect(
      asAdmin(() => parking.create({ email, displayName: 'Second', roleIds: [], departments: [] })),
    ).rejects.toThrow(DuplicateError);
    expect(await accountsWith(email)).toBe(1);
  });

  it('reports a failure that is not a duplicate as itself', async () => {
    /*
     * The narrowing, asserted. Translating *every* failure from this insert into "that address is
     * already in use" would hide a genuine fault behind a plausible refusal, so the predicate is
     * `P2002` on `User` and nothing else. A tenant that does not exist violates the foreign key
     * instead, which must surface as itself.
     */
    const nowhere = asId<TenantId>(uuidv7());
    const outcome = await runWithContext({ ...contextFor(adminId), tenantId: nowhere }, () =>
      users.create({
        email: `orphan-${uuidv7().slice(-8)}@identity-admin.test`,
        displayName: 'Orphan',
        roleIds: [],
        departments: [],
      }),
    ).then(
      () => ({ kind: 'created' as const, error: undefined }),
      (error: unknown) => ({ kind: 'refused' as const, error }),
    );

    expect(outcome.kind).toBe('refused');
    expect(outcome.error).not.toBeInstanceOf(DuplicateError);
  });

  it('refuses the loser the way the ordered second caller is refused', async () => {
    const email = `contended-${uuidv7().slice(-8)}@identity-admin.test`;
    expect(await accountsWith(email)).toBe(0);
    turnstile.arm(2);

    // Each from its own scope, so each opens its own transaction.
    const one = asAdmin(() =>
      parking.create({ email, displayName: 'One', roleIds: [], departments: [] }),
    );
    await turnstile.reached[0];
    const two = asAdmin(() =>
      parking.create({ email, displayName: 'Two', roleIds: [], departments: [] }),
    );
    await turnstile.reached[1];

    // Both read the address as free, and both are about to claim it.
    expect(turnstile.arrivals).toEqual([email.toLowerCase(), email.toLowerCase()]);

    turnstile.release(0);
    const winner = await one.then(
      (value) => ({ kind: 'created' as const, value }),
      (error: unknown) => ({ kind: 'refused' as const, error }),
    );
    turnstile.release(1);
    const loser = await two.then(
      () => ({ kind: 'created' as const, error: undefined }),
      (error: unknown) => ({ kind: 'refused' as const, error }),
    );

    // The index keeps the data right whatever the callers are told.
    expect(winner.kind).toBe('created');
    expect(await accountsWith(email)).toBe(1);

    // And the loser is told what the ordered second caller is told, rather than meeting a raw
    // constraint violation that reaches the administrator as a `500`.
    expect(loser.kind).toBe('refused');
    expect(loser.error).toBeInstanceOf(DuplicateError);
  });
});

/**
 * One address, one live account, however the second claim on it arrives — Slice 64.
 *
 * Slice 63 closed this for `insertUser`. It is the same index and the same read-then-write, and two
 * further statements reach it: **restoring** a deleted account puts its row back inside
 * `uq_user_tenant_email` — the index is partial on `deleted_at IS NULL`, so a deleted row is outside
 * it and a restored one is inside again — and **changing an address** moves the indexed value on a
 * row that is already inside.
 *
 * Both are guarded by a read the service performs first, and the restore path's own comment says
 * why: "the address was released when the account was deleted, and may have been re-invited since".
 * That read and the write are two statements, so an invitation that lands between them leaves the
 * write to meet the index — as a raw `P2002`, which `AllExceptionsFilter` renders `500`, where the
 * ordered administrator is refused with `DuplicateError`.
 *
 * The sequential answer is already pinned by this suite: "refuses to restore an account whose
 * address has been re-invited" expects `DUPLICATE`. These are the same two administrators, at once.
 */
/** The display name that asks the parking repository to stop before it writes. */
const PARK_HERE = 'park-here';

describe('one address, one live account, however the second claim arrives', () => {
  const turnstile = new Turnstile<string>();

  /** The real repository, subclassed: each override only adds a place to stand before its write. */
  class ParkingLifecycleRepository extends PrismaIdentityAdminRepository {
    override async setUserDeleted(id: string, version: number, deleted: boolean): Promise<void> {
      await turnstile.park(`restore:${id}`);
      return super.setUserDeleted(id, version, deleted);
    }

    override async updateUser(
      id: string,
      version: number,
      patch: Parameters<PrismaIdentityAdminRepository['updateUser']>[2],
    ): Promise<void> {
      if (patch.emailNormalized !== undefined) {
        await turnstile.park(`email:${id}`);
      }
      // A second place to stand, for the version race below. Keyed on a sentinel name so it cannot
      // interfere with the address tests, which park on their own marker.
      if (patch.displayName === PARK_HERE) {
        await turnstile.park(`version:${id}`);
      }
      return super.updateUser(id, version, patch);
    }
  }

  let parking: UserAdminService;

  beforeAll(() => {
    parking = new UserAdminService(
      new ParkingLifecycleRepository(stamps, cache),
      passwords,
      writer,
      realAclResolver({ clock, unitOfWork, config, cache }),
    );
  });

  async function liveWith(email: string): Promise<number> {
    return owner.user.count({
      where: { tenantId, emailNormalized: email.toLowerCase(), deletedAt: null },
    });
  }

  it('restores an account whose address is still free', async () => {
    // The control. Without it the assertion below passes on a service that restores nothing.
    const email = `returning-${uuidv7().slice(-8)}@identity-admin.test`;
    const person = await asAdmin(() =>
      parking.create({ email, displayName: 'Returning', roleIds: [], departments: [] }),
    );
    await asAdmin(() => parking.delete(person.id, person.version));
    expect(await liveWith(email)).toBe(0);

    const deleted = await asAdmin(() => parking.get(person.id));
    await asAdmin(() => parking.restore(person.id, deleted.version));

    expect(await liveWith(email)).toBe(1);
  });

  it('refuses a restore whose address is re-invited while the restore is deciding', async () => {
    const email = `contended-restore-${uuidv7().slice(-8)}@identity-admin.test`;
    const person = await asAdmin(() =>
      parking.create({ email, displayName: 'Away', roleIds: [], departments: [] }),
    );
    await asAdmin(() => parking.delete(person.id, person.version));
    const deleted = await asAdmin(() => parking.get(person.id));
    // Ordinals accumulate across this block, so each test takes the slots it arms rather than
    // assuming it starts at zero.
    const base = turnstile.reached.length;
    turnstile.arm(1);

    // The restore reaches its write only once its own `emailTaken` has answered "free", so parking
    // here is the proof that it decided the address was available.
    const restoring = asAdmin(() => parking.restore(person.id, deleted.version));
    await turnstile.reached[base];

    // A second administrator invites the address the restore has just decided is free. Its own
    // scope, its own transaction, and it commits before the restore is let go.
    const invited = await asAdmin(() =>
      parking.create({ email, displayName: 'Newcomer', roleIds: [], departments: [] }),
    );
    expect(invited.id).not.toBe(person.id);
    expect(await liveWith(email)).toBe(1);

    turnstile.release(base);
    const outcome = await restoring.then(
      () => ({ kind: 'restored' as const, error: undefined }),
      (error: unknown) => ({ kind: 'refused' as const, error }),
    );

    // The index keeps the data right: one live account for the address, the newcomer's.
    expect(await liveWith(email)).toBe(1);
    // And the administrator is told what the ordered one is told, rather than meeting a raw
    // constraint violation that reaches them as a `500`.
    expect(outcome.kind).toBe('refused');
    expect(outcome.error).toBeInstanceOf(DuplicateError);
  });

  it('refuses a change whose row moved after the service checked its version', async () => {
    /*
     * The optimistic guard, under concurrency rather than in sequence — Slice 64's audit question.
     *
     * `UserAdminService` calls `checkVersion` against the row it just read, and this suite already
     * covers that: a caller presenting a stale number is refused. What that cannot cover is a row
     * that moves *after* the service looked. The repository carries `version` in its own `WHERE`
     * and reads the affected-row count, and this is what makes that second guard load-bearing
     * rather than decorative.
     */
    const person = await aUser('Contended');
    const base = turnstile.reached.length;
    turnstile.arm(1);

    const changing = asAdmin(() =>
      parking.update(person.id, { displayName: PARK_HERE }, person.version),
    );
    await turnstile.reached[base];

    // Somebody else moves the row while the first change is parked, so its version is spent.
    await asAdmin(() => parking.update(person.id, { displayName: 'Moved' }, person.version));

    turnstile.release(base);
    const outcome = await changing.then(
      () => ({ kind: 'changed' as const, error: undefined }),
      (error: unknown) => ({ kind: 'refused' as const, error }),
    );

    expect(outcome.kind).toBe('refused');
    expect(outcome.error).toMatchObject({ code: 'VERSION_CONFLICT' });
    // And the row holds the change that won, not the one that was parked.
    const after = await owner.user.findUniqueOrThrow({ where: { id: person.id } });
    expect(after.displayName).toBe('Moved');
  });

  it('refuses an address change that is claimed while the change is deciding', async () => {
    const mine = `mover-${uuidv7().slice(-8)}@identity-admin.test`;
    const wanted = `wanted-${uuidv7().slice(-8)}@identity-admin.test`;
    const mover = await asAdmin(() =>
      parking.create({ email: mine, displayName: 'Mover', roleIds: [], departments: [] }),
    );
    const base = turnstile.reached.length;
    turnstile.arm(1);

    const changing = asAdmin(() => parking.update(mover.id, { email: wanted }, mover.version));
    await turnstile.reached[base];

    // Somebody else takes the address between the check and the write.
    await asAdmin(() =>
      parking.create({ email: wanted, displayName: 'Claimant', roleIds: [], departments: [] }),
    );

    turnstile.release(base);
    const outcome = await changing.then(
      () => ({ kind: 'changed' as const, error: undefined }),
      (error: unknown) => ({ kind: 'refused' as const, error }),
    );

    expect(await liveWith(wanted)).toBe(1);
    expect(outcome.kind).toBe('refused');
    expect(outcome.error).toBeInstanceOf(DuplicateError);
  });
});
