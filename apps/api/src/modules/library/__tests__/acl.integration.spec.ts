import 'reflect-metadata';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  AclEffect,
  AclSubjectType,
  NumberSegmentKind,
  Permission,
  RevisionLabelStyle,
  ScopeType,
  type AnyId,
  type DocumentId,
  type FolderId,
  type ScopeRef,
  type TenantId,
  type UserId,
  asId,
} from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import type { AppConfig } from '../../../core/config/configuration';
import type { Logger } from '../../../core/observability/logger';
import { requireTransaction } from '../../../core/prisma';
import { PrismaUnitOfWork } from '../../../core/prisma/unit-of-work';
import { type RequestContext, runWithContext } from '../../../core/tenancy/tenant-context';
import { AccessDenialRecorder } from '../../../core/authorization/access-denial.recorder';
import { FakeCache, RecordingMetrics } from '../../../testing/fake-ports';
import { seedRoleGrant } from '../../../testing/acl-seed';
import { PrismaAclSubjectNameReader } from '../infrastructure/prisma-acl-subject-name.reader';
import {
  type DocumentLibraryStack,
  realAuditWriter,
  realDocumentLibrary,
  realPermissions,
  realScopeAdmin,
  realUserAdmin,
} from '../../../testing/real-collaborators';
import { everyTenantRegistry, sharedDatabase } from '../../../testing/tenant-database';
import type { UserAdminService } from '../../identity/application/user-admin.service';

/**
 * Phase 14 against a real PostgreSQL — the ACL model's own questions, which are all database
 * questions and are the most consequential ones in the product.
 *
 * Every assertion here is one a double cannot be trusted about, because a double is written from
 * the same belief as the code it stands in for. What is asserted:
 *
 * - **A deny beats a lower allow.** ADR-0005's central rule, over rows on a real chain.
 * - **An inheritance break stops the walk, and an administrative permission passes anyway.**
 * - **A cross-scope read answers `404`, not `403`** — existence is not leaked, and the refusal is
 *   in the trail.
 * - **The same document is visible to one caller and absent — not forbidden — from another's list
 *   *and its total*.** Fetch-then-filter would pass the first half of that and fail the second,
 *   which is exactly why the total is asserted.
 * - **The search index and a direct read agree after an ACL change**, because both come from one
 *   resolution.
 * - **A cold cache gives the same answer as a warm one**, which is 08 §8's own requirement.
 *
 * ## The entries are written as a *request* writes them
 *
 * CI's `edms_owner` is the cluster superuser, so a suite that seeds `acl_entry` rows with the owner
 * client writes past row-level security — and is then not testing what a request would see. Every
 * ACL entry in this file goes through `PermissionService`, in a request context, exactly as the
 * endpoint does. The owner client is used only for the fixtures a request could not create for
 * itself: the tenant row, the people, and the role grants an administrator would have made first.
 */

const OWNER_URL = process.env['DATABASE_MIGRATION_URL'] ?? '';
const APP_URL = process.env['DATABASE_URL'] ?? '';

const FIXED_NOW = new Date('2026-08-06T09:00:00.000Z');
const clock = { now: () => new Date(FIXED_NOW), timestamp: () => 0, elapsedMs: () => 0 };
const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const TENANT = asId<TenantId>(uuidv7());
/** Holds `document:view` through a role, and nothing narrower. */
const ALICE = asId<UserId>(uuidv7());
/** The same role, and an explicit `DENY` where it matters. */
const BOB = asId<UserId>(uuidv7());
/** Holds every administrative permission — the person a break must not hide a subtree from. */
const ADMIN = asId<UserId>(uuidv7());

const READER_ROLE = uuidv7();
const ADMIN_ROLE = uuidv7();
/**
 * `folder:manage` and nothing else — Slice 33.
 *
 * The two keys travel together in the seeded roles, so the separation the product relies on is
 * only observable in a tenant that composes its own. That is exactly the configuration role
 * administration exists to allow, and the one `permissions.controller` has in mind when it says
 * the inheritance route is gated apart "so somebody who may rename folders cannot silently detach
 * one from the tenant's grants".
 */
const FOLDER_ONLY_ROLE = uuidv7();

let root: string;
let appConfig: AppConfig;
let owner: PrismaClient;
let unitOfWork: PrismaUnitOfWork;
let library: DocumentLibraryStack;
let permissions: ReturnType<typeof realPermissions>;

let rootFolderId: string;
/** The library the tree hangs from — needed by the move cases, which create a folder of their own. */
let libraryId: string;
/**
 * One cache shared by the stack that performs a move and the resolver that reads the answer.
 *
 * Two resolver instances over one cache is what two processes have over one Redis, and it is the
 * arrangement that makes "the move cleared it" observable at all: a stack with a cache of its own
 * would invalidate honestly and invisibly.
 */
const sharedAclCache = new FakeCache(clock);
let openFolderId: string;
let closedFolderId: string;
let documentTypeId: string;
/** In `openFolderId` — the ordinary case. */
let openDocumentId: string;
/** In `closedFolderId`, which breaks inheritance. */
let closedDocumentId: string;

function contextFor(userId: UserId, roles: readonly string[]): RequestContext {
  return {
    tenantId: TENANT,
    userId,
    roles: [...roles],
    permissions: [],
    sessionId: null,
    correlationId: 'acl-suite',
    permissionVersion: 1,
    locale: 'en',
  };
}

const asAlice = <T>(work: () => Promise<T>): Promise<T> =>
  runWithContext(contextFor(ALICE, [READER_ROLE]), work);
const asBob = <T>(work: () => Promise<T>): Promise<T> =>
  runWithContext(contextFor(BOB, [READER_ROLE]), work);
const asAdmin = <T>(work: () => Promise<T>): Promise<T> =>
  runWithContext(contextFor(ADMIN, [ADMIN_ROLE]), work);
/** Somebody who may organise the library and may not change who reaches what. */
const asFolderManager = <T>(work: () => Promise<T>): Promise<T> =>
  runWithContext(contextFor(BOB, [FOLDER_ONLY_ROLE]), work);

const page = { page: 1, pageSize: 50, deleted: 'live' as const, sortDirection: 'desc' as const };

const folderScope = (id: string): ScopeRef => ({ type: ScopeType.FOLDER, id: asId<AnyId>(id) });
const documentScope = (id: string): ScopeRef => ({
  type: ScopeType.DOCUMENT,
  id: asId<AnyId>(id),
});

beforeAll(async () => {
  if (!OWNER_URL || !APP_URL) {
    throw new Error('DATABASE_URL and DATABASE_MIGRATION_URL must both be set.');
  }
  root = await mkdtemp(join(tmpdir(), 'edms-acl-'));

  appConfig = {
    env: 'test',
    database: { url: APP_URL, poolSize: 10 },
    storage: { driver: 'LOCAL', signedUrlTtlSeconds: 300 },
    // The cache off by default: every assertion below asks the database twice and expects the same
    // answer, and a cached decision between the two would make the second a recollection. One test
    // turns it on deliberately, which is the only honest way to test a cache.
    acl: { cacheTtlSeconds: 0, maxSubjectEntries: 5_000 },
  } as unknown as AppConfig;

  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  await owner.tenant.create({
    data: {
      id: TENANT,
      slug: `acl-${TENANT.replaceAll('-', '').slice(-16)}`,
      name: 'ACL Test',
      status: 'ACTIVE',
    },
  });
  for (const [id, name] of [
    [ALICE, 'alice'],
    [BOB, 'bob'],
    [ADMIN, 'admin'],
  ] as const) {
    await owner.user.create({
      data: {
        id,
        tenantId: TENANT,
        email: `${id}@acl.test`,
        emailNormalized: `${id}@acl.test`,
        displayName: name,
        status: 'ACTIVE',
        updatedAt: FIXED_NOW,
      },
    });
  }
  await seedRoleGrant(owner, {
    tenantId: TENANT,
    roleId: READER_ROLE,
    key: 'READER',
    userIds: [ALICE, BOB],
    permissions: [Permission.DOCUMENT_VIEW, Permission.DOCUMENT_CREATE],
    now: FIXED_NOW,
  });
  await seedRoleGrant(owner, {
    tenantId: TENANT,
    roleId: ADMIN_ROLE,
    key: 'TENANT_ADMIN',
    userIds: [ADMIN],
    now: FIXED_NOW,
  });
  await seedRoleGrant(owner, {
    tenantId: TENANT,
    roleId: FOLDER_ONLY_ROLE,
    key: 'FOLDER_ONLY',
    userIds: [BOB],
    permissions: [Permission.FOLDER_MANAGE],
    now: FIXED_NOW,
  });

  unitOfWork = new PrismaUnitOfWork(sharedDatabase(appConfig, logger, APP_URL));
  library = realDocumentLibrary({
    clock,
    unitOfWork,
    config: appConfig,
    aclCache: sharedAclCache,
    registry: everyTenantRegistry(APP_URL),
    storageRoot: root,
    signingSecret: 'an-integration-suite-secret-of-at-least-32',
    antivirus: {
      scanner: 'unconfigured',
      scan: () => Promise.reject(new Error('AV_DRIVER is NONE')),
    },
    users: { get: () => Promise.resolve(null) } as never,
  });
  permissions = realPermissions({ clock, unitOfWork, config: appConfig });

  await seedTree();
}, 120_000);

afterAll(async () => {
  await owner?.$disconnect();
  if (root) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('deny precedence, over rows on a real chain', () => {
  it('refuses a lower allow when a higher deny names the same caller', async () => {
    // Bob is allowed on the document itself and denied on the folder above it. Most-specific-wins —
    // ADR-0005's rejected alternative — would allow this.
    await asAdmin(() =>
      permissions.permissions.replaceFor(documentScope(openDocumentId), [
        entry(AclSubjectType.USER, BOB, Permission.DOCUMENT_VIEW, AclEffect.ALLOW),
      ]),
    );
    await asAdmin(() =>
      permissions.permissions.replaceFor(folderScope(openFolderId), [
        entry(AclSubjectType.USER, BOB, Permission.DOCUMENT_VIEW, AclEffect.DENY),
      ]),
    );

    const decision = await asBob(() =>
      permissions.resolver.resolve(
        subject(BOB, READER_ROLE),
        documentScope(openDocumentId),
        Permission.DOCUMENT_VIEW,
      ),
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('DENY');
    // ADR-0005's mitigation: the answer names the node an administrator would edit to change it.
    expect(decision.decidedAt?.id).toBe(openFolderId);
  });

  it('beats the tenant-level role grant, which Alice still has', async () => {
    const alice = await asAlice(() =>
      permissions.resolver.resolve(
        subject(ALICE, READER_ROLE),
        documentScope(openDocumentId),
        Permission.DOCUMENT_VIEW,
      ),
    );
    expect(alice).toMatchObject({ allowed: true, reason: 'ROLE_GRANT' });
  });

  it('leaves the same document visible to one caller and absent from the other’s list AND total', async () => {
    const forAlice = await asAlice(() => library.documents.list({ ...page }));
    const forBob = await asBob(() => library.documents.list({ ...page }));

    expect(forAlice.data.map((row) => row.id)).toContain(openDocumentId);
    // **Absent, not forbidden, and absent from the total.** A fetch-then-filter implementation
    // passes the first of these two expectations and fails the second, which is why 08 §7 forbids
    // it by name: a total that counts what a page omits leaks how much exists.
    expect(forBob.data.map((row) => row.id)).not.toContain(openDocumentId);
    expect(forBob.meta.total).toBe(forAlice.meta.total - 1);
  });
});

describe('breaking inheritance', () => {
  it('stops the tenant-level grant at the folder that broke it', async () => {
    // Alice holds `document:view` tenant-wide and nothing on this subtree. Before the break she
    // could see the document; after it she cannot, because the grant lives above the boundary.
    const before = await asAlice(() =>
      permissions.resolver.resolve(
        subject(ALICE, READER_ROLE),
        documentScope(closedDocumentId),
        Permission.DOCUMENT_VIEW,
      ),
    );
    expect(before).toMatchObject({ allowed: true, reason: 'ROLE_GRANT' });

    await asAdmin(() =>
      permissions.permissions.setInheritance(asId<FolderId>(closedFolderId), false),
    );

    const after = await asAlice(() =>
      permissions.resolver.resolve(
        subject(ALICE, READER_ROLE),
        documentScope(closedDocumentId),
        Permission.DOCUMENT_VIEW,
      ),
    );
    expect(after).toMatchObject({ allowed: false, reason: 'CLOSED_BY_DEFAULT' });

    // And it is gone from her list and her total, not merely from her reads.
    const listed = await asAlice(() => library.documents.list({ ...page }));
    expect(listed.data.map((row) => row.id)).not.toContain(closedDocumentId);
  });

  it('lets an explicit entry at or below the break grant what the break took away', async () => {
    await asAdmin(() =>
      permissions.permissions.replaceFor(folderScope(closedFolderId), [
        entry(AclSubjectType.USER, ALICE, Permission.DOCUMENT_VIEW, AclEffect.ALLOW),
      ]),
    );
    const decision = await asAlice(() =>
      permissions.resolver.resolve(
        subject(ALICE, READER_ROLE),
        documentScope(closedDocumentId),
        Permission.DOCUMENT_VIEW,
      ),
    );
    expect(decision).toMatchObject({ allowed: true, reason: 'ALLOW' });
    expect(decision.decidedAt?.id).toBe(closedFolderId);
  });

  it('never blocks an administrative permission — the whole reason the exemption exists', async () => {
    // The administrator holds `folder:manage` and `audit:view` tenant-wide and has no entry
    // anywhere on this subtree. If the break stopped them, a user could hide a subtree from the
    // people accountable for it, which is what ADR-0005's rule 5 forbids.
    for (const permission of [Permission.FOLDER_MANAGE, Permission.AUDIT_VIEW] as const) {
      const decision = await asAdmin(() =>
        permissions.resolver.resolve(
          subject(ADMIN, ADMIN_ROLE),
          documentScope(closedDocumentId),
          permission,
        ),
      );
      expect(decision, permission).toMatchObject({ allowed: true, reason: 'ROLE_GRANT' });
    }

    // And `document:view` — an ordinary permission — is refused for the same caller on the same
    // node, which is what makes the previous expectation about the exemption rather than about
    // being an administrator.
    const ordinary = await asAdmin(() =>
      permissions.resolver.resolve(
        subject(ADMIN, ADMIN_ROLE),
        documentScope(closedDocumentId),
        Permission.DOCUMENT_VIEW,
      ),
    );
    expect(ordinary.allowed).toBe(false);
  });

  it('audits the break as INHERITANCE_BROKEN and the restoration as an ordinary folder edit', async () => {
    const actions = await trailActions();
    expect(actions).toContain('INHERITANCE_BROKEN');

    await asAdmin(() =>
      permissions.permissions.setInheritance(asId<FolderId>(closedFolderId), true),
    );
    const after = await trailActions();
    // One break, still — restoring inheritance is a `FOLDER_CHANGED`, because ADR-0005 names the
    // action for the direction that hides content and names no counterpart.
    expect(after.filter((action) => action === 'INHERITANCE_BROKEN')).toHaveLength(1);
    expect(after).toContain('FOLDER_CHANGED');

    await asAdmin(() =>
      permissions.permissions.setInheritance(asId<FolderId>(closedFolderId), false),
    );
  });
});

describe('a refusal is a 404, and it is evidence', () => {
  it('answers "not found" for a node in another tenant, and records the denial', async () => {
    const recorder = new AccessDenialRecorder(
      realAuditWriter(clock, unitOfWork),
      logger,
      new RecordingMetrics(),
    );
    const before = (await trailActions()).filter((action) => action === 'ACCESS_DENIED').length;

    // A document identifier that names nothing this tenant can reach. The resolver cannot assemble
    // a chain for it, so the answer is a refusal — identical to the answer for a document that
    // exists and is denied, which is the property 08 §7 requires.
    const stranger = uuidv7();
    const decision = await asAlice(() =>
      permissions.resolver.resolve(
        subject(ALICE, READER_ROLE),
        documentScope(stranger),
        Permission.DOCUMENT_VIEW,
      ),
    );
    expect(decision).toMatchObject({ allowed: false, reason: 'CLOSED_BY_DEFAULT' });

    await asAlice(() =>
      recorder.record({
        scopeType: ScopeType.DOCUMENT,
        subjectId: asId<AnyId>(stranger),
        permission: Permission.DOCUMENT_VIEW,
        reason: decision.reason,
      }),
    );

    const after = (await trailActions()).filter((action) => action === 'ACCESS_DENIED').length;
    expect(after).toBe(before + 1);
  });

  it('refuses to let somebody grant themselves reach on a node they cannot see', async () => {
    // Bob is denied on the open folder by the first describe block. `document:permission:manage`
    // is question one and he does not hold it either — but the check that matters is question two:
    // the service asks the resolver about the node before it writes anything.
    await expect(
      asBob(() =>
        permissions.permissions.replaceFor(folderScope(openFolderId), [
          entry(AclSubjectType.USER, BOB, Permission.DOCUMENT_VIEW, AclEffect.ALLOW),
        ]),
      ),
    ).rejects.toThrowError(/requested resource/);
  });
});

describe('the entries themselves', () => {
  it('writes ACL_GRANTED and ACL_REVOKED for what an edit added and removed', async () => {
    const scope = folderScope(rootFolderId);
    await asAdmin(() =>
      permissions.permissions.replaceFor(scope, [
        entry(AclSubjectType.ROLE, READER_ROLE, Permission.DOCUMENT_VIEW, AclEffect.ALLOW),
      ]),
    );
    const afterGrant = await trailActions();
    expect(afterGrant).toContain('ACL_GRANTED');

    // Replacing the set with a different one is a revocation and a grant, not an update: the two
    // are separate questions after a disclosure, so they are separate rows.
    await asAdmin(() =>
      permissions.permissions.replaceFor(scope, [
        entry(AclSubjectType.ROLE, READER_ROLE, Permission.DOCUMENT_VIEW, AclEffect.DENY),
      ]),
    );
    expect(await trailActions()).toContain('ACL_REVOKED');

    await asAdmin(() => permissions.permissions.replaceFor(scope, []));
  });

  it('reports the effective answer for one person with the node that decided it', async () => {
    const effective = await asAdmin(() =>
      permissions.permissions.effectiveFor(documentScope(openDocumentId), BOB),
    );
    const view = effective.permissions.find(
      (permission) => permission.permission === Permission.DOCUMENT_VIEW,
    );
    expect(view).toMatchObject({ allowed: false, reason: 'DENY' });
    expect(view?.decidedAt?.id).toBe(openFolderId);
    // The chain is rendered so an administrator can see *where* the answer came from rather than
    // inferring it from a refusal.
    expect(effective.chain.map((node) => node.scope.type)).toEqual([
      ScopeType.TENANT,
      ScopeType.LIBRARY,
      ScopeType.FOLDER,
      ScopeType.FOLDER,
      ScopeType.DOCUMENT,
    ]);
  });

  it('refuses a duplicate entry for one subject and permission on one node', async () => {
    await expect(
      asAdmin(() =>
        permissions.permissions.replaceFor(folderScope(rootFolderId), [
          entry(AclSubjectType.USER, ALICE, Permission.DOCUMENT_VIEW, AclEffect.ALLOW),
          entry(AclSubjectType.USER, ALICE, Permission.DOCUMENT_VIEW, AclEffect.DENY),
        ]),
      ),
    ).rejects.toThrowError(/at most one effect/);
  });
});

describe('the index and a direct read cannot disagree', () => {
  it('materialises the same answer the resolver gives, before and after an ACL change', async () => {
    const scope = documentScope(openDocumentId);

    // Bob is denied on this document's folder (first describe block), Alice is not.
    const before = await asAdmin(() =>
      permissions.resolver.aclSubjectsFor(scope, Permission.DOCUMENT_VIEW),
    );
    expect(before.denySubjects).toContain(`user:${BOB}`);
    expect(before.allowSubjects).toContain(`grant:${Permission.DOCUMENT_VIEW}`);

    // The engine's predicate, in code: overlap allow, do not overlap deny.
    const visible = (
      filter: { subjectIds: readonly unknown[] },
      entryAcl: typeof before,
    ): boolean =>
      entryAcl.allowSubjects.some((token) => filter.subjectIds.includes(token)) &&
      !entryAcl.denySubjects.some((token) => filter.subjectIds.includes(token));

    const aliceFilter = await asAlice(() =>
      permissions.resolver.visibilityFilter(subject(ALICE, READER_ROLE), Permission.DOCUMENT_VIEW),
    );
    const bobFilter = await asBob(() =>
      permissions.resolver.visibilityFilter(subject(BOB, READER_ROLE), Permission.DOCUMENT_VIEW),
    );

    expect(visible(aliceFilter, before)).toBe(true);
    expect(visible(bobFilter, before)).toBe(false);

    // Which is exactly what a direct read says, from the other method on the same class.
    expect(
      (
        await asAlice(() =>
          permissions.resolver.resolve(
            subject(ALICE, READER_ROLE),
            scope,
            Permission.DOCUMENT_VIEW,
          ),
        )
      ).allowed,
    ).toBe(true);
    expect(
      (
        await asBob(() =>
          permissions.resolver.resolve(subject(BOB, READER_ROLE), scope, Permission.DOCUMENT_VIEW),
        )
      ).allowed,
    ).toBe(false);

    // Now revoke the deny and re-materialise: both sides move together.
    await asAdmin(() => permissions.permissions.replaceFor(folderScope(openFolderId), []));

    const after = await asAdmin(() =>
      permissions.resolver.aclSubjectsFor(scope, Permission.DOCUMENT_VIEW),
    );
    expect(after.denySubjects).not.toContain(`user:${BOB}`);
    expect(after.fingerprint).not.toBe(before.fingerprint);

    const bobAfter = await asBob(() =>
      permissions.resolver.visibilityFilter(subject(BOB, READER_ROLE), Permission.DOCUMENT_VIEW),
    );
    expect(visible(bobAfter, after)).toBe(true);
    expect(
      (
        await asBob(() =>
          permissions.resolver.resolve(subject(BOB, READER_ROLE), scope, Permission.DOCUMENT_VIEW),
        )
      ).allowed,
    ).toBe(true);
  });
});

/**
 * Who owns inheritance — Slice 33.
 *
 * `PATCH /v1/admin/folders/{id}` used to accept `inheritAcl` and write it, and that route carries
 * `folder:manage`. The dedicated route carries `document:permission:manage`, and
 * `permissions.controller` says why the keys are different: "so somebody who may rename folders
 * cannot silently detach one from the tenant's grants". Slice 33 removed the field from
 * `updateFolderSchema`; this is the other half of the boundary, asserted on the route that keeps
 * the operation.
 */
describe('breaking inheritance belongs to ACL management', () => {
  /** The positive control: somebody who holds the key can still do it, in both directions. */
  it('lets a holder of document:permission:manage change it', async () => {
    await asAdmin(() =>
      permissions.permissions.setInheritance(asId<FolderId>(closedFolderId), true),
    );
    await asAdmin(() =>
      permissions.permissions.setInheritance(asId<FolderId>(closedFolderId), false),
    );
  });

  it('refuses somebody holding only folder:manage', async () => {
    // A 404 rather than a 403, which is this resolver's own rule: a caller who may not reach a node
    // is not told it exists.
    await expect(
      asFolderManager(() =>
        permissions.permissions.setInheritance(asId<FolderId>(closedFolderId), true),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // And nothing moved: the folder still breaks inheritance, so the refusal was a refusal rather
    // than a failure after the write.
    const row = await owner.folder.findUniqueOrThrow({ where: { id: closedFolderId } });
    expect(row.inheritAcl).toBe(false);
  });
});

describe('the cache is an optimisation only', () => {
  it('gives the same answer cold as warm, and an edit invalidates it in the same transaction', async () => {
    // 08 §8's own requirement, asserted rather than asserted-to. This is the one test that runs
    // with the cache on; everything above it runs cold, so "the same answer" is a comparison
    // against answers this file has already proved correct.
    const cached = realPermissions({
      clock,
      unitOfWork,
      config: {
        ...appConfig,
        acl: { cacheTtlSeconds: 60, maxSubjectEntries: 5_000 },
      },
      cache: sharedAclCache,
    });
    const scope = documentScope(openDocumentId);

    const warm = async (): Promise<boolean> =>
      (
        await asAlice(() =>
          cached.resolver.resolve(subject(ALICE, READER_ROLE), scope, Permission.DOCUMENT_VIEW),
        )
      ).allowed;

    expect(await warm()).toBe(true);
    // Second call is served from the cache and must not have changed the answer.
    expect(await warm()).toBe(true);

    await asAdmin(() =>
      cached.permissions.replaceFor(folderScope(openFolderId), [
        entry(AclSubjectType.USER, ALICE, Permission.DOCUMENT_VIEW, AclEffect.DENY),
      ]),
    );

    // The edit cleared the tenant's prefix inside its own transaction, so the next read is the new
    // answer rather than the TTL's leftovers.
    expect(await warm()).toBe(false);

    await asAdmin(() => cached.permissions.replaceFor(folderScope(openFolderId), []));
    expect(await warm()).toBe(true);
  });

  /**
   * The same requirement for the *other* thing that changes reach on this chain — Slice 33.
   *
   * An ACL entry write is proved above. Breaking inheritance changes the answer without touching a
   * single entry: it truncates the chain, so step 6's tenant-wide role grant is never reached. Both
   * go through `afterChange`, and the point of asserting the second is that the folder route used
   * to change the same flag through a path that called `afterChange` at all.
   */
  it('invalidates a cached decision when inheritance changes', async () => {
    const cached = realPermissions({
      clock,
      unitOfWork,
      config: { ...appConfig, acl: { cacheTtlSeconds: 60, maxSubjectEntries: 5_000 } },
      cache: sharedAclCache,
    });
    const scope = documentScope(openDocumentId);
    const warm = async (): Promise<boolean> =>
      (
        await asAlice(() =>
          cached.resolver.resolve(subject(ALICE, READER_ROLE), scope, Permission.DOCUMENT_VIEW),
        )
      ).allowed;

    /*
     * Every input established here rather than inherited from the cases above.
     *
     * Two earlier attempts at this assertion read their starting state from whatever had run
     * before — the folder's inheritance in one, an ACL entry left on the chain in the other — and
     * so passed in isolation and failed in the file, for reasons that had nothing to do with the
     * cache. Clearing the entries and setting the flag is what makes the flip below the only thing
     * that changes.
     */
    await asAdmin(() => cached.permissions.replaceFor(folderScope(openFolderId), []));
    await asAdmin(() => cached.permissions.setInheritance(asId<FolderId>(openFolderId), true));

    // Inheriting and unencumbered, so the tenant-wide role grant reaches the document. Asked
    // twice: the second answer is the cached one, and it must agree.
    expect(await warm()).toBe(true);
    expect(await warm()).toBe(true);

    await asAdmin(() => cached.permissions.setInheritance(asId<FolderId>(openFolderId), false));

    // The direction that matters: a cached **allow** must not outlive the break that closed it.
    // Without the invalidation inside that write this is the TTL's leftovers, answering `true`.
    expect(await warm()).toBe(false);

    // And back, so the folder leaves this file as the rest of it expects to find it.
    await asAdmin(() => cached.permissions.setInheritance(asId<FolderId>(openFolderId), true));
    expect(await warm()).toBe(true);
  });
});

/**
 * Moving a thing changes what reaches it — Slice 34.
 *
 * `08 §8` and the resolver's own header both list the writes that clear `acl:<tenant>:`, and both
 * name a move: "an ACL edit, an inheritance change, a role's permissions, a user's roles, a
 * department membership, **a document move**". The chain cache is documented in the same header as
 * the half that changes when "a folder's ancestry changes when somebody moves it, which is a
 * `library.folder-moved` event".
 *
 * Neither move clears anything. `DocumentService` and `LibraryAdminService` hold no cache at all,
 * and the only consumer of `library.folder-moved` is the search index.
 */
describe('a move changes the answer, so it must clear the answer', () => {
  /**
   * Its own folders and its own documents, every time.
   *
   * The first version of these cases reached for `openFolderId` and reset its entries and its
   * inheritance. That flipped two later cases from denied to allowed — an earlier test writes ACL
   * entries on the root, and restoring inheritance let a user-level grant through — which is the
   * same ordering coupling Slice 33's cache case was rewritten to avoid. Nothing shared is touched
   * here.
   */
  async function aFolder(parentId: string, inheritAcl: boolean): Promise<string> {
    const created = await asAdmin(() =>
      library.libraries.createFolder({
        libraryId,
        parentId,
        name: `Move ${uuidv7().slice(-10)}`,
        inheritAcl,
      }),
    );
    return created.id;
  }

  function warmStack() {
    return realPermissions({
      clock,
      unitOfWork,
      config: { ...appConfig, acl: { cacheTtlSeconds: 60, maxSubjectEntries: 5_000 } },
      cache: sharedAclCache,
    });
  }

  function reader(cached: ReturnType<typeof realPermissions>, documentId: string) {
    return async (): Promise<boolean> =>
      (
        await asAlice(() =>
          cached.resolver.resolve(
            subject(ALICE, READER_ROLE),
            documentScope(documentId),
            Permission.DOCUMENT_VIEW,
          ),
        )
      ).allowed;
  }

  it('invalidates when a document moves into a folder that breaks inheritance', async () => {
    const cached = warmStack();
    const home = await aFolder(rootFolderId, true);
    const vault = await aFolder(rootFolderId, false);
    const moving = await seedDocument(home, 'Movable procedure');
    const warm = reader(cached, moving);

    // Reachable where it is, and cached. Asked twice, so the second answer is the cached one.
    expect(await warm()).toBe(true);
    expect(await warm()).toBe(true);

    const before = await owner.document.findUniqueOrThrow({
      where: { id: moving },
      select: { version: true },
    });
    await asAdmin(() => library.documents.move(moving, vault, before.version));

    // It now sits under a folder that stops the walk, so the role grant no longer reaches it.
    // Without the invalidation this is the cached `true`, and every reader who had already opened
    // the document keeps it for the length of the TTL.
    expect(await warm()).toBe(false);
  });

  /**
   * Slice 34's follow-up A, now testable — Slice 35.
   *
   * That slice identified the mechanism and could not reach it: the list path in this suite runs
   * through a resolver configured at `cacheTtlSeconds: 0`, so nothing was ever cached and the case
   * passed without proving anything. It was removed rather than kept.
   *
   * The visibility filter is the only thing creation can make stale, and it is asked here directly
   * — the lowest layer that holds the defect. Its tenant-wide region carries
   * `excludedFolderPaths: breaks`, the broken-inheritance paths read *at computation time*. A
   * folder created with the break after that read is a cut the cached filter does not have, so
   * every list and every search built from it reaches into a subtree that was never reachable.
   *
   * Creation grants nothing and hides nothing that existed — Slice 33 was right to leave the
   * permission model alone. What it does is change the answer, and the answer was cached.
   */
  it('invalidates when a folder is created with inheritance already broken', async () => {
    const cached = warmStack();
    const exclusions = async (): Promise<readonly string[]> => {
      const filter = await asAlice(() =>
        cached.resolver.visibilityFilter(subject(ALICE, READER_ROLE), Permission.DOCUMENT_VIEW),
      );
      return filter.allowedRegions.flatMap((region) => [...region.excludedFolderPaths]);
    };

    // Warm it, twice, so the second answer is the cached one.
    const before = await exclusions();
    expect(await exclusions()).toEqual(before);

    const vault = await aFolder(rootFolderId, false);
    const row = await owner.folder.findUniqueOrThrow({ where: { id: vault } });

    // A cold resolver — the same suite's `cacheTtlSeconds: 0` stack — is what the answer ought to
    // be, and `08 §8` requires the cached one to agree with it.
    const cold = await asAlice(() =>
      permissions.resolver.visibilityFilter(subject(ALICE, READER_ROLE), Permission.DOCUMENT_VIEW),
    );
    expect(cold.allowedRegions.flatMap((region) => [...region.excludedFolderPaths])).toContain(
      row.path,
    );

    // Without an invalidation the cached filter has no cut for a folder that did not exist when it
    // was built, and a reader lists documents placed behind the break.
    expect(await exclusions()).toContain(row.path);
  });

  it('invalidates when a folder moves under one that breaks inheritance', async () => {
    const cached = warmStack();
    const home = await aFolder(rootFolderId, true);
    const vault = await aFolder(rootFolderId, false);
    const branch = await aFolder(home, true);
    const carried = await seedDocument(branch, 'Carried along');
    const warm = reader(cached, carried);

    expect(await warm()).toBe(true);
    expect(await warm()).toBe(true);

    // The subtree's ancestry changes, which is the case the resolver's header names by event.
    const row = await owner.folder.findUniqueOrThrow({ where: { id: branch } });
    await asAdmin(() => library.libraries.moveFolder(branch, vault, row.version));

    expect(await warm()).toBe(false);
  });
});

/**
 * A department's ancestry is an authorization input, and moving one changes it — Slice 36.
 *
 * `ScopeAdminService.moveDepartment` says so itself: "A move rewrites derived data the ACL resolver
 * reads. Re-parenting a department changes the materialised path of its whole subtree, and every
 * ACL granted along the old chain stops applying to it … it publishes
 * `organization.department-moved` so permission caches drop what they know."
 *
 * Nothing consumes that event. The search index consumer handles `library.acl-changed` and
 * `library.folder-moved` and nothing else, and the outbox dispatcher handles `document.created` and
 * `bulk.operation-queued`. So the caches were never told.
 *
 * The dependency is real and is one line: `departmentsOf` returns `idsInPath(row.path)`, so a
 * member of a child department carries its ancestors as ACL subjects. An entry naming the old
 * parent reaches them until the path changes — and `decisionKey` is
 * `(tenant, user, roles, scope, permission)`, which does not mention departments, so the answer
 * cached before the move is served after it under the very same key.
 *
 * Its own company, entity, departments, folder, document and member: nothing here is shared with
 * the rest of the file, so nothing earlier can decide the outcome.
 */
describe('moving a department changes who its members are', () => {
  let parentA: string;
  let parentB: string;
  let child: string;
  let folderId: string;
  let documentId: string;
  let scopes: ReturnType<typeof realScopeAdmin>;

  beforeAll(async () => {
    // The shared cache, so "the move cleared it" is observable from the warm resolver below.
    scopes = realScopeAdmin({ clock, unitOfWork, config: appConfig, cache: sharedAclCache });

    const companyId = uuidv7();
    const entityId = uuidv7();
    parentA = uuidv7();
    parentB = uuidv7();
    child = uuidv7();
    await owner.company.create({
      data: { id: companyId, tenantId: TENANT, code: 'MOVE', name: 'Movers', updatedAt: FIXED_NOW },
    });
    await owner.entity.create({
      data: {
        id: entityId,
        tenantId: TENANT,
        companyId,
        code: 'MOVE-1',
        name: 'Movers One',
        updatedAt: FIXED_NOW,
      },
    });
    for (const [id, code, path] of [
      [parentA, 'PA', parentA],
      [parentB, 'PB', parentB],
      [child, 'CH', `${parentA}.${child}`],
    ] as const) {
      await owner.department.create({
        data: {
          id,
          tenantId: TENANT,
          entityId,
          code,
          name: code,
          path,
          ...(id === child && { parentId: parentA }),
          updatedAt: FIXED_NOW,
        },
      });
    }
    // BOB is a member of the child only. His ancestry is what the entry below reaches him through.
    await owner.userDepartment.create({
      data: { tenantId: TENANT, userId: BOB, departmentId: child, isPrimary: true },
    });

    const folder = await asAdmin(() =>
      library.libraries.createFolder({
        libraryId,
        parentId: rootFolderId,
        name: `Departmental ${uuidv7().slice(-8)}`,
        inheritAcl: true,
      }),
    );
    folderId = folder.id;
    documentId = await seedDocument(folderId, 'Departmental procedure');

    // The only thing that grants: an entry naming the *parent* department.
    await asAdmin(() =>
      permissions.permissions.replaceFor(folderScope(folderId), [
        entry(AclSubjectType.DEPARTMENT, parentA, Permission.DOCUMENT_VIEW, AclEffect.ALLOW),
      ]),
    );
  });

  /** `FOLDER_ONLY_ROLE` grants no `document:view`, so the department entry is the whole grant. */
  const asMember = <T>(work: () => Promise<T>): Promise<T> =>
    runWithContext(contextFor(BOB, [FOLDER_ONLY_ROLE]), work);

  it('reaches a member through the parent, and nobody else', async () => {
    // The positive control, and its negative half: without this the case below could pass because
    // everybody was denied all along.
    const member = await asMember(() =>
      permissions.resolver.resolve(
        subject(BOB, FOLDER_ONLY_ROLE),
        documentScope(documentId),
        Permission.DOCUMENT_VIEW,
      ),
    );
    expect(member.allowed).toBe(true);

    // ALICE is not a member of the child, and this role grants her no tenant-wide view either.
    const stranger = await asAdmin(() =>
      permissions.resolver.resolve(
        subject(ALICE, FOLDER_ONLY_ROLE),
        documentScope(documentId),
        Permission.DOCUMENT_VIEW,
      ),
    );
    expect(stranger.allowed).toBe(false);
  });

  it('stops reaching them once the department is moved out from under it', async () => {
    const cached = realPermissions({
      clock,
      unitOfWork,
      config: { ...appConfig, acl: { cacheTtlSeconds: 60, maxSubjectEntries: 5_000 } },
      cache: sharedAclCache,
    });
    const warm = async (): Promise<boolean> =>
      (
        await asMember(() =>
          cached.resolver.resolve(
            subject(BOB, FOLDER_ONLY_ROLE),
            documentScope(documentId),
            Permission.DOCUMENT_VIEW,
          ),
        )
      ).allowed;

    // Reachable through the parent, and cached. Asked twice: the second answer is the cached one.
    expect(await warm()).toBe(true);
    expect(await warm()).toBe(true);

    const row = await owner.department.findUniqueOrThrow({ where: { id: child } });
    await asAdmin(() => scopes.moveDepartment(child, parentB, row.version));

    // The member's ancestry no longer contains the department the entry names, so the entry no
    // longer reaches them. Without an invalidation this is the cached `true` — a grant that
    // outlives the reorganisation that removed it.
    expect(await warm()).toBe(false);
  });
});

/**
 * Slice 37 — a person's departments, and the answers cached under a key that does not name them.
 *
 * `moveDepartment` above changes the *department's* place in the tree. This changes the *person's*
 * place in the department, which is the other half of the same dependency: `departmentsOf` resolves
 * a caller's ACL subjects from their `user_department` rows expanded along `department.path`, so an
 * entry naming a department reaches exactly its members and stops when somebody stops being one.
 *
 * `UserAdminService.update` has bumped `permission_version` on that write since Phase 2, and the
 * comment there says why: "department membership is a *subject* the ACL resolver matches on". The
 * bump refuses the access token, so the next request carries a freshly minted one — and
 * `decisionKey` is `(tenant, user, roles, scope, permission)`, which names no department, so the
 * fresh token lands on the entry cached before the change. Token freshness is not cache freshness.
 *
 * The mutation is the product's own: `UserAdminService.update`, in a request context, exactly as
 * `PATCH /users/:id` performs it. Nothing here deletes a cache entry by hand — that would prove
 * only that deleting an entry works.
 */
describe('changing who is in a department changes who its documents reach', () => {
  /** A member from the start. The revoke direction is his. */
  const CARL = asId<UserId>(uuidv7());
  /** Not a member. The grant direction is hers. */
  const DANA = asId<UserId>(uuidv7());
  /** `folder:manage` and nothing else, so the department entry is the whole grant — as above. */
  const MEMBERSHIP_ROLE = uuidv7();

  let departmentId: string;
  let carlDocumentId: string;
  let danaDocumentId: string;
  let people: UserAdminService;

  /** The cache configuration that makes an answer survive: a real TTL, over the shared map. */
  const warmConfig = {
    ...appConfig,
    acl: { cacheTtlSeconds: 60, maxSubjectEntries: 5_000 },
  } as unknown as AppConfig;

  beforeAll(async () => {
    people = realUserAdmin({
      clock,
      unitOfWork,
      config: warmConfig,
      cache: sharedAclCache,
    });

    const companyId = uuidv7();
    const entityId = uuidv7();
    departmentId = uuidv7();
    await owner.company.create({
      data: {
        id: companyId,
        tenantId: TENANT,
        code: 'MEMB',
        name: 'Members',
        updatedAt: FIXED_NOW,
      },
    });
    await owner.entity.create({
      data: {
        id: entityId,
        tenantId: TENANT,
        companyId,
        code: 'MEMB-1',
        name: 'Members One',
        updatedAt: FIXED_NOW,
      },
    });
    await owner.department.create({
      data: {
        id: departmentId,
        tenantId: TENANT,
        entityId,
        code: 'MEMB-D',
        name: 'Registry',
        path: departmentId,
        updatedAt: FIXED_NOW,
      },
    });
    for (const [id, name] of [
      [CARL, 'carl'],
      [DANA, 'dana'],
    ] as const) {
      await owner.user.create({
        data: {
          id,
          tenantId: TENANT,
          email: `${id}@acl.test`,
          emailNormalized: `${id}@acl.test`,
          displayName: name,
          status: 'ACTIVE',
          updatedAt: FIXED_NOW,
        },
      });
    }
    await seedRoleGrant(owner, {
      tenantId: TENANT,
      roleId: MEMBERSHIP_ROLE,
      key: 'MEMBERSHIP_ONLY',
      userIds: [CARL, DANA],
      permissions: [Permission.FOLDER_MANAGE],
      now: FIXED_NOW,
    });
    // Carl is in the department; Dana is not. Written as a fixture, because this is the state the
    // cases *start* from — every membership change they assert about goes through the service.
    await owner.userDepartment.create({
      data: { tenantId: TENANT, userId: CARL, departmentId, isPrimary: true },
    });

    /*
     * Two documents in two folders rather than one of each, so the revoke case and the grant case
     * cannot decide each other. They share the tenant prefix that `invalidateTenant` clears, which
     * is the point — but they must not share a *decision*, or the second case would be reading the
     * first one's invalidation.
     */
    const folders = await Promise.all(
      ['Registry procedures', 'Registry forms'].map((name) =>
        asAdmin(() =>
          library.libraries.createFolder({
            libraryId,
            parentId: rootFolderId,
            name: `${name} ${uuidv7().slice(-8)}`,
            inheritAcl: true,
          }),
        ),
      ),
    );
    carlDocumentId = await seedDocument(folders[0]!.id, 'Procedure for the registry');
    danaDocumentId = await seedDocument(folders[1]!.id, 'Form for the registry');
    for (const folder of folders) {
      // The only thing that grants: an entry naming the department.
      await asAdmin(() =>
        permissions.permissions.replaceFor(folderScope(folder.id), [
          entry(AclSubjectType.DEPARTMENT, departmentId, Permission.DOCUMENT_VIEW, AclEffect.ALLOW),
        ]),
      );
    }
  });

  const asPerson = <T>(userId: UserId, work: () => Promise<T>): Promise<T> =>
    runWithContext(contextFor(userId, [MEMBERSHIP_ROLE]), work);

  /** One resolver, warm, shared with the service that performs the write. */
  const cached = (): ReturnType<typeof realPermissions> =>
    realPermissions({ clock, unitOfWork, config: warmConfig, cache: sharedAclCache });

  const canView = async (userId: UserId, documentId: string): Promise<boolean> =>
    (
      await asPerson(userId, () =>
        cached().resolver.resolve(
          subject(userId, MEMBERSHIP_ROLE),
          documentScope(documentId),
          Permission.DOCUMENT_VIEW,
        ),
      )
    ).allowed;

  const setDepartments = (userId: UserId, ids: readonly string[]): Promise<unknown> =>
    asAdmin(() =>
      people.update(
        userId,
        {
          departments: ids.map((id, index) => ({
            departmentId: id,
            isPrimary: index === 0,
            isManager: false,
          })),
        },
        undefined,
      ),
    );

  it('reaches a member and refuses a non-member', async () => {
    // The positive control, both halves, before either direction is asserted: without the second
    // half the revoke case could pass because nothing reached anybody, and without the first the
    // grant case could pass because everybody reached everything.
    expect(await canView(CARL, carlDocumentId)).toBe(true);
    expect(await canView(DANA, danaDocumentId)).toBe(false);
  });

  it('stops reaching them once their membership is removed', async () => {
    // Warm, and asked twice: the second answer is the cached one, so what follows is about an
    // entry that exists rather than about a lookup that happens to repeat.
    expect(await canView(CARL, carlDocumentId)).toBe(true);
    expect(await canView(CARL, carlDocumentId)).toBe(true);

    const before = await owner.user.findUniqueOrThrow({ where: { id: CARL } });
    await setDepartments(CARL, []);

    // The bump happened — and on its own it changes nothing here. A refused token is replaced by a
    // fresh one carrying the same user and the same roles, which is the whole of `decisionKey`.
    const after = await owner.user.findUniqueOrThrow({ where: { id: CARL } });
    expect(after.permissionVersion).toBeGreaterThan(before.permissionVersion);
    expect(await owner.userDepartment.count({ where: { tenantId: TENANT, userId: CARL } })).toBe(0);

    // Without an invalidation this is the cached `true`: a grant surviving the removal that ended
    // it, for the length of the TTL.
    expect(await canView(CARL, carlDocumentId)).toBe(false);
  });

  it('starts reaching them once they are added', async () => {
    expect(await canView(DANA, danaDocumentId)).toBe(false);
    expect(await canView(DANA, danaDocumentId)).toBe(false);

    await setDepartments(DANA, [departmentId]);

    // The other direction, and the one an administrator notices: a person added to a department is
    // told they still may not open its documents.
    expect(await canView(DANA, danaDocumentId)).toBe(true);
  });

  it('leaves another tenant’s cached answers alone', async () => {
    /*
     * The prefix carries the tenant, and this asserts it from the outside rather than by reading
     * the key: an entry written under another tenant's prefix is still there after a membership
     * change in this one. Redis is the one store `ADR-0015`'s database-per-tenant model leaves
     * shared, so a `deleteByPrefix` that dropped the tenant would be a cross-tenant cache flush.
     */
    const otherTenant = `acl:${uuidv7()}:d:someone:everything`;
    await sharedAclCache.set(otherTenant, { allowed: true }, 60);

    await setDepartments(CARL, [departmentId]);

    expect(await sharedAclCache.get(otherTenant)).not.toBeNull();
  });
});

/**
 * Slice 39 — a folder's *existence* is an authorization input, and delete/restore moves it.
 *
 * `brokenInheritancePaths()` reads `inheritAcl: false, deletedAt: null`, and its result becomes
 * `excludedFolderPaths` on every allowed region a visibility filter carries. So a folder that
 * breaks inheritance stops cutting the tree the moment it is deleted and starts cutting it again
 * the moment it is restored — and `filterKey` is `(tenant, user, roles, permission)`, which says
 * nothing about the folder tree. The answer cached on one side of either write is served on the
 * other.
 *
 * The two directions are not equally serious, and both are asserted:
 *
 * - **Restore is the one that exposes.** A restore only flips `deleted_at`, so the folder comes
 *   back *still broken*, and with it every document the cascade restores. A filter cached while it
 *   was deleted has no cut for it, and lists documents behind a break that is once again in force.
 *   This is `ALLOW` where the current state says `DENY`.
 * - **Delete is the one that hides.** A filter cached before the delete keeps a cut for a subtree
 *   now in the recycle bin, and omits its rows from the deleted-documents view. `DENY` where the
 *   current state says `ALLOW` — wrong, and wrong in the safe direction.
 *
 * Asserted through `documents.list`, the read the product performs, rather than through the region
 * set alone: a warm stack of its own, so this does not repeat Slice 35's mistake of proving a cache
 * against a resolver configured at `cacheTtlSeconds: 0`.
 */
describe('deleting and restoring a folder moves the inheritance boundary with it', () => {
  /** Reaches documents only through a tenant-wide role grant, so a cut is all that can stop her. */
  const EVE = asId<UserId>(uuidv7());
  const VIEWER_ROLE = uuidv7();

  let warmLibrary: DocumentLibraryStack;
  let openTitle: string;

  beforeAll(async () => {
    warmLibrary = realDocumentLibrary({
      clock,
      unitOfWork,
      // The one difference from the suite's own stack: a TTL, so the filter it computes survives
      // to be served again.
      config: { ...appConfig, acl: { cacheTtlSeconds: 60, maxSubjectEntries: 5_000 } },
      aclCache: sharedAclCache,
      registry: everyTenantRegistry(APP_URL),
      storageRoot: root,
      signingSecret: 'an-integration-suite-secret-of-at-least-32',
      antivirus: {
        scanner: 'unconfigured',
        scan: () => Promise.reject(new Error('AV_DRIVER is NONE')),
      },
      users: { get: () => Promise.resolve(null) } as never,
    });

    await owner.user.create({
      data: {
        id: EVE,
        tenantId: TENANT,
        email: `${EVE}@acl.test`,
        emailNormalized: `${EVE}@acl.test`,
        displayName: 'eve',
        status: 'ACTIVE',
        updatedAt: FIXED_NOW,
      },
    });
    await seedRoleGrant(owner, {
      tenantId: TENANT,
      roleId: VIEWER_ROLE,
      key: 'VIEWER_ONLY',
      userIds: [EVE],
      permissions: [Permission.DOCUMENT_VIEW],
      now: FIXED_NOW,
    });

    // A document nothing in these cases touches, so "denied" can never mean "the list was empty".
    const open = await folderUnderRoot(true);
    openTitle = `Always visible ${uuidv7().slice(-8)}`;
    await seedDocument(open, openTitle);
  });

  const asEve = <T>(work: () => Promise<T>): Promise<T> =>
    runWithContext(contextFor(EVE, [VIEWER_ROLE]), work);

  async function folderUnderRoot(inheritAcl: boolean): Promise<string> {
    const created = await asAdmin(() =>
      library.libraries.createFolder({
        libraryId,
        parentId: rootFolderId,
        name: `Lifecycle ${uuidv7().slice(-10)}`,
        inheritAcl,
      }),
    );
    return created.id;
  }

  /** What Eve's list actually contains, through the warm stack. */
  const titles = async (deleted: 'live' | 'deleted'): Promise<readonly string[]> => {
    const rows = await asEve(() => warmLibrary.documents.list({ ...page, deleted }));
    return rows.data.map((row) => row.title);
  };

  it('hides a document behind a break from somebody the tenant-wide grant would otherwise reach', async () => {
    // The positive control, both halves. Without the second the cases below could pass because Eve
    // reaches nothing at all.
    const vault = await folderUnderRoot(false);
    const hidden = `Behind the break ${uuidv7().slice(-8)}`;
    await seedDocument(vault, hidden);

    const live = await titles('live');
    expect(live).toContain(openTitle);
    expect(live).not.toContain(hidden);
  });

  it('stops hiding it while the folder that broke inheritance is in the bin', async () => {
    // The delete direction, and the narrower one: the cut is cached, the folder is gone, and the
    // deleted-documents view keeps excluding a subtree nothing excludes any more.
    const vault = await folderUnderRoot(false);
    const buried = `Buried procedure ${uuidv7().slice(-8)}`;
    await seedDocument(vault, buried);

    // Warm, twice, with the cut in place: the second answer is the cached one.
    expect(await titles('live')).not.toContain(buried);
    expect(await titles('live')).not.toContain(buried);

    const row = await owner.folder.findUniqueOrThrow({ where: { id: vault } });
    await asAdmin(() => library.libraries.deleteFolder(vault, row.version));

    // Cold — the suite's `cacheTtlSeconds: 0` stack — is what the answer ought to be, and `08 §8`
    // requires the cached one to agree with it.
    const cold = await asEve(() => library.documents.list({ ...page, deleted: 'deleted' }));
    expect(cold.data.map((each) => each.title)).toContain(buried);

    expect(await titles('deleted')).toContain(buried);
  });

  it('starts hiding it again the moment the folder is restored', async () => {
    // The restore direction, and the one that exposes.
    const vault = await folderUnderRoot(false);
    const returning = `Returning procedure ${uuidv7().slice(-8)}`;
    await seedDocument(vault, returning);

    const deleted = await owner.folder.findUniqueOrThrow({ where: { id: vault } });
    await asAdmin(() => library.libraries.deleteFolder(vault, deleted.version));

    // Warmed *while the folder is in the bin*, so the cached filter carries no cut for it. Twice,
    // so the second answer is the cached one.
    expect(await titles('live')).not.toContain(returning);
    expect(await titles('deleted')).toContain(returning);

    const buried = await owner.folder.findUniqueOrThrow({ where: { id: vault } });
    await asAdmin(() => library.libraries.restoreFolder(vault, buried.version));

    // A restore flips `deleted_at` and nothing else, so the folder is live and still broken.
    const restored = await owner.folder.findUniqueOrThrow({ where: { id: vault } });
    expect(restored.deletedAt).toBeNull();
    expect(restored.inheritAcl).toBe(false);

    const cold = await asEve(() => library.documents.list({ ...page, deleted: 'live' }));
    expect(cold.data.map((each) => each.title)).not.toContain(returning);

    // Without the invalidation this is the filter computed while the folder was in the bin: no cut,
    // and a document behind a break in force is listed to somebody the break exists to stop.
    expect(await titles('live')).not.toContain(returning);
  });

  it('leaves another tenant’s cached answers alone', async () => {
    const otherTenant = `acl:${uuidv7()}:v:someone:everything`;
    await sharedAclCache.set(otherTenant, { unrestricted: true }, 60);

    const vault = await folderUnderRoot(false);
    const row = await owner.folder.findUniqueOrThrow({ where: { id: vault } });
    await asAdmin(() => library.libraries.deleteFolder(vault, row.version));

    expect(await sharedAclCache.get(otherTenant)).not.toBeNull();
  });
});

/**
 * Slice 39 — role *membership*, which needs no invalidation, asserted rather than argued.
 *
 * Slices 37 and 38 both reasoned that gaining or losing a role is separated by the cache key
 * itself: `decisionKey` and `filterKey` are built from the caller's role identifiers, so a token
 * minted before an assignment and one minted after it cannot share an entry. That is the reason no
 * invalidation was added to `replaceRoles` while one was added beside it to `replaceDepartments`,
 * and it is exactly the kind of reason that is true until somebody edits a key.
 *
 * So it is a test. The membership is changed through `UserAdminService.update`, the request path,
 * and each half is asked with the roles the *next* token would carry — which is what the resolver
 * receives, since `AclGuard` builds the subject from the context.
 */
describe('a role assignment separates itself, because the key names the roles', () => {
  const FRANK = asId<UserId>(uuidv7());
  /** Grants nothing at all: what Frank holds before, and what must not reach the document. */
  const BYSTANDER_ROLE = uuidv7();
  /** Tenant-wide `document:view`: what he is given, and later loses. */
  const GRANTING_ROLE = uuidv7();

  let documentId: string;
  let people: ReturnType<typeof realUserAdmin>;

  beforeAll(async () => {
    people = realUserAdmin({ clock, unitOfWork, config: appConfig, cache: sharedAclCache });

    await owner.user.create({
      data: {
        id: FRANK,
        tenantId: TENANT,
        email: `${FRANK}@acl.test`,
        emailNormalized: `${FRANK}@acl.test`,
        displayName: 'frank',
        status: 'ACTIVE',
        updatedAt: FIXED_NOW,
      },
    });
    await seedRoleGrant(owner, {
      tenantId: TENANT,
      roleId: BYSTANDER_ROLE,
      key: 'BYSTANDER',
      userIds: [FRANK],
      permissions: [Permission.FOLDER_MANAGE],
      now: FIXED_NOW,
    });
    await seedRoleGrant(owner, {
      tenantId: TENANT,
      roleId: GRANTING_ROLE,
      key: 'GRANTING',
      userIds: [],
      permissions: [Permission.DOCUMENT_VIEW],
      now: FIXED_NOW,
    });

    const folder = await asAdmin(() =>
      library.libraries.createFolder({
        libraryId,
        parentId: rootFolderId,
        name: `Assignment ${uuidv7().slice(-8)}`,
        inheritAcl: true,
      }),
    );
    documentId = await seedDocument(folder.id, `Assignment procedure ${uuidv7().slice(-8)}`);
  });

  const cached = (): ReturnType<typeof realPermissions> =>
    realPermissions({
      clock,
      unitOfWork,
      config: { ...appConfig, acl: { cacheTtlSeconds: 60, maxSubjectEntries: 5_000 } },
      cache: sharedAclCache,
    });

  const asksWith = async (roles: readonly string[]): Promise<boolean> =>
    (
      await runWithContext(contextFor(FRANK, roles), () =>
        cached().resolver.resolve(
          {
            userId: FRANK,
            roleIds: roles.map((role) => asId<AnyId>(role)),
            departmentIds: [],
            delegationIds: [],
          },
          documentScope(documentId),
          Permission.DOCUMENT_VIEW,
        ),
      )
    ).allowed;

  const setRoles = (roleIds: readonly string[]): Promise<unknown> =>
    asAdmin(() => people.update(FRANK, { roleIds: [...roleIds] }, undefined));

  it('answers for the roles it was asked about, so a grant is not waiting on a TTL', async () => {
    // Warm the refusal, twice, so the second answer is the cached one.
    expect(await asksWith([BYSTANDER_ROLE])).toBe(false);
    expect(await asksWith([BYSTANDER_ROLE])).toBe(false);

    await setRoles([BYSTANDER_ROLE, GRANTING_ROLE]);

    // Nothing cleared that cache, and nothing needed to: the next token names both roles, and both
    // keys mention them, so the refusal above is not what this reads.
    expect(await asksWith([BYSTANDER_ROLE, GRANTING_ROLE])).toBe(true);
  });

  it('does the same when a role is taken away', async () => {
    expect(await asksWith([BYSTANDER_ROLE, GRANTING_ROLE])).toBe(true);
    expect(await asksWith([BYSTANDER_ROLE, GRANTING_ROLE])).toBe(true);

    await setRoles([BYSTANDER_ROLE]);

    // The revocation direction, and the one that would matter: the cached `true` above lives under
    // a key naming the role he no longer holds, so the token that no longer names it cannot read it.
    expect(await asksWith([BYSTANDER_ROLE])).toBe(false);
  });
});

// --- Fixtures -----------------------------------------------------------------------------

function subject(userId: UserId, roleId: string) {
  return {
    userId,
    roleIds: [asId<AnyId>(roleId)],
    departmentIds: [],
    delegationIds: [],
  };
}

function entry(
  subjectType: 'USER' | 'ROLE' | 'DEPARTMENT',
  subjectId: string,
  permission: (typeof Permission)[keyof typeof Permission],
  effect: 'ALLOW' | 'DENY',
) {
  return { subjectType, subjectId, permission, effect };
}

/**
 * Every audit action written so far, oldest first.
 *
 * Read with the owner client rather than through `AUDIT_SERVICE`, because the boundary lint forbids
 * a suite in one module reaching into another module's `infrastructure/` — and this is a fixture
 * read of a table, not an exercise of the audit read side, which has its own suite.
 */
async function trailActions(): Promise<readonly string[]> {
  const rows = await owner.auditEvent.findMany({
    where: { tenantId: TENANT },
    orderBy: { sequence: 'asc' },
    select: { action: true },
  });
  return rows.map((row) => row.action);
}

/**
 * A library, three folders and two documents, created the way an administrator creates them.
 *
 * Through the real services rather than as owner inserts, because the folder paths this suite's
 * whole subject depends on — the chain, the break, the subtree — are written by
 * `LibraryAdminService`, and a hand-built `path` is the one fixture that could make every
 * assertion here pass over a tree the product would never produce.
 */
async function seedTree(): Promise<void> {
  const library_ = await asAdmin(() =>
    library.libraries.createLibrary({
      code: 'ACL',
      name: 'Controlled',
      ownerScopeType: ScopeType.TENANT,
    }),
  );
  rootFolderId = library_.rootFolderId;
  libraryId = library_.id;

  const open = await asAdmin(() =>
    library.libraries.createFolder({
      libraryId: library_.id,
      parentId: rootFolderId,
      name: 'Open',
      inheritAcl: true,
    }),
  );
  openFolderId = open.id;
  const closed = await asAdmin(() =>
    library.libraries.createFolder({
      libraryId: library_.id,
      parentId: rootFolderId,
      name: 'Restricted',
      inheritAcl: true,
    }),
  );
  closedFolderId = closed.id;

  const confidentiality = await asAdmin(() =>
    library.configuration.createConfidentiality({
      code: 'INTERNAL',
      name: 'Internal',
      rank: 1,
      allowDownload: true,
      allowPrint: true,
      watermark: false,
      requireReason: false,
    }),
  );
  const rule = await asAdmin(() =>
    library.numbering.create({
      key: 'acl',
      name: 'ACL',
      separator: '-',
      segments: [
        { kind: NumberSegmentKind.LITERAL, value: 'ACL' },
        { kind: NumberSegmentKind.SEQUENCE, padding: 3 },
      ],
      resetScope: ['NEVER'],
      reserveOnSubmit: false,
      strictGapless: false,
    }),
  );
  const type = await asAdmin(() =>
    library.configuration.createDocumentType({
      code: 'PROC',
      name: 'Procedure',
      numberingRuleId: rule.id,
      defaultConfidentialityId: confidentiality.id,
      revisionLabelStyle: RevisionLabelStyle.NUMERIC,
      isActive: true,
      fields: [],
    }),
  );
  documentTypeId = type.id;

  openDocumentId = await seedDocument(openFolderId, 'Open procedure');
  closedDocumentId = await seedDocument(closedFolderId, 'Restricted procedure');
}

/**
 * A document row, written as the owner.
 *
 * The one fixture in this file that bypasses row-level security, and the reason is the upload
 * pipeline rather than the permission model: creating a document through `DocumentService` needs a
 * scanned blob behind a storage adapter, and this suite is about the chain above the document, not
 * about how its bytes arrived. Its *folder* — the thing every assertion here resolves through — was
 * created by the real service.
 */
async function seedDocument(folderId: string, title: string): Promise<string> {
  const id = uuidv7();
  const level = await owner.confidentialityLevel.findFirst({ where: { tenantId: TENANT } });
  await owner.document.create({
    data: {
      id,
      tenantId: TENANT,
      folderId,
      documentTypeId,
      confidentialityId: level?.id ?? '',
      title,
      status: 'DRAFT',
      ownerUserId: ADMIN,
      updatedAt: FIXED_NOW,
    },
  });
  return asId<DocumentId>(id);
}

/**
 * What `AuthorizationSubject.roleIds` actually accepts — Phase 6.3.
 *
 * ## Why this suite gained a section about a field name
 *
 * Phase 6.2 raised a P1: `AuthenticationMiddleware` fills `context.roles` with role **keys**, and
 * every ACL call site — `AclGuard`, `DefaultBulkExecutor`, the three reporting readers — maps that
 * array straight onto a field called `roleIds`. Read as names alone, that is a caller passing keys
 * where identifiers are required, on every request in the product.
 *
 * It is not. `PrismaAclRepository.roleIdsFor` partitions its input by UUID shape and matches
 * `role.key` **or** `role.id`, returning canonical identifiers either way — a deliberate tolerance
 * with a comment saying so. The field is misnamed; the behaviour is correct.
 *
 * That distinction cannot be settled by reading, which is why these tests exist rather than a
 * paragraph. `READER_ROLE` is a UUID and its key is the string `READER`, so the two representations
 * are genuinely different values and an equality between their decisions is a real assertion.
 */
describe('the role representation the ACL subject accepts', () => {
  it('resolves identically whether the caller carries a role key or a role id', async () => {
    const byKey = await asAlice(() =>
      permissions.resolver.resolve(
        // What every HTTP request actually carries: `context.roles` from the token's claims.
        subject(ALICE, 'READER'),
        documentScope(openDocumentId),
        Permission.DOCUMENT_VIEW,
      ),
    );
    const byId = await asAlice(() =>
      permissions.resolver.resolve(
        subject(ALICE, READER_ROLE),
        documentScope(openDocumentId),
        Permission.DOCUMENT_VIEW,
      ),
    );

    expect(byKey.allowed, 'a role key must authorise exactly as a role id does').toBe(true);
    expect(byId.allowed).toBe(true);
    // Not merely both-allowed: the *same* decision, down to which node decided it. A tolerance that
    // allowed through a different route would be a different bug wearing this one's clothes.
    expect(byKey).toEqual(byId);
  });

  it('refuses a permission the role does not hold, in both representations', async () => {
    // The negative half, which is what makes the positive half mean something. `READER` holds
    // `document:view` and `document:create` and nothing else, so neither representation may
    // produce an allow for `document:delete`.
    for (const role of ['READER', READER_ROLE]) {
      const decision = await asAlice(() =>
        permissions.resolver.resolve(
          subject(ALICE, role),
          documentScope(openDocumentId),
          Permission.DOCUMENT_DELETE,
        ),
      );
      expect(decision.allowed, `${role} must not grant document:delete`).toBe(false);
    }
  });

  it('grants nothing for a role name that matches no role at all', async () => {
    // The tolerance must not become a hole: an unrecognised string resolves to no role rather than
    // to every role, so a forged claim buys nothing. `roleIdsFor` returns an empty set and the
    // resolver falls through to closed-by-default.
    const decision = await asAlice(() =>
      permissions.resolver.resolve(
        subject(ALICE, 'ROLE_THAT_DOES_NOT_EXIST'),
        documentScope(openDocumentId),
        Permission.DOCUMENT_VIEW,
      ),
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('CLOSED_BY_DEFAULT');
  });

  it('grants nothing for another tenant’s role id', async () => {
    // A well-formed UUID naming a role that exists in some other tenant. `roleIdsFor` scopes its
    // lookup to the ambient tenant, so this resolves to no role — the same answer as a typo.
    const decision = await asAlice(() =>
      permissions.resolver.resolve(
        subject(ALICE, uuidv7()),
        documentScope(openDocumentId),
        Permission.DOCUMENT_VIEW,
      ),
    );

    expect(decision.allowed).toBe(false);
  });
});

/**
 * The names beside the entries — Slice 12, against two real tenants.
 *
 * ## What is being proved, and why a double could not
 *
 * The permissions screen used to caption its entries by fetching `/admin/users`, `/admin/roles` and
 * `/admin/departments`, so it needed `user:manage`, `role:manage` and `org:manage` — three keys the
 * seeded document controller does not hold, on a screen it is seeded to operate. The names now come
 * back on the entries, resolved for the subjects already written on the node.
 *
 * Every claim that makes that safe is a database claim: that the lookup is confined to the subjects
 * on the node, that the tenant is in the query rather than only in the policy around it, that a
 * deleted subject resolves to nothing, and that three round trips are three rather than one per
 * entry. A double would be written from the same belief as the reader it stood in for.
 */
describe('subject names', () => {
  const scope = () => documentScope(closedDocumentId);

  /** A department to name, which needs a company and an entity above it. */
  let departmentId: string;
  /** A role in a *second* tenant — a well-formed identifier this tenant must not resolve. */
  let foreignRoleId: string;
  /** A user of this tenant who is then soft-deleted, exactly as an administrator would leave one. */
  let departedId: string;

  beforeAll(async () => {
    const companyId = uuidv7();
    const entityId = uuidv7();
    departmentId = uuidv7();
    await owner.company.create({
      data: { id: companyId, tenantId: TENANT, code: 'ACME', name: 'Acme', updatedAt: FIXED_NOW },
    });
    await owner.entity.create({
      data: {
        id: entityId,
        tenantId: TENANT,
        companyId,
        code: 'ACME-UK',
        name: 'Acme UK',
        updatedAt: FIXED_NOW,
      },
    });
    await owner.department.create({
      data: {
        id: departmentId,
        tenantId: TENANT,
        entityId,
        code: 'QA',
        name: 'Quality Assurance',
        path: departmentId,
        updatedAt: FIXED_NOW,
      },
    });

    departedId = uuidv7();
    await owner.user.create({
      data: {
        id: departedId,
        tenantId: TENANT,
        email: 'departed@acl.test',
        emailNormalized: 'departed@acl.test',
        displayName: 'Someone Who Left',
        status: 'DISABLED',
        deletedAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      },
    });

    const foreignTenant = asId<TenantId>(uuidv7());
    foreignRoleId = uuidv7();
    await owner.tenant.create({
      data: {
        id: foreignTenant,
        slug: `rival-${foreignTenant.replaceAll('-', '').slice(-16)}`,
        name: 'Rival',
        status: 'ACTIVE',
      },
    });
    await owner.role.create({
      data: {
        id: foreignRoleId,
        tenantId: foreignTenant,
        key: 'RIVAL_SECRET',
        name: 'A role nobody here may read',
        isSystem: false,
        updatedAt: FIXED_NOW,
      },
    });
  }, 60_000);

  it('names the user, the role and the department an entry points at', async () => {
    await asAdmin(() =>
      permissions.permissions.replaceFor(scope(), [
        entry(AclSubjectType.USER, ALICE, Permission.DOCUMENT_VIEW, AclEffect.ALLOW),
        entry(AclSubjectType.ROLE, READER_ROLE, Permission.DOCUMENT_VIEW, AclEffect.ALLOW),
        entry(AclSubjectType.DEPARTMENT, departmentId, Permission.DOCUMENT_VIEW, AclEffect.ALLOW),
      ]),
    );

    const explicit = await asAdmin(() => permissions.permissions.explicitFor(scope()));
    const named = new Map(explicit.entries.map((row) => [row.subjectId, row.subjectName]));

    expect(named.get(ALICE)).toBe('alice');
    expect(named.get(READER_ROLE)).toBe('READER');
    expect(named.get(departmentId)).toBe('Quality Assurance');
  });

  it('returns the same captions from the write as from the read', async () => {
    // `explicitWithin` is shared by `PUT` and `GET` so that a screen re-rendering from what it just
    // saved cannot disagree with itself one refresh later. That property has to include the names.
    const written = await asAdmin(() =>
      permissions.permissions.replaceFor(scope(), [
        entry(AclSubjectType.USER, BOB, Permission.DOCUMENT_VIEW, AclEffect.ALLOW),
      ]),
    );
    const read = await asAdmin(() => permissions.permissions.explicitFor(scope()));

    expect(written.entries.map((row) => row.subjectName)).toStrictEqual(['bob']);
    expect(read.entries.map((row) => row.subjectName)).toStrictEqual(['bob']);
  });

  it('says nothing about a subject that has since been deleted', async () => {
    /*
     * An entry outlives its subject: `validate` checks the subject *type* and never that the
     * identifier names anything. Resolving deleted rows would keep a departed employee's name on a
     * permissions screen after the account was removed — and a stale entry showing a raw identifier
     * is exactly what an administrator should notice and revoke.
     */
    await asAdmin(() =>
      permissions.permissions.replaceFor(scope(), [
        entry(AclSubjectType.USER, departedId, Permission.DOCUMENT_VIEW, AclEffect.ALLOW),
      ]),
    );

    const explicit = await asAdmin(() => permissions.permissions.explicitFor(scope()));

    expect(explicit.entries).toHaveLength(1);
    expect(explicit.entries[0]?.subjectId).toBe(departedId);
    expect(explicit.entries[0]?.subjectName).toBeUndefined();
  });

  it('says nothing about an identifier that never existed, rather than failing', async () => {
    const nobody = uuidv7();
    await asAdmin(() =>
      permissions.permissions.replaceFor(scope(), [
        entry(AclSubjectType.USER, nobody, Permission.DOCUMENT_VIEW, AclEffect.ALLOW),
      ]),
    );

    const explicit = await asAdmin(() => permissions.permissions.explicitFor(scope()));

    expect(explicit.entries[0]?.subjectName).toBeUndefined();
  });

  it('cannot resolve an identifier belonging to another tenant', async () => {
    // The identifier is real and names a role — in a tenant this caller has nothing to do with.
    await asAdmin(() =>
      permissions.permissions.replaceFor(scope(), [
        entry(AclSubjectType.ROLE, foreignRoleId, Permission.DOCUMENT_VIEW, AclEffect.ALLOW),
      ]),
    );

    const explicit = await asAdmin(() => permissions.permissions.explicitFor(scope()));

    expect(explicit.entries[0]?.subjectName).toBeUndefined();
    expect(JSON.stringify(explicit)).not.toContain('A role nobody here may read');
  });

  it('asks once per subject type, never once per entry', async () => {
    /*
     * Five entries naming two users across four permissions is one query for users, one for roles,
     * and none at all for departments — not five. The spy is on the transaction client the reader
     * actually uses, because the count is the claim.
     */
    await asAdmin(() =>
      permissions.permissions.replaceFor(scope(), [
        entry(AclSubjectType.USER, ALICE, Permission.DOCUMENT_VIEW, AclEffect.ALLOW),
        entry(AclSubjectType.USER, ALICE, Permission.DOCUMENT_DOWNLOAD, AclEffect.ALLOW),
        entry(AclSubjectType.USER, ALICE, Permission.DOCUMENT_PRINT, AclEffect.ALLOW),
        entry(AclSubjectType.USER, BOB, Permission.DOCUMENT_VIEW, AclEffect.ALLOW),
        entry(AclSubjectType.ROLE, READER_ROLE, Permission.DOCUMENT_VIEW, AclEffect.ALLOW),
      ]),
    );

    const counts = { user: 0, role: 0, department: 0 };
    await asAdmin(() =>
      unitOfWork.run(async () => {
        const tx = requireTransaction();
        for (const table of ['user', 'role', 'department'] as const) {
          const model = tx[table] as unknown as {
            findMany: (args: unknown) => Promise<unknown>;
          };
          const original = model.findMany.bind(model);
          model.findMany = (args: unknown) => {
            counts[table] += 1;
            return original(args);
          };
        }
        return new PrismaAclSubjectNameReader().namesFor({
          USER: [ALICE, ALICE, ALICE, BOB],
          ROLE: [READER_ROLE],
        });
      }),
    );

    expect(counts).toStrictEqual({ user: 1, role: 1, department: 0 });
  });

  it('puts the tenant in the query itself, not only in the policy around it', async () => {
    /*
     * White-box, and deliberately so — the same argument Slice 11 recorded for the facet reader.
     * Row-level security plus a database per tenant means that removing `tenantId` from this
     * lookup changes **no observable behaviour**: the cross-tenant test above still passes, because
     * the policy catches what the query stopped catching. The clause is a second, independent
     * boundary, and the only way to assert it is to read the argument handed to Prisma.
     */
    const seen: unknown[] = [];
    await asAdmin(() =>
      unitOfWork.run(async () => {
        const tx = requireTransaction();
        for (const table of ['user', 'role', 'department'] as const) {
          const model = tx[table] as unknown as {
            findMany: (args: { where: unknown }) => Promise<unknown>;
          };
          model.findMany = (args: { where: unknown }) => {
            seen.push(args.where);
            return Promise.resolve([]);
          };
        }
        return new PrismaAclSubjectNameReader().namesFor({
          USER: [ALICE],
          ROLE: [READER_ROLE],
          DEPARTMENT: [departmentId],
        });
      }),
    );

    expect(seen).toHaveLength(3);
    for (const where of seen) {
      expect(where).toMatchObject({ tenantId: TENANT, deletedAt: null });
    }
  });

  it('asks for nothing at all when the node has no entries', async () => {
    await asAdmin(() => permissions.permissions.replaceFor(scope(), []));

    let asked = 0;
    const explicit = await asAdmin(() =>
      unitOfWork.run(async () => {
        const tx = requireTransaction();
        for (const table of ['user', 'role', 'department'] as const) {
          const model = tx[table] as unknown as { findMany: () => Promise<unknown> };
          model.findMany = () => {
            asked += 1;
            return Promise.resolve([]);
          };
        }
        return permissions.permissions.explicitFor(scope());
      }),
    );

    expect(explicit.entries).toStrictEqual([]);
    expect(asked).toBe(0);
  });
});

/**
 * Two administrators saving one node's permissions at the same moment — Slice 47.
 *
 * `uq_acl_entry` is one row per subject and permission on a node, and `replaceForScope` reads the
 * node's set before it inserts the difference. Between the two sits nothing but the caller's own
 * transaction, so both administrators can see an entry absent and both go on to insert it.
 *
 * The resolver is the seam, because the service asks it whether the caller may manage the node
 * before it reads the entries — a real port, held so both editors are inside their transactions
 * and past the guard before either reads. Both then issue their read before either read resolves,
 * which is what makes the interleaving the product's rather than the scheduler's.
 */
describe('two administrators saving one node at once', () => {
  const scope = () => folderScope(openFolderId);
  const draft = () => entry(AclSubjectType.USER, BOB, Permission.DOCUMENT_PRINT, AclEffect.ALLOW);

  type Resolver = ReturnType<typeof realPermissions>['resolver'];

  /** The real resolver, held at `resolve` until `arrivals` editors are inside it. */
  function heldAt(arrivals: number): Resolver {
    let seen = 0;
    let release: () => void = () => undefined;
    const all = new Promise<void>((resolve) => {
      release = resolve;
    });
    return new Proxy(permissions.resolver, {
      get(target, property, receiver) {
        if (property === 'resolve') {
          return async (...args: readonly unknown[]) => {
            seen += 1;
            if (seen === arrivals) {
              release();
            }
            await all;
            return (target.resolve as (...rest: readonly unknown[]) => unknown)(...args);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function'
          ? (value as (...rest: readonly unknown[]) => unknown).bind(target)
          : value;
      },
    });
  }

  function racing(resolver: Resolver) {
    return realPermissions({
      clock,
      unitOfWork,
      config: appConfig,
      cache: permissions.cache,
      resolver,
    }).permissions;
  }

  afterEach(async () => {
    await asAdmin(() => permissions.permissions.replaceFor(scope(), []));
  });

  it('grants once when one administrator saves', async () => {
    const result = await asAdmin(() => racing(heldAt(1)).replaceFor(scope(), [draft()]));

    expect(result.entries).toHaveLength(1);
    expect(
      await owner.aclEntry.count({
        where: {
          tenantId: TENANT,
          scopeId: openFolderId,
          permission: Permission.DOCUMENT_PRINT,
        },
      }),
    ).toBe(1);
  });

  it('grants nothing the second time when the same save is repeated in order', async () => {
    await asAdmin(() => permissions.permissions.replaceFor(scope(), [draft()]));
    // The sequential second-comer, which is the answer the concurrent one has to match.
    await asAdmin(() => permissions.permissions.replaceFor(scope(), [draft()]));

    expect(
      await owner.aclEntry.count({
        where: {
          tenantId: TENANT,
          scopeId: openFolderId,
          permission: Permission.DOCUMENT_PRINT,
        },
      }),
    ).toBe(1);
  });

  it('answers both of them, and writes the row once', async () => {
    const editors = racing(heldAt(2));

    const outcomes = await Promise.all([
      asAdmin(() => editors.replaceFor(scope(), [draft()])),
      asAdmin(() => editors.replaceFor(scope(), [draft()])),
    ]);

    // Neither is handed a constraint error: the loser reaches the same "nothing changed" answer
    // the sequential second save already produces.
    for (const outcome of outcomes) {
      expect(outcome.entries).toHaveLength(1);
      expect(outcome.entries[0]).toMatchObject({
        subjectId: BOB,
        permission: Permission.DOCUMENT_PRINT,
        effect: AclEffect.ALLOW,
      });
    }
    expect(
      await owner.aclEntry.count({
        where: {
          tenantId: TENANT,
          scopeId: openFolderId,
          permission: Permission.DOCUMENT_PRINT,
        },
      }),
    ).toBe(1);
  });

  it('files one grant and one confirmation, never two grants', async () => {
    const editors = racing(heldAt(2));
    const before = await owner.auditEvent.count({
      where: { tenantId: TENANT, action: 'ACL_GRANTED' },
    });

    await Promise.all([
      asAdmin(() => editors.replaceFor(scope(), [draft()])),
      asAdmin(() => editors.replaceFor(scope(), [draft()])),
    ]);

    // Both editors file an `ACL_GRANTED` row, because a `PUT` that matched is an administrator
    // confirming a set and the trail says who last reviewed the node. What must not happen is two
    // rows claiming the *act*: the loser wrote nothing, so its row is the `UPDATED` confirmation
    // with no entries, and only the winner's is `CREATED`.
    const rows = await owner.auditEvent.findMany({
      where: { tenantId: TENANT, action: 'ACL_GRANTED' },
      orderBy: { sequence: 'asc' },
      select: { payload: true },
      skip: before,
    });
    const operations = rows.map((row) => (row.payload as { operation?: string }).operation);
    expect(operations.filter((operation) => operation === 'CREATED')).toHaveLength(1);
    expect(operations.filter((operation) => operation === 'UPDATED')).toHaveLength(1);
  });
});

/**
 * Two administrators withdrawing the same entry at once — Slice 48.
 *
 * The mirror of the grant race above, and the same seam. `revoked` becomes an `ACL_REVOKED` row,
 * and that row is what an access review reads to answer "who withdrew this reach, and when". Both
 * administrators read the entry as present and both ask for it to go; only one statement can
 * actually remove it, so only one of them may be recorded as having done so.
 */
describe('two administrators withdrawing one entry at once', () => {
  const scope = () => folderScope(closedFolderId);
  const view = () => entry(AclSubjectType.USER, BOB, Permission.DOCUMENT_VIEW, AclEffect.ALLOW);
  const print = () => entry(AclSubjectType.USER, BOB, Permission.DOCUMENT_PRINT, AclEffect.ALLOW);

  type Resolver = ReturnType<typeof realPermissions>['resolver'];

  function heldAt(arrivals: number): Resolver {
    let seen = 0;
    let release: () => void = () => undefined;
    const all = new Promise<void>((resolve) => {
      release = resolve;
    });
    return new Proxy(permissions.resolver, {
      get(target, property, receiver) {
        if (property === 'resolve') {
          return async (...args: readonly unknown[]) => {
            seen += 1;
            if (seen === arrivals) {
              release();
            }
            await all;
            return (target.resolve as (...rest: readonly unknown[]) => unknown)(...args);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function'
          ? (value as (...rest: readonly unknown[]) => unknown).bind(target)
          : value;
      },
    });
  }

  function racing(resolver: Resolver) {
    return realPermissions({
      clock,
      unitOfWork,
      config: appConfig,
      cache: permissions.cache,
      resolver,
    }).permissions;
  }

  async function revocationsSince(before: number): Promise<readonly string[]> {
    const rows = await owner.auditEvent.findMany({
      where: { tenantId: TENANT, action: 'ACL_REVOKED' },
      orderBy: { sequence: 'asc' },
      select: { payload: true },
      skip: before,
    });
    return rows.map((row) => JSON.stringify(row.payload));
  }

  function countRevocations(): Promise<number> {
    return owner.auditEvent.count({ where: { tenantId: TENANT, action: 'ACL_REVOKED' } });
  }

  afterEach(async () => {
    await asAdmin(() => permissions.permissions.replaceFor(scope(), []));
  });

  it('records the withdrawal when one administrator withdraws', async () => {
    await asAdmin(() => permissions.permissions.replaceFor(scope(), [view(), print()]));
    const before = await countRevocations();

    await asAdmin(() => racing(heldAt(1)).replaceFor(scope(), [view()]));

    expect(await revocationsSince(before)).toHaveLength(1);
    expect(
      await owner.aclEntry.count({
        where: { tenantId: TENANT, scopeId: closedFolderId, permission: Permission.DOCUMENT_PRINT },
      }),
    ).toBe(0);
  });

  it('records nothing withdrawn when the same withdrawal is repeated in order', async () => {
    await asAdmin(() => permissions.permissions.replaceFor(scope(), [view(), print()]));
    await asAdmin(() => permissions.permissions.replaceFor(scope(), [view()]));
    const before = await countRevocations();

    // The sequential second-comer, which is the answer the concurrent one has to match: it sees
    // the entry already gone, so it withdraws nothing and files no revocation.
    await asAdmin(() => permissions.permissions.replaceFor(scope(), [view()]));

    expect(await revocationsSince(before)).toHaveLength(0);
  });

  it('files one revocation, not one per administrator', async () => {
    await asAdmin(() => permissions.permissions.replaceFor(scope(), [view(), print()]));
    const before = await countRevocations();
    const editors = racing(heldAt(2));

    await Promise.all([
      asAdmin(() => editors.replaceFor(scope(), [view()])),
      asAdmin(() => editors.replaceFor(scope(), [view()])),
    ]);

    // One entry existed and one statement removed it. A second `ACL_REVOKED` would name an
    // administrator for an act somebody else performed.
    const written = await revocationsSince(before);
    expect(written).toHaveLength(1);
    expect(written[0]).toContain(Permission.DOCUMENT_PRINT);
    expect(
      await owner.aclEntry.count({
        where: { tenantId: TENANT, scopeId: closedFolderId, permission: Permission.DOCUMENT_PRINT },
      }),
    ).toBe(0);
  });

  it('withdraws every entry an edit names, not just the first', async () => {
    const download = () =>
      entry(AclSubjectType.USER, BOB, Permission.DOCUMENT_DOWNLOAD, AclEffect.ALLOW);
    await asAdmin(() => permissions.permissions.replaceFor(scope(), [view(), print(), download()]));
    const before = await countRevocations();
    const editors = racing(heldAt(2));

    // One editor withdraws *two* entries and the other withdraws one of the same two, so a loop
    // that stopped after its first removal would leave a live entry behind. Tolerating a delete
    // that hit nothing must not become tolerating a delete that never ran.
    await Promise.all([
      asAdmin(() => editors.replaceFor(scope(), [view()])),
      asAdmin(() => editors.replaceFor(scope(), [view(), print()])),
    ]);

    const live = await owner.aclEntry.findMany({
      where: { tenantId: TENANT, scopeId: closedFolderId },
      select: { permission: true },
    });
    expect(live.map((row) => row.permission)).toStrictEqual([Permission.DOCUMENT_VIEW]);
    // Two entries went, and between them the two editors are recorded as withdrawing each once.
    const written = await revocationsSince(before);
    expect(written.join(' ').match(/document:print/g) ?? []).toHaveLength(1);
    expect(written.join(' ').match(/document:download/g) ?? []).toHaveLength(1);
  });
});
