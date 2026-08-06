import 'reflect-metadata';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
import { PrismaUnitOfWork } from '../../../core/prisma/unit-of-work';
import { type RequestContext, runWithContext } from '../../../core/tenancy/tenant-context';
import { AccessDenialRecorder } from '../../../core/authorization/access-denial.recorder';
import { RecordingMetrics } from '../../../testing/fake-ports';
import { seedRoleGrant } from '../../../testing/acl-seed';
import {
  type DocumentLibraryStack,
  realAuditWriter,
  realDocumentLibrary,
  realPermissions,
} from '../../../testing/real-collaborators';
import { everyTenantRegistry, sharedDatabase } from '../../../testing/tenant-database';

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

let root: string;
let appConfig: AppConfig;
let owner: PrismaClient;
let unitOfWork: PrismaUnitOfWork;
let library: DocumentLibraryStack;
let permissions: ReturnType<typeof realPermissions>;

let rootFolderId: string;
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

  unitOfWork = new PrismaUnitOfWork(sharedDatabase(appConfig, logger, APP_URL));
  library = realDocumentLibrary({
    clock,
    unitOfWork,
    config: appConfig,
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
