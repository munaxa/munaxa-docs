import 'reflect-metadata';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DocsFeature, Permission, SystemRole, type TenantId, type UserId } from '@edms/domain';
import { uuidv7 } from '@edms/utils';
import type { EntitlementSnapshot } from '@munaxa/licensing';

import type { AppConfig } from '../../../core/config/configuration';
import type { Logger } from '../../../core/observability/logger';
import { PrismaUnitOfWork, requireTransaction } from '../../../core/prisma/unit-of-work';
import { type RequestContext, runWithContext } from '../../../core/tenancy/tenant-context';
import { entitlementsWith } from '../../../testing/licensing';
import { realAclResolver, realWriteStack } from '../../../testing/real-collaborators';
import { everyTenantRegistry, sharedDatabase } from '../../../testing/tenant-database';
import { FakeCache } from '../../../testing/fake-ports';
import { UserAdminService } from '../application/user-admin.service';
import { ProvisioningService } from '../application/provisioning.service';
import { PrismaIdentityAdminRepository } from '../infrastructure/prisma-identity-admin.repository';
import { PrismaProvisioningRepository } from '../infrastructure/prisma-provisioning.repository';
import { ScryptPasswordHasher } from '../infrastructure/scrypt-password-hasher';
import type {
  EntitlementLookup,
  EntitlementLookupResult,
} from '../../../core/licensing/licensing.ports';
import { PrismaEntitlementStateStore } from '../../../core/licensing/prisma-entitlement-state.store';

/**
 * Licensing against the real database — ADR-0026.
 *
 * Two properties a unit test cannot show: that the seat limit holds when requests race (the
 * advisory lock serialises the count and the commit), and that `entitlement_state` keeps its
 * observed instant monotonic under the application role and row-level security.
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
const NOW = new Date('2026-06-01T09:00:00.000Z');
const clock = { now: () => new Date(NOW), timestamp: () => 0, elapsedMs: () => 0 };

const prisma = sharedDatabase(config, logger, APP_URL);
const unitOfWork = new PrismaUnitOfWork(prisma);
const { stamps, writer, audit } = realWriteStack(clock, unitOfWork);
const passwords = new ScryptPasswordHasher();
const cache = new FakeCache(clock);

const SLUG = `licensing-${String(Date.now())}`;
const PROVISION_TENANT = uuidv7();
const provisioning = new ProvisioningService(
  new PrismaProvisioningRepository(),
  passwords,
  clock,
  unitOfWork,
  audit,
  everyTenantRegistry(APP_URL, { [SLUG]: PROVISION_TENANT }),
);

let tenantId: TenantId;
let adminId: UserId;

function asAdmin<T>(work: () => Promise<T>): Promise<T> {
  const context: RequestContext = {
    tenantId,
    userId: adminId,
    roles: [SystemRole.TENANT_ADMIN],
    permissions: [Permission.USER_MANAGE],
    sessionId: null,
    correlationId: 'licensing',
    permissionVersion: 1,
    locale: 'en',
  };
  return runWithContext(context, work);
}

/** A plan with a fixed number of seats, answered as the central service would. */
function planWithSeats(seats: number): EntitlementLookup {
  return {
    source: 'CONTROL_PLANE',
    cachesSnapshots: true,
    lookup: (tenant): Promise<EntitlementLookupResult> =>
      Promise.resolve({
        kind: 'SNAPSHOT',
        snapshot: {
          schemaVersion: 1,
          customerId: 'cus_licensing',
          tenantId: tenant,
          product: 'docs',
          deployment: 'SAAS',
          subscriptionId: 'sub_licensing',
          plan: { code: 'team', version: 1 },
          status: 'ACTIVE',
          trialEndsAt: null,
          expiresAt: '2027-01-01T00:00:00.000Z',
          graceUntil: null,
          features: [DocsFeature.WEBHOOKS],
          limits: { users: seats, 'storage.bytes': null },
          resolvedAt: NOW.toISOString(),
        } satisfies EntitlementSnapshot,
      }),
  };
}

const store = new PrismaEntitlementStateStore(unitOfWork);

function usersUnder(seats: number): UserAdminService {
  return new UserAdminService(
    new PrismaIdentityAdminRepository(stamps, cache),
    passwords,
    writer,
    realAclResolver({ clock, unitOfWork, config, cache }),
    entitlementsWith({ lookup: planWithSeats(seats), store, clock }),
  );
}

beforeAll(async () => {
  if (!OWNER_URL || !APP_URL)
    throw new Error('DATABASE_URL and DATABASE_MIGRATION_URL must both be set.');
  const provisioned = await provisioning.provision({
    slug: SLUG,
    name: 'Licensing Test',
    adminEmail: 'root@licensing.test',
    adminPassword: 'correct-horse-battery-staple-42',
    adminDisplayName: 'Root Administrator',
  });
  tenantId = provisioned.tenantId;
  adminId = provisioned.adminUserId;
});

afterAll(async () => {
  await prisma.onModuleDestroy();
});

describe('the seat limit, under concurrency', () => {
  it('ten simultaneous invitations against three free seats create exactly three', async () => {
    // The administrator holds one seat already, so a plan of four leaves three.
    const users = usersUnder(4);
    const attempts = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        asAdmin(() =>
          users.create({
            email: `seat-${String(i)}@licensing.test`,
            displayName: `Seat ${String(i)}`,
            roleIds: [],
            departments: [],
          }),
        ),
      ),
    );
    const created = attempts.filter((a) => a.status === 'fulfilled');
    const refused = attempts.filter((a): a is PromiseRejectedResult => a.status === 'rejected');
    expect(created).toHaveLength(3);
    expect(refused).toHaveLength(7);
    for (const r of refused) {
      expect(r.reason).toMatchObject({
        code: 'SUBSCRIPTION_REQUIRED',
        details: { reason: 'QUOTA_EXCEEDED', limit: 'users' },
      });
    }
    const counted = await asAdmin(() =>
      unitOfWork.run(() => new PrismaIdentityAdminRepository(stamps, cache).licensedUserCount()),
    );
    expect(counted).toBe(4);
  });

  it('a disabled account frees its seat, and re-enabling it needs one again', async () => {
    const users = usersUnder(4);
    const someone = await asAdmin(() =>
      users.create({
        email: 'later@licensing.test',
        displayName: 'Later',
        roleIds: [],
        departments: [],
      }),
    ).catch(() => null);
    // The plan is full from the previous test, so this one is refused too…
    expect(someone).toBeNull();
    // …until somebody is disabled.
    const page = await asAdmin(() =>
      users.list({ page: 1, pageSize: 50, search: 'seat-', sortDirection: 'asc', deleted: 'live' }),
    );
    const [first] = page.data;
    if (first === undefined) throw new Error('expected a created user');
    await asAdmin(() => users.setPassword(first.id, 'correct-horse-battery-staple-43', undefined));
    const live = await asAdmin(() => users.get(first.id));
    const disabled = await asAdmin(() => users.setStatus(first.id, 'DISABLED', live.version));
    await asAdmin(() =>
      users.create({
        email: 'replacement@licensing.test',
        displayName: 'Replacement',
        roleIds: [],
        departments: [],
      }),
    );
    await expect(
      asAdmin(() => users.setStatus(first.id, 'ACTIVE', disabled.version)),
    ).rejects.toMatchObject({ code: 'SUBSCRIPTION_REQUIRED' });
  });
});

describe('entitlement_state', () => {
  it('stores the snapshot under the tenant and never moves the observed instant backwards', async () => {
    await asAdmin(async () => {
      await store.write(tenantId, {
        snapshot: null,
        source: 'CONTROL_PLANE',
        observedAt: new Date('2026-07-01T00:00:00Z'),
      });
      await store.write(tenantId, {
        snapshot: null,
        source: 'CONTROL_PLANE',
        observedAt: new Date('2026-01-01T00:00:00Z'),
      });
      const state = await store.read(tenantId);
      expect(state?.lastObservedAt.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    });
  });

  it('keeps the revocation list with the higher sequence only, through later snapshot writes', async () => {
    await asAdmin(async () => {
      await store.writeRevocationList(tenantId, 'list-5', 5);
      await store.writeRevocationList(tenantId, 'list-3', 3);
      expect((await store.read(tenantId))?.revocationList).toBe('list-5');
      await store.writeRevocationList(tenantId, 'list-6', 6);
      await store.write(tenantId, {
        snapshot: null,
        source: 'LICENSE_FILE',
        observedAt: new Date('2026-08-01T00:00:00Z'),
      });
      expect((await store.read(tenantId))?.revocationList).toBe('list-6');
    });
  });

  it('refuses a list without its sequence, and a sequence below one', async () => {
    const update = (sql: 'pair' | 'zero') =>
      asAdmin(() =>
        unitOfWork.run(() =>
          sql === 'pair'
            ? requireTransaction()
                .$executeRaw`UPDATE entitlement_state SET revocation_list = 'x', revocation_sequence = NULL WHERE tenant_id = ${tenantId}::uuid`
            : requireTransaction()
                .$executeRaw`UPDATE entitlement_state SET revocation_list = 'x', revocation_sequence = 0 WHERE tenant_id = ${tenantId}::uuid`,
        ),
      );
    await expect(update('pair')).rejects.toThrow(/ck_entitlement_state_revocation_pair/);
    await expect(update('zero')).rejects.toThrow(/ck_entitlement_state_revocation_sequence/);
  });
});
