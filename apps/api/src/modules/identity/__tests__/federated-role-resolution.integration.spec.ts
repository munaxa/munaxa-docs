import 'reflect-metadata';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Permission, SystemRole, type TenantId, type UserId, asId } from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import type { AppConfig } from '../../../core/config/configuration';
import type { Logger } from '../../../core/observability/logger';

import { PrismaUnitOfWork } from '../../../core/prisma/unit-of-work';
import { type RequestContext, runWithContext } from '../../../core/tenancy/tenant-context';
import { realWriteStack } from '../../../testing/real-collaborators';
import { everyTenantRegistry, sharedDatabase } from '../../../testing/tenant-database';
import { ProvisioningService } from '../application/provisioning.service';
import { RoleAdminService } from '../application/role-admin.service';
import { PrismaCredentialRepository } from '../infrastructure/prisma-credential.repository';
import { PrismaFederatedUserRepository } from '../infrastructure/prisma-federation.repository';
import { PrismaIdentityAdminRepository } from '../infrastructure/prisma-identity-admin.repository';
import { PrismaProvisioningRepository } from '../infrastructure/prisma-provisioning.repository';
import { ScryptPasswordHasher } from '../infrastructure/scrypt-password-hasher';

/**
 * What a role in the recycle bin grants, which must be nothing — Slice 22.
 *
 * ## The defect
 *
 * `DefaultFederationService`'s own contract is that JIT provisioning grants *"exactly what the
 * mapping says and nothing more"*, and that **"a role key that resolves to no role in this tenant
 * is dropped rather than created"**. A role the tenant deleted is a role that resolves to nothing —
 * but `PrismaFederatedUserRepository.provision` matched on `key` alone, so it resolved withdrawn roles
 * and assigned them.
 *
 * Three facts make that reachable rather than theoretical, and each is checked here rather than
 * assumed:
 *
 * 1. **Deleting a role keeps its permissions.** `setRoleDeleted` stamps the role; its
 *    `role_permission` rows are untouched.
 * 2. **A deleted role's key is free again.** `roleKeyTaken` filters `deletedAt: null`, and
 *    `uq_role_tenant_key` is a *partial* index (`WHERE "deleted_at" IS NULL`) — so a tenant may
 *    delete `contractors` and create a new `contractors`, and both rows exist under one key.
 * 3. **Nothing makes the administrator edit the provider's mapping.** Unmatched keys are dropped
 *    silently by design, so a mapping naming a deleted role is the expected state after a deletion,
 *    not a misconfiguration.
 *
 * Put together: delete a role, create a replacement under the same key, and the next person to
 * arrive through the provider was granted **both** — including the permissions the tenant had just
 * withdrawn.
 *
 * ## Why the credential query is asserted too
 *
 * Because filtering only the writer leaves every row already written granting permissions forever,
 * and because `user_role` has more than one writer. `PrismaCredentialRepository` is the single
 * point every sign-in and every refresh passes through, so "a withdrawn role grants nothing" is
 * enforced there as well. The two halves fail independently below, which is what makes them two
 * fixes rather than one with a spare.
 *
 * ## Why a real database
 *
 * The partial unique index is the load-bearing fact, and only PostgreSQL can be asked whether it
 * really permits a live and a deleted role under one key. A double asserting "the repository
 * filters" would pass against a schema that forbade the collision outright and prove nothing.
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

const FIXED_NOW = new Date('2026-06-01T09:00:00.000Z');
const clock = { now: () => new Date(FIXED_NOW), timestamp: () => 0, elapsedMs: () => 0 };

const prisma = sharedDatabase(config, logger, APP_URL);
const unitOfWork = new PrismaUnitOfWork(prisma);
const { stamps, writer, audit } = realWriteStack(clock, unitOfWork);
const passwords = new ScryptPasswordHasher();
const repository = new PrismaIdentityAdminRepository(stamps);
const roles = new RoleAdminService(repository, writer);
const federation = new PrismaFederatedUserRepository();
const credentials = new PrismaCredentialRepository();

const PROVISION_SLUG = `federated-roles-${String(Date.now())}`;
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
let providerId: string;

/** The key the provider maps a group to, and which outlives the role it was created for. */
const MAPPED_KEY = 'contractors';
/** Withdrawn with the role. Nobody who arrives after the deletion may end up holding it. */
const WITHDRAWN = Permission.DOCUMENT_DELETE;
/** Held by the replacement role, so "granted nothing at all" and "granted the right thing" differ. */
const REPLACEMENT = Permission.DOCUMENT_VIEW;

function contextFor(actor: UserId): RequestContext {
  return {
    tenantId,
    userId: actor,
    roles: [SystemRole.TENANT_ADMIN],
    permissions: [Permission.USER_MANAGE, Permission.ROLE_MANAGE],
    sessionId: null,
    correlationId: 'federated-roles',
    permissionVersion: 1,
    locale: 'en',
  };
}

function asAdmin<T>(work: () => Promise<T>): Promise<T> {
  return runWithContext(contextFor(adminId), work);
}

/** Runs repository code the way a use case does: inside the tenant's transaction. */
function inTransaction<T>(work: () => Promise<T>): Promise<T> {
  return asAdmin(() => unitOfWork.run(work));
}

/** Signs somebody in through the provider, as `FederationService` does on a first arrival. */
async function federate(email: string, roleKeys: readonly string[]): Promise<string> {
  const id = uuidv7();
  await inTransaction(() =>
    federation.provision({
      id: asId<UserId>(id),
      email,
      emailNormalized: email.toLowerCase(),
      displayName: email,
      providerId: asId(providerId),
      externalId: `ext-${id.slice(-12)}`,
      roleKeys,
      at: FIXED_NOW,
    }),
  );
  return id;
}

async function permissionsOf(email: string): Promise<readonly string[]> {
  const credential = await inTransaction(() => credentials.findByEmail(email.toLowerCase()));
  return [...(credential?.permissions ?? [])].sort();
}

async function assignedRoleCount(userId: string): Promise<number> {
  return owner.userRole.count({ where: { userId } });
}

beforeAll(async () => {
  if (!OWNER_URL || !APP_URL) {
    throw new Error('DATABASE_URL and DATABASE_MIGRATION_URL must both be set.');
  }

  const provisioned = await provisioning.provision({
    slug: PROVISION_SLUG,
    name: 'Federated Roles Test',
    adminEmail: 'root@federated-roles.test',
    adminPassword: 'correct-horse-battery-staple-42',
    adminDisplayName: 'Root Administrator',
  });
  tenantId = provisioned.tenantId;
  adminId = provisioned.adminUserId;

  providerId = uuidv7();
  await owner.identityProvider.create({
    data: {
      id: providerId,
      tenantId,
      name: 'Test IdP',
      issuer: 'https://idp.federated-roles.test',
      discoveryUrl: 'https://idp.federated-roles.test/.well-known/openid-configuration',
      clientId: 'client',
      clientSecret: 'secret',
      domains: ['federated-roles.test'],
      defaultRoleKeys: [MAPPED_KEY],
      enabled: true,
    },
  });
}, 180_000);

afterAll(async () => {
  await owner.$disconnect();
  await prisma.disconnectAll();
});

describe('the sequence a tenant can actually perform', () => {
  let originalRoleId: string;
  let originalRoleVersion: number;
  let replacementRoleId: string;

  it('grants the mapped role while it is live, so the rest is about deletion and not about mapping', async () => {
    // The positive state first. Every assertion below is an absence, and an absence proves nothing
    // if the mapping never worked — this is the test that stops the others passing vacuously.
    const created = await asAdmin(() =>
      roles.create({ key: MAPPED_KEY, name: 'Contractors', permissions: [WITHDRAWN] }),
    );
    originalRoleId = created.id;
    originalRoleVersion = created.version;

    const email = 'while-live@federated-roles.test';
    const userId = await federate(email, [MAPPED_KEY]);

    expect(await assignedRoleCount(userId)).toBe(1);
    expect(await permissionsOf(email)).toEqual([WITHDRAWN]);
  });

  it('lets the tenant delete the role and reuse its key, which is what makes this reachable', async () => {
    /*
     * Not incidental setup — this is the premise. `roleKeyTaken` filters `deletedAt: null` and
     * `uq_role_tenant_key` is partial, so PostgreSQL itself permits two rows under one key.
     *
     * The holder is detached first because `RoleAdminService.delete` refuses while `memberCount > 0`
     * — "Remove this role from everyone holding it first" — which is the tenant's own sequence, and
     * it is also why the administrative path alone can never strand somebody on a deleted role.
     * Only the federated writer could, which is the defect.
     */
    await owner.userRole.deleteMany({ where: { roleId: originalRoleId } });
    await asAdmin(() => roles.delete(originalRoleId, originalRoleVersion));

    const replacement = await asAdmin(() =>
      roles.create({ key: MAPPED_KEY, name: 'Contractors (new)', permissions: [REPLACEMENT] }),
    );
    replacementRoleId = replacement.id;

    const bothRows = await owner.role.count({ where: { tenantId, key: MAPPED_KEY } });
    expect(bothRows, 'the database refused the collision this test exists to cover').toBe(2);
    expect(replacementRoleId).not.toBe(originalRoleId);
  });

  it('keeps the withdrawn role’s permissions on the withdrawn row', async () => {
    // `setRoleDeleted` stamps the role and nothing else. Stated as a fact of the schema rather than
    // left implicit, because it is the reason a stale assignment is dangerous rather than empty.
    const kept = await owner.rolePermission.count({
      where: { roleId: originalRoleId, permission: WITHDRAWN },
    });
    expect(kept).toBe(1);
  });

  it('grants only the replacement to somebody who arrives afterwards', async () => {
    /*
     * The defect, in one assertion. Before Slice 22 this person was assigned *both* rows and their
     * token carried `document:delete` — a permission this tenant had just deleted the role to
     * remove — alongside the replacement's `document:view`.
     */
    const email = 'after-deletion@federated-roles.test';
    const userId = await federate(email, [MAPPED_KEY]);

    expect(
      await assignedRoleCount(userId),
      'both the live and the withdrawn row were assigned',
    ).toBe(1);
    expect(await permissionsOf(email)).toEqual([REPLACEMENT]);
  });

  it('grants nothing at all when every mapped key names a withdrawn role', async () => {
    // The simpler half, and the one that needs no key reuse: delete the role, leave the mapping
    // alone, and the next arrival must be dropped exactly as an unknown key is.
    const orphaned = await asAdmin(() =>
      roles.create({ key: 'seasonal', name: 'Seasonal', permissions: [Permission.DOCUMENT_PRINT] }),
    );
    await asAdmin(() => roles.delete(orphaned.id, orphaned.version));

    const email = 'orphaned-mapping@federated-roles.test';
    const userId = await federate(email, ['seasonal']);

    expect(await assignedRoleCount(userId)).toBe(0);
    expect(await permissionsOf(email)).toEqual([]);
  });

  it('still drops a key that never named anything, which is the behaviour this must not change', async () => {
    const email = 'unknown-key@federated-roles.test';
    const userId = await federate(email, ['no-such-role-key']);

    expect(await assignedRoleCount(userId)).toBe(0);
  });
});

describe('a withdrawn role grants nothing however the assignment got there', () => {
  it('drops it from the permissions a sign-in resolves', async () => {
    /*
     * The second half, tested through a row the writer above can no longer produce: assigned while
     * the role was live, then withdrawn underneath the holder.
     *
     * `RoleAdminService.delete` refuses while `memberCount > 0`, so the administrative path cannot
     * reach this state — which is exactly why it is written here directly. It is the state every
     * pre-fix federated sign-in left behind, and the filter in `PrismaCredentialRepository` is what
     * makes those rows inert instead of permanent.
     */
    const doomed = await asAdmin(() =>
      roles.create({
        key: 'withdrawn-underneath',
        name: 'Withdrawn Underneath',
        permissions: [Permission.LEGAL_HOLD_MANAGE],
      }),
    );

    const email = 'holder@federated-roles.test';
    const userId = uuidv7();
    await owner.user.create({
      data: {
        id: userId,
        tenantId,
        email,
        emailNormalized: email,
        displayName: 'Holder',
        status: 'ACTIVE',
        roles: { create: [{ tenantId, roleId: doomed.id }] },
      },
    });

    expect(await permissionsOf(email)).toEqual([Permission.LEGAL_HOLD_MANAGE]);

    await owner.role.update({
      where: { id: doomed.id },
      data: { deletedAt: FIXED_NOW },
    });

    // The assignment is still on the row — nothing detaches it — and it now grants nothing.
    expect(await assignedRoleCount(userId)).toBe(1);
    expect(await permissionsOf(email)).toEqual([]);
  });

  it('gives them back when the role is restored', async () => {
    // Restoring must need no compensation: the stamp is cleared and the next refresh resolves the
    // permissions again. A fix that stripped `user_role` rows instead would have lost this.
    const role = await owner.role.findFirstOrThrow({
      where: { tenantId, key: 'withdrawn-underneath' },
      select: { id: true },
    });
    await owner.role.update({ where: { id: role.id }, data: { deletedAt: null } });

    expect(await permissionsOf('holder@federated-roles.test')).toEqual([
      Permission.LEGAL_HOLD_MANAGE,
    ]);
  });
});
