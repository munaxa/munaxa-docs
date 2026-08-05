import 'reflect-metadata';

import { PrismaClient } from '@prisma/client';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  ApprovalTaskState,
  Disposition,
  DocumentStatus,
  Permission,
  RetentionTrigger,
  type TenantId,
  type UserId,
  asId,
} from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import type { AppConfig } from '../../../core/config/configuration';
import type { Logger } from '../../../core/observability/logger';
import { TenantDatabase } from '../../../core/prisma/tenant-database';
import { PrismaUnitOfWork } from '../../../core/prisma/unit-of-work';
import { type RequestContext, runWithContext } from '../../../core/tenancy/tenant-context';
import { type DashboardStack, realDashboard } from '../../../testing/real-collaborators';
import { everyTenantRegistry } from '../../../testing/tenant-database';
import type {
  DashboardDelegationMetrics,
  DashboardNotificationMetrics,
} from '../application/ports';

/**
 * Phase 13 against a real PostgreSQL — the assertions only a database can be trusted about.
 *
 * Every one of these is a question about rows *at an instant*, which is exactly what a repository
 * double cannot be asked: a double answers from the same belief as the code under test, and the
 * whole claim of this phase is that the dashboard's beliefs are *somebody else's* — the list's, the
 * inbox's, the resolver's.
 *
 * - **A count matches the list it summarises.** Not approximately, and not by inspection: the tile
 *   and the list are compared row for row, against the same repository the library serves from.
 * - **The same count computed for a caller who may see less returns less.** Two people, the same
 *   query, different answers — because every user widget's predicate names the caller.
 * - **A widget whose permission the caller does not hold answers `FORBIDDEN`, never `READY: 0`.**
 *   Those are different answers and the difference is the disclosure. Asserted against the *real*
 *   `PrismaAclResolver` over real role grants, not a stub — a stubbed resolver would be asserting
 *   the test's own belief about permissions.
 * - **The activity feed shows only what its reader may see** — the caller's own acts, from the real
 *   audit trail through the real `ACTIVITY_READER`, with somebody else's events in the same table.
 * - **The whole dashboard composes in a bounded number of queries**, counted at the driver, so a
 *   widget added as one-query-per-row fails here rather than in production on the busiest route in
 *   the product.
 * - **"Overdue" has one definition.** The dashboard's number and the inbox's predicate are the same
 *   function, which is the module README's rule made falsifiable.
 */

const OWNER_URL = process.env['DATABASE_MIGRATION_URL'] ?? '';
const APP_URL = process.env['DATABASE_URL'] ?? '';

const NOW = new Date('2026-08-05T09:00:00.000Z');
const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const TENANT = asId<TenantId>(uuidv7());
/** Owns documents, holds a lock, has an inbox. An ordinary person. */
const ADA = asId<UserId>(uuidv7());
/** A second ordinary person, so "the caller's own" can be shown to mean somebody in particular. */
const BOB = asId<UserId>(uuidv7());
/** Holds every tile permission — the administrator half's granted case. */
const ADMIN = asId<UserId>(uuidv7());

let owner: PrismaClient;
let unitOfWork: PrismaUnitOfWork;
let stack: DashboardStack;

/** Counted at the driver, so "a bounded number of queries" is measured rather than believed. */
let queryCount = 0;

/** Frozen, because three widgets ask a question about an instant — a live lock, a deadline, a due
 *  schedule — and a suite whose fixtures sit an hour either side of a moving "now" tests the
 *  wall clock rather than the code. */
const clock = { now: () => NOW, timestamp: () => 0, elapsedMs: () => 0 };

const scaffold = {
  libraryId: uuidv7(),
  folderId: uuidv7(),
  documentTypeId: uuidv7(),
  confidentialityId: uuidv7(),
  numberingRuleId: uuidv7(),
  companyId: uuidv7(),
  entityId: uuidv7(),
  definitionId: uuidv7(),
  versionId: uuidv7(),
  instanceId: uuidv7(),
  revisionId: uuidv7(),
  fileObjectId: uuidv7(),
};

/** Ada's documents, by the status each dashboard tile counts. */
const ADA_DRAFTS = 3;
const ADA_REJECTED = 2;
const BOB_DRAFTS = 1;

function contextFor(userId: UserId, roles: readonly string[] = []): RequestContext {
  return {
    tenantId: TENANT,
    userId,
    roles: [...roles],
    // Deliberately empty: the administrator tiles are gated through the ACL resolver over real role
    // grants, not through the token's snapshot. A test that filled this in would be asserting that
    // the service reads the field it must not read.
    permissions: [],
    sessionId: null,
    correlationId: 'dashboard-integration',
    permissionVersion: 1,
    locale: 'en',
  };
}

function as<T>(userId: UserId, roles: readonly string[], work: () => Promise<T>): Promise<T> {
  return runWithContext(contextFor(userId, roles), work);
}

/** Delegation and notifications, stood in for: this suite is about what the dashboard does with
 *  their answers, and each has its own suite proving it reads its own tables. The *visibility* half
 *  is emphatically not stubbed — the ACL resolver below is the real one. */
const noDelegations: DashboardDelegationMetrics = {
  coveredBy: () => Promise.resolve([]),
  activeFor: () => Promise.resolve([]),
};
const unread: DashboardNotificationMetrics = {
  unreadCount: () => Promise.resolve(7),
};

/**
 * Enough configuration for the collaborators this suite builds.
 *
 * `acl` joined it in Phase 14, with the cache off: every count here is asserted against the list it
 * summarises in the same test, and a cached decision between the two would make the assertion a
 * statement about the cache rather than about the predicate.
 */
const appConfig = {
  env: 'test',
  database: { url: APP_URL, poolSize: 10 },
  acl: { cacheTtlSeconds: 0, maxSubjectEntries: 5_000 },
} as unknown as AppConfig;

beforeAll(async () => {
  if (!OWNER_URL || !APP_URL) {
    throw new Error('DATABASE_URL and DATABASE_MIGRATION_URL must both be set.');
  }

  // A tenant database whose client counts every model operation it performs. Prisma's own query
  // log needs the client to be constructed with event logging, and the production one is not — so
  // the count comes from a client extension over the same connection instead, which counts the
  // statements the code under test actually issues rather than the calls this test believes it made.
  unitOfWork = new PrismaUnitOfWork(new CountingDatabase(appConfig, logger, APP_URL));
  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });

  await seed();

  stack = realDashboard({
    clock,
    unitOfWork,
    config: appConfig,
    delegations: noDelegations,
    notifications: unread,
  });
}, 120_000);

describe('a user widget counts the caller’s own rows, and the list agrees', () => {
  it('answers the same number the document list answers for the same filter', async () => {
    const view = await as(ADA, [], () => stack.dashboard.userDashboard(ADA));

    // The list, through the repository the library itself serves from — not through a second query
    // written here, which would only prove this test can count.
    const drafts = await as(ADA, [], () =>
      unitOfWork.run(() =>
        stack.documents.list({
          page: 1,
          pageSize: 100,
          deleted: 'live',
          sortDirection: 'desc',
          ownerUserId: ADA,
          status: DocumentStatus.DRAFT,
        }),
      ),
    );

    expect(view.drafts.state).toBe('READY');
    expect(view.drafts.value).toBe(ADA_DRAFTS);
    expect(view.drafts.value).toBe(drafts.meta.total);
    expect(drafts.data).toHaveLength(ADA_DRAFTS);
    expect(view.rejected.value).toBe(ADA_REJECTED);
  });

  it('answers a different, smaller number for a caller who owns less', async () => {
    const ada = await as(ADA, [], () => stack.dashboard.userDashboard(ADA));
    const bob = await as(BOB, [], () => stack.dashboard.userDashboard(BOB));

    // The point is not that Bob's number is small. It is that the *same* widget, computed with the
    // same code, answers about the caller and nobody else — which is what makes "every user widget
    // is a query the caller could already run" true rather than merely stated.
    expect(ada.drafts.value).toBe(ADA_DRAFTS);
    expect(bob.drafts.value).toBe(BOB_DRAFTS);
    expect(bob.drafts.value).toBeLessThan(ada.drafts.value ?? 0);
    expect(bob.rejected.value).toBe(0);
  });

  it('counts only live check-out locks, and only the caller’s', async () => {
    const ada = await as(ADA, [], () => stack.dashboard.userDashboard(ADA));
    const bob = await as(BOB, [], () => stack.dashboard.userDashboard(BOB));

    // Ada holds two locks in the table and one of them expired an hour ago. An expired lock excludes
    // nobody and the next operation on the document sweeps it aside, so counting it would tell
    // somebody they still hold a claim the product has already let go of.
    expect(ada.checkedOut.value).toBe(1);
    expect(bob.checkedOut.value).toBe(0);

    // And the list filter agrees with the count, which is what makes the tile's link honest.
    const listed = await as(ADA, [], () =>
      unitOfWork.run(() =>
        stack.documents.list({
          page: 1,
          pageSize: 100,
          deleted: 'live',
          sortDirection: 'desc',
          lockedByMe: true,
        }),
      ),
    );
    expect(listed.meta.total).toBe(ada.checkedOut.value);
  });

  it('counts pending and overdue through the inbox’s own predicate', async () => {
    const view = await as(ADA, [], () => stack.dashboard.userDashboard(ADA));

    // Three pending tasks, one of them past its deadline. "Overdue" is a subset of "pending", and
    // both are `approvalTaskWhere` — the function the inbox builds its query from. There is exactly
    // one `dueAt < now` in the workflow module and this is counting through it.
    expect(view.pending.value).toBe(3);
    expect(view.overdue.value).toBe(1);

    // Bob is assigned nothing, and the answer is zero rather than the tenant's total — the case
    // that would silently turn a personal widget into a disclosure of everybody's workload.
    const bob = await as(BOB, [], () => stack.dashboard.userDashboard(BOB));
    expect(bob.pending.value).toBe(0);
    expect(bob.overdue.value).toBe(0);
  });

  it('renders an unbound optional capability as unavailable rather than as zero', async () => {
    // A composition running without notifications — the deployment shape the optional injection
    // exists for.
    const { dashboard: withoutNotifications } = realDashboard({
      clock,
      unitOfWork,
      config: appConfig,
      delegations: noDelegations,
      notifications: null,
    });

    const view = await as(ADA, [], () => withoutNotifications.userDashboard(ADA));

    // A deployment without notifications has no unread count. It does not have an unread count of
    // zero, and a badge reading "0" would be the product asserting something it cannot know.
    expect(view.unreadNotifications.state).toBe('UNAVAILABLE');
    expect(view.unreadNotifications.value).toBeNull();

    const bound = await as(ADA, [], () => stack.dashboard.userDashboard(ADA));
    expect(bound.unreadNotifications).toEqual({ state: 'READY', value: 7 });
  });
});

describe('an administrator widget is absent rather than zero when the caller may not ask', () => {
  it('refuses every tile to a caller holding none of the permissions', async () => {
    const view = await as(ADA, [adaRoleId], () => stack.dashboard.administratorDashboard());

    expect(view.anyGranted).toBe(false);
    // `FORBIDDEN`, not `READY: 0`. "You may not ask" is a statement about the caller; "there are
    // none" is a statement about the tenant, and the tenant demonstrably has documents — so a zero
    // here would be both a lie and a disclosure of the shape of what is hidden.
    for (const tile of [
      view.documents,
      view.workflow,
      view.approvals,
      view.storage,
      view.users,
      view.departments,
      view.dispositionsDue,
      view.legalHolds,
    ]) {
      expect(tile.state).toBe('FORBIDDEN');
      expect(tile.value).toBeNull();
    }
  });

  it('answers every tile to a caller who holds them, with the tenant’s real figures', async () => {
    const view = await as(ADMIN, [adminRoleId], () => stack.dashboard.administratorDashboard());

    expect(view.anyGranted).toBe(true);
    expect(view.documents.state).toBe('READY');
    // Every live document in the tenant, both people's — which is exactly what makes this tile the
    // one that needs a permission and the user tiles the ones that do not.
    expect(view.documents.value?.total).toBe(ADA_DRAFTS + ADA_REJECTED + BOB_DRAFTS);
    expect(view.documents.value?.entries).toContainEqual({
      key: DocumentStatus.DRAFT,
      count: ADA_DRAFTS + BOB_DRAFTS,
    });

    expect(view.approvals.value).toEqual({ pending: 3, overdue: 1 });
    expect(view.workflow.value?.total).toBe(1);
    expect(view.users.value?.total).toBe(3);
    expect(view.departments.value).toBe(2);
    expect(view.dispositionsDue.value).toBe(1);
    expect(view.legalHolds.value).toBe(1);
  });

  it('reports storage as bytes held and bytes deduplication saved, and never as a quota', async () => {
    const view = await as(ADMIN, [adminRoleId], () => stack.dashboard.administratorDashboard());

    const usage = view.storage.value;
    expect(usage).not.toBeNull();
    // One blob of 1000 bytes with three references: stored once, referenced three times. The gap is
    // what content addressing saved, and it is the only storage claim this phase can make that is
    // arithmetic over rows rather than a policy.
    expect(usage?.blobCount).toBe(1);
    expect(usage?.storedBytes).toBe(1_000);
    expect(usage?.referencedBytes).toBe(3_000);
    expect(usage?.unreferencedBlobs).toBe(0);
    // No quota, no percentage, no limit — Phase 10's deliberate absence, kept.
    expect(Object.keys(usage ?? {}).sort()).toEqual([
      'blobCount',
      'referencedBytes',
      'storedBytes',
      'unreferencedBlobs',
    ]);
  });

  it('gates the two retention figures on two different permissions', async () => {
    // The disposition queue is a records-management workload; the hold register is counsel's
    // business, and the retention controller already reads holds behind the same grant as writing
    // them. A dashboard that leaked the hold count under the looser permission would undo that.
    const view = await as(ADA, [retentionOnlyRoleId], () =>
      stack.dashboard.administratorDashboard(),
    );

    expect(view.anyGranted).toBe(true);
    expect(view.dispositionsDue).toEqual({ state: 'READY', value: 1 });
    expect(view.legalHolds.state).toBe('FORBIDDEN');
    expect(view.legalHolds.value).toBeNull();
    // And nothing `report:view` gates leaked in alongside them.
    expect(view.storage.state).toBe('FORBIDDEN');
    expect(view.documents.state).toBe('FORBIDDEN');
  });
});

describe('the activity feed shows only what its reader may see', () => {
  it('is the caller’s own acts, from the trail, with somebody else’s in the same table', async () => {
    const ada = await as(ADA, [], () => stack.dashboard.userDashboard(ADA));
    const bob = await as(BOB, [], () => stack.dashboard.userDashboard(BOB));

    expect(ada.activity.length).toBeGreaterThan(0);
    expect(bob.activity).toHaveLength(1);

    // `forActor(caller)` and nothing else. There is no tenant-wide feed method on `ActivityReader`
    // and this phase deliberately did not add one: a feed of what everybody did is the audit search,
    // already built and already behind `audit:view`.
    expect(ada.activity.every((entry) => entry.action.startsWith('DOCUMENT_'))).toBe(true);
    expect(bob.activity[0]?.action).toBe('DOCUMENT_VIEWED');
    expect(ada.activity.map((entry) => entry.id)).not.toContain(bob.activity[0]?.id);
  });

  it('never returns more rows than a card holds, however long the trail is', async () => {
    const ada = await as(ADA, [], () => stack.dashboard.userDashboard(ADA));
    // Twelve events were written for Ada. A card is eight rows, and an unbounded read here would be
    // the whole of somebody's history fetched on every page load.
    expect(ada.activity.length).toBe(8);
  });
});

describe('the whole dashboard composes in a bounded number of queries', () => {
  it('costs the same for a tenant with ten times the rows', async () => {
    const measure = async (): Promise<{ user: number; administrator: number }> => {
      queryCount = 0;
      await as(ADA, [], () => stack.dashboard.userDashboard(ADA));
      const user = queryCount;
      queryCount = 0;
      await as(ADMIN, [adminRoleId], () => stack.dashboard.administratorDashboard());
      return { user, administrator: queryCount };
    };

    const before = await measure();

    // Ten times the documents and ten times the trail. Every metric is an aggregate, so the query
    // count must not move at all — not "grow slowly", not "stay within a factor". A widget written
    // as one query per row is the failure this asserts against, and it would move by sixty.
    for (let index = 0; index < 60; index += 1) {
      await document(ADA, DocumentStatus.DRAFT, `Bulk draft ${String(index)}`);
    }
    await seedTrail();

    const after = await measure();

    expect(after.user).toBe(before.user);
    expect(after.administrator).toBe(before.administrator);

    // And the figures themselves are small: seven reads for the user half, and eleven for the
    // administrator's eight tiles plus the one resolver call that gates them.
    expect(before.user).toBeLessThanOrEqual(9);
    expect(before.administrator).toBeLessThanOrEqual(13);

    // The answers moved even though the cost did not — otherwise this would pass against a
    // dashboard that had stopped reading anything.
    const grown = await as(ADA, [], () => stack.dashboard.userDashboard(ADA));
    expect(grown.drafts.value).toBe(ADA_DRAFTS + 60);
  });

  it('degrades one widget rather than the page when a source fails', async () => {
    const { dashboard: broken } = realDashboard({
      clock,
      unitOfWork,
      config: appConfig,
      delegations: noDelegations,
      notifications: unread,
      // Only the document source is broken. Everything else is the real adapter over the real
      // database, which is what makes "the rest of the page still renders" an assertion rather
      // than a tautology.
      documentMetrics: {
        countsForOwner: () => Promise.reject(new Error('the documents read is down')),
        countCheckedOutBy: () => Promise.reject(new Error('the documents read is down')),
        countFavorites: () => Promise.reject(new Error('the documents read is down')),
        recentDocumentIds: () => Promise.reject(new Error('the documents read is down')),
        countsByStatus: () => Promise.reject(new Error('the documents read is down')),
      },
    });

    const view = await as(ADA, [], () => broken.userDashboard(ADA));

    // The document tiles say they could not be loaded — `UNAVAILABLE`, distinct from `FORBIDDEN`,
    // so nobody is sent to ask for a permission they already hold.
    expect(view.drafts.state).toBe('UNAVAILABLE');
    expect(view.drafts.value).toBeNull();
    expect(view.checkedOut.state).toBe('UNAVAILABLE');

    // And everything whose source is healthy still answers. This is the property that needs a
    // transaction per widget: composed inside one, the first rejection would abort the rest.
    expect(view.pending).toEqual({ state: 'READY', value: 3 });
    expect(view.unreadNotifications).toEqual({ state: 'READY', value: 7 });
  });
});

/**
 * The tenant database, with a counter on it.
 *
 * `withTenant` resolves its client through `clientFor`, so overriding that is enough to put an
 * extension in the path of every statement — including the ones inside a repository, which is where
 * an N+1 would hide. Counting at the composition layer instead would count the calls this suite
 * expects rather than the queries the product runs.
 */
class CountingDatabase extends TenantDatabase {
  private client: PrismaClient | null = null;

  constructor(
    config: AppConfig,
    log: Logger,
    private readonly url: string,
  ) {
    super(config, log, everyTenantRegistry(url));
  }

  override async clientFor(): Promise<PrismaClient> {
    if (this.client === null) {
      const base = new PrismaClient({ datasources: { db: { url: this.url } } });
      await base.$connect();
      this.client = base.$extends({
        query: {
          $allModels: {
            async $allOperations({ query, args }) {
              queryCount += 1;
              return query(args);
            },
          },
        },
      }) as unknown as PrismaClient;
    }
    return this.client;
  }
}

// --- Fixtures ---------------------------------------------------------------------------------
//
// Written with the owner client, which is the cluster superuser and therefore past RLS — the same
// shape CI uses, and the only way to seed two people's rows without signing in as each of them.

let adaRoleId: string;
let adminRoleId: string;
let retentionOnlyRoleId: string;

async function seed(): Promise<void> {
  await owner.tenant.create({
    data: {
      id: TENANT,
      // From the run's own tenant id, which is fresh per run: a slug built from a fixed clock
      // would collide with whatever a previous failed run left behind.
      slug: `dash-${TENANT.replaceAll('-', '').slice(-16)}`,
      name: 'Dashboard Test',
      status: 'ACTIVE',
    },
  });

  // Three roles, because the administrator half's whole assertion is about which grants a caller
  // holds — and the resolver reads `role_permission`, so the grants have to be real rows.
  const roles = await Promise.all([
    role('reader', [Permission.DOCUMENT_VIEW]),
    role('admin', [
      Permission.DOCUMENT_VIEW,
      Permission.REPORT_VIEW,
      Permission.USER_MANAGE,
      Permission.ORG_MANAGE,
      Permission.RETENTION_MANAGE,
      Permission.LEGAL_HOLD_MANAGE,
    ]),
    role('retention', [Permission.DOCUMENT_VIEW, Permission.RETENTION_MANAGE]),
  ]);
  adaRoleId = roles[0];
  adminRoleId = roles[1];
  retentionOnlyRoleId = roles[2];

  for (const [id, name] of [
    [ADA, 'ada'],
    [BOB, 'bob'],
    [ADMIN, 'admin'],
  ] as const) {
    await owner.user.create({
      data: {
        id,
        tenantId: TENANT,
        email: `${name}-${TENANT.slice(0, 8)}@dashboard.test`,
        emailNormalized: `${name}-${TENANT.slice(0, 8)}@dashboard.test`,
        displayName: name,
        status: 'ACTIVE',
        updatedAt: NOW,
      },
    });
  }

  await owner.company.create({
    data: { id: scaffold.companyId, tenantId: TENANT, code: 'C1', name: 'Company', updatedAt: NOW },
  });
  await owner.entity.create({
    data: {
      id: scaffold.entityId,
      tenantId: TENANT,
      companyId: scaffold.companyId,
      code: 'E1',
      name: 'Entity',
      updatedAt: NOW,
    },
  });
  for (const [index, code] of ['D1', 'D2'].entries()) {
    await owner.department.create({
      data: {
        id: uuidv7(),
        tenantId: TENANT,
        entityId: scaffold.entityId,
        code,
        name: `Department ${String(index + 1)}`,
        path: `dep${String(index + 1)}`,
        updatedAt: NOW,
      },
    });
  }

  await owner.confidentialityLevel.create({
    data: {
      id: scaffold.confidentialityId,
      tenantId: TENANT,
      code: 'INTERNAL',
      name: 'Internal',
      rank: 1,
      updatedAt: NOW,
    },
  });
  await owner.numberingRule.create({
    data: {
      id: scaffold.numberingRuleId,
      tenantId: TENANT,
      key: 'default',
      name: 'Default',
      segments: [],
      updatedAt: NOW,
    },
  });
  await owner.documentType.create({
    data: {
      id: scaffold.documentTypeId,
      tenantId: TENANT,
      code: 'PROC',
      name: 'Procedure',
      numberingRuleId: scaffold.numberingRuleId,
      defaultConfidentialityId: scaffold.confidentialityId,
      updatedAt: NOW,
    },
  });
  await owner.library.create({
    data: {
      id: scaffold.libraryId,
      tenantId: TENANT,
      code: 'LIB',
      name: 'Library',
      ownerScopeType: 'TENANT',
      updatedAt: NOW,
    },
  });
  await owner.folder.create({
    data: {
      id: scaffold.folderId,
      tenantId: TENANT,
      libraryId: scaffold.libraryId,
      name: 'Root',
      path: 'root',
      isRoot: true,
      updatedAt: NOW,
    },
  });

  // One blob with three references: stored once, referenced three times. The storage tile's whole
  // claim is the gap between those two figures.
  await owner.fileObject.create({
    data: {
      id: scaffold.fileObjectId,
      tenantId: TENANT,
      checksumSha256: 'a'.repeat(64),
      sizeBytes: 1_000n,
      mimeType: 'application/pdf',
      storageKey: 'blobs/aa/a',
      storageDriver: 'LOCAL',
      scanStatus: 'CLEAN',
      refCount: 3,
      updatedAt: NOW,
    },
  });

  const adaDocuments: string[] = [];
  for (let index = 0; index < ADA_DRAFTS; index += 1) {
    adaDocuments.push(await document(ADA, DocumentStatus.DRAFT, `Ada draft ${String(index)}`));
  }
  for (let index = 0; index < ADA_REJECTED; index += 1) {
    await document(ADA, DocumentStatus.REJECTED, `Ada rejected ${String(index)}`);
  }
  for (let index = 0; index < BOB_DRAFTS; index += 1) {
    await document(BOB, DocumentStatus.DRAFT, `Bob draft ${String(index)}`);
  }

  const [locked, expired, held] = adaDocuments as [string, string, string];

  // One live lock and one that lapsed an hour ago. The expired one is the assertion: it is still a
  // row with `released_at IS NULL`, and it must not be counted.
  await owner.documentLock.create({
    data: {
      id: uuidv7(),
      tenantId: TENANT,
      documentId: locked,
      lockedBy: ADA,
      acquiredAt: new Date(NOW.getTime() - 3_600_000),
      expiresAt: new Date(NOW.getTime() + 3_600_000),
      updatedAt: NOW,
    },
  });
  await owner.documentLock.create({
    data: {
      id: uuidv7(),
      tenantId: TENANT,
      documentId: expired,
      lockedBy: ADA,
      acquiredAt: new Date(NOW.getTime() - 7_200_000),
      expiresAt: new Date(NOW.getTime() - 3_600_000),
      updatedAt: NOW,
    },
  });

  await owner.retentionSchedule.create({
    data: {
      id: uuidv7(),
      tenantId: TENANT,
      documentId: held,
      trigger: RetentionTrigger.ON_PUBLISH,
      triggerAt: new Date(NOW.getTime() - 86_400_000),
      dueAt: new Date(NOW.getTime() - 3_600_000),
      disposition: Disposition.PURGE,
      state: 'PENDING',
      updatedAt: NOW,
    },
  });
  await owner.legalHold.create({
    data: {
      id: uuidv7(),
      tenantId: TENANT,
      documentId: held,
      reason: 'Matter 2026-01',
      placedById: ADMIN,
      placedAt: NOW,
      updatedAt: NOW,
    },
  });

  await seedApprovals(locked);
  await seedTrail();
}

async function role(name: string, permissions: readonly string[]): Promise<string> {
  const created = await owner.role.create({
    data: {
      id: uuidv7(),
      tenantId: TENANT,
      key: `${name}-${TENANT.replaceAll('-', '').slice(-12)}`,
      name,
      isSystem: false,
      updatedAt: NOW,
      permissions: { create: permissions.map((permission) => ({ tenantId: TENANT, permission })) },
    },
  });
  return created.id;
}

async function document(ownerUserId: UserId, status: string, title: string): Promise<string> {
  const id = uuidv7();
  await owner.document.create({
    data: {
      id,
      tenantId: TENANT,
      folderId: scaffold.folderId,
      documentTypeId: scaffold.documentTypeId,
      confidentialityId: scaffold.confidentialityId,
      title,
      status: status as never,
      ownerUserId,
      updatedAt: NOW,
    },
  });
  return id;
}

/** Three pending tasks for Ada, one of them past its deadline. */
async function seedApprovals(documentId: string): Promise<void> {
  await owner.documentRevision.create({
    data: {
      id: scaffold.revisionId,
      tenantId: TENANT,
      documentId,
      ordinal: 1,
      label: 'A',
      fileObjectId: scaffold.fileObjectId,
      filename: 'a.pdf',
      updatedAt: NOW,
    },
  });
  await owner.workflowDefinition.create({
    data: {
      id: scaffold.definitionId,
      tenantId: TENANT,
      key: 'approval',
      name: 'Approval',
      updatedAt: NOW,
    },
  });
  await owner.workflowVersion.create({
    data: {
      id: scaffold.versionId,
      tenantId: TENANT,
      definitionId: scaffold.definitionId,
      version: 1,
      definition: {},
      // Published, because the database refuses an instance bound to a draft version — the
      // immutability rule Phase 4 put in a trigger rather than in a use case.
      state: 'PUBLISHED',
      publishedAt: NOW,
      updatedAt: NOW,
    },
  });
  await owner.workflowInstance.create({
    data: {
      id: scaffold.instanceId,
      tenantId: TENANT,
      documentId,
      revisionId: scaffold.revisionId,
      definitionId: scaffold.definitionId,
      workflowVersionId: scaffold.versionId,
      state: 'RUNNING',
      startedAt: NOW,
      updatedAt: NOW,
    },
  });
  const deadlines = [
    new Date(NOW.getTime() + 86_400_000),
    new Date(NOW.getTime() + 172_800_000),
    // The overdue one.
    new Date(NOW.getTime() - 3_600_000),
  ];

  // One stage per task, because `uq_approval_task_stage_assignee` allows one task per person per
  // stage — the constraint that makes "asked twice in the same stage" unrepresentable. Three
  // deadlines therefore need three stages, which is also the shape a real sequential workflow has.
  for (const [index, dueAt] of deadlines.entries()) {
    const stageId = uuidv7();
    await owner.workflowStage.create({
      data: {
        id: stageId,
        tenantId: TENANT,
        instanceId: scaffold.instanceId,
        index,
        name: `Review ${String(index + 1)}`,
        completionRule: 'ALL',
        updatedAt: NOW,
      },
    });
    await owner.approvalTask.create({
      data: {
        id: uuidv7(),
        tenantId: TENANT,
        instanceId: scaffold.instanceId,
        stageId,
        assigneeId: ADA,
        resolvedBy: 'USER',
        state: ApprovalTaskState.PENDING,
        dueAt,
        updatedAt: NOW,
      },
    });
  }
}

/**
 * Twelve events for Ada and one for Bob, in one hash chain.
 *
 * The chain's shape does not matter here — Phase 9's suite proves it — but the *rows* do: the feed's
 * assertion is that Ada's card contains none of Bob's, in a table where both are present and where
 * nothing but the actor tells them apart.
 */
let sequence = 0;

async function seedTrail(): Promise<void> {
  const write = async (actorId: UserId, action: string): Promise<void> => {
    sequence += 1;
    await owner.auditEvent.create({
      data: {
        id: uuidv7(),
        tenant: { connect: { id: TENANT } },
        sequence: BigInt(sequence),
        occurredAt: new Date(NOW.getTime() - sequence * 60_000),
        actorId,
        action,
        subjectType: 'DOCUMENT',
        subjectId: scaffold.folderId,
        outcome: 'SUCCESS',
        channel: 'WEB',
        correlationId: 'dashboard-integration',
        payload: {},
        hash: 'b'.repeat(64),
        previousHash: 'c'.repeat(64),
        chainHashVersion: 2,
      },
    });
  };

  for (let index = 0; index < 12; index += 1) {
    await write(ADA, 'DOCUMENT_VIEWED');
  }
  await write(BOB, 'DOCUMENT_VIEWED');
}
