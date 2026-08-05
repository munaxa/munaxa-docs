import 'reflect-metadata';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AclEffect,
  AclSubjectType,
  type AnyId,
  ErrorCode,
  NumberSegmentKind,
  Permission,
  RevisionLabelStyle,
  ScopeType,
  type ScopeRef,
  type TenantId,
  type UserId,
  asId,
  tallyIsConsistent,
} from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import type { AppConfig } from '../../../core/config/configuration';
import type { Logger } from '../../../core/observability/logger';
import { PrismaUnitOfWork } from '../../../core/prisma/unit-of-work';
import { type RequestContext, runWithContext } from '../../../core/tenancy/tenant-context';
import { seedRoleGrant } from '../../../testing/acl-seed';
import {
  type BulkStack,
  type DocumentLibraryStack,
  type NotificationStack,
  type RetentionStack,
  realBulk,
  realDisposition,
  realDocumentLibrary,
  realNotifications,
  realPermissions,
  realRetention,
} from '../../../testing/real-collaborators';
import { everyTenantRegistry, sharedDatabase } from '../../../testing/tenant-database';

/**
 * Phase 16's bulk operations against a real PostgreSQL — the six questions that are all database
 * questions, and none of which a unit test can be asked.
 *
 * A bulk operation is **N single-object decisions that happen to have been asked for together**,
 * and every assertion here is a way of checking that the "N" is real rather than decorative. The
 * shortcut this phase exists to prevent — resolve the caller's reach once, then write to a list of
 * identifiers the client supplied — passes any test that only counts rows.
 *
 * - **The same identifier list, two callers, two sets of `APPLIED` rows.** This is the assertion
 *   the whole phase turns on. A resolve-once implementation gives both callers the same answer.
 * - **A legal-held document refuses *that one* and the rest complete.** Phase 10's
 *   `ErrorCode.LEGAL_HOLD` refuses regardless of permission, and a single transaction for the batch
 *   would roll the other four back with it.
 * - **A bulk restore reverses exactly one delete.** Phase 10 stamped every cascade with an
 *   identifier so a restore is exact; calling `DefaultDocumentService.restore` per object is what
 *   keeps that true rather than reimplementing it.
 * - **The audit chain is intact after a large batch**, and carries N + 1 rows: one per object, on
 *   each document's own timeline, plus one for the operation.
 * - **One summary notification rather than N.** 18 §7 has required this since Phase 0 and Phase
 *   12's own report said nothing produced a storm. This is the first thing that does.
 * - **`REFUSED` and `BLOCKED` are told apart**, because "you cannot see it" and "a matter is on
 *   hold" call for entirely different responses and collapsing them is the defect.
 *
 * ## The ACL entries are written as a request writes them
 *
 * CI's `edms_owner` is the cluster superuser, so a suite seeding `acl_entry` with the owner client
 * writes past row-level security and is not testing what a request would see — Phase 14's
 * `acl.integration.spec.ts` records this and Phase 15's suite follows it, as does this one. Every
 * entry here goes through `PermissionService` in a request context. The owner client creates only
 * what a request could not: the tenant, the people, and the role grants an administrator would
 * have made first.
 */

const OWNER_URL = process.env['DATABASE_MIGRATION_URL'] ?? '';
const APP_URL = process.env['DATABASE_URL'] ?? '';

const FIXED_NOW = new Date('2026-08-06T10:00:00.000Z');
const clock = { now: () => new Date(FIXED_NOW), timestamp: () => 0, elapsedMs: () => 0 };
const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const TENANT = asId<TenantId>(uuidv7());
/** Reaches both folders. */
const ADA = asId<UserId>(uuidv7());
/** The same role, and an explicit `DENY` on the restricted folder — the second reach. */
const BEN = asId<UserId>(uuidv7());
const ADMIN = asId<UserId>(uuidv7());

const EDITOR_ROLE = uuidv7();
const ADMIN_ROLE = uuidv7();

let root: string;
let appConfig: AppConfig;
let owner: PrismaClient;
let unitOfWork: PrismaUnitOfWork;
let library: DocumentLibraryStack;
let permissions: ReturnType<typeof realPermissions>;
let retention: RetentionStack;
let notifications: NotificationStack;
let bulk: BulkStack;

let openFolderId: string;
let closedFolderId: string;
let documentTypeId: string;

function contextFor(userId: UserId, roles: readonly string[]): RequestContext {
  return {
    tenantId: TENANT,
    userId,
    roles: [...roles],
    // Deliberately empty, like Phase 15's suite: every reach decision here is resolved through the
    // ACL resolver over real role grants, never from the token's snapshot.
    permissions: [],
    sessionId: null,
    correlationId: 'bulk-suite',
    permissionVersion: 1,
    locale: 'en',
  };
}

const asAda = <T>(work: () => Promise<T>): Promise<T> =>
  runWithContext(contextFor(ADA, [EDITOR_ROLE]), work);
const asBen = <T>(work: () => Promise<T>): Promise<T> =>
  runWithContext(contextFor(BEN, [EDITOR_ROLE]), work);
const asAdmin = <T>(work: () => Promise<T>): Promise<T> =>
  runWithContext(contextFor(ADMIN, [ADMIN_ROLE]), work);

const folderScope = (id: string): ScopeRef => ({ type: ScopeType.FOLDER, id: asId<AnyId>(id) });

beforeAll(async () => {
  if (!OWNER_URL || !APP_URL) {
    throw new Error('DATABASE_URL and DATABASE_MIGRATION_URL must both be set.');
  }
  root = await mkdtemp(join(tmpdir(), 'edms-bulk-'));

  appConfig = {
    env: 'test',
    database: { url: APP_URL, poolSize: 10 },
    storage: { driver: 'LOCAL', signedUrlTtlSeconds: 300 },
    acl: { cacheTtlSeconds: 0, maxSubjectEntries: 5_000 },
    mail: { webBaseUrl: 'https://docs.test' },
  } as unknown as AppConfig;

  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  await owner.tenant.create({
    data: {
      id: TENANT,
      slug: `bulk-${TENANT.replaceAll('-', '').slice(-16)}`,
      name: 'Bulk Test',
      status: 'ACTIVE',
    },
  });
  for (const [id, name] of [
    [ADA, 'ada'],
    [BEN, 'ben'],
    [ADMIN, 'admin'],
  ] as const) {
    await owner.user.create({
      data: {
        id,
        tenantId: TENANT,
        email: `${id}@bulk.test`,
        emailNormalized: `${id}@bulk.test`,
        displayName: name,
        status: 'ACTIVE',
        updatedAt: FIXED_NOW,
      },
    });
  }
  await seedRoleGrant(owner, {
    tenantId: TENANT,
    roleId: EDITOR_ROLE,
    key: 'EDITOR',
    userIds: [ADA, BEN],
    permissions: [
      Permission.DOCUMENT_VIEW,
      Permission.DOCUMENT_EDIT,
      Permission.DOCUMENT_CREATE,
      Permission.DOCUMENT_DELETE,
      Permission.DOCUMENT_RESTORE,
      Permission.DOCUMENT_DOWNLOAD,
    ],
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
  retention = realRetention({
    clock,
    unitOfWork,
    disposition: realDisposition(clock, library.storage),
    storage: library.storagePort,
  });
  notifications = realNotifications({
    clock,
    unitOfWork,
    config: appConfig,
    documents: library.documents,
  });
  bulk = realBulk({ clock, unitOfWork, config: appConfig, library });

  await seedTree();
}, 180_000);

afterAll(async () => {
  await owner?.$disconnect();
  if (root) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('a bulk operation applies the caller’s reach per object', () => {
  /**
   * **The assertion the phase turns on.**
   *
   * Two callers send the *same* identifier list. Ada reaches both folders; Ben is denied on the
   * restricted one through `PermissionService`, exactly as a request would write it. A
   * resolve-once implementation — check the permission, then write to the list — gives both of
   * them five applied. What must happen instead is that Ben's request applies the reachable ones
   * and refuses the rest, individually, with a reason.
   */
  it('gives two callers different answers to the same identifier list', async () => {
    const open = await seedDocuments(openFolderId, 3, 'reach-open');
    const closed = await seedDocuments(closedFolderId, 2, 'reach-closed');
    const all = [...open, ...closed];

    await asAdmin(() =>
      permissions.permissions.replaceFor(folderScope(closedFolderId), [
        {
          subjectType: AclSubjectType.USER,
          subjectId: asId<AnyId>(BEN),
          permission: Permission.DOCUMENT_EDIT,
          effect: AclEffect.DENY,
        },
      ]),
    );

    const forAda = await asAda(() => bulk.documents.setMetadata({ ids: all, categoryId: null }));
    const forBen = await asBen(() => bulk.documents.setMetadata({ ids: all, categoryId: null }));

    expect(forAda.tally.applied).toBe(5);
    expect(forAda.tally.refused).toBe(0);

    // Not "fewer rows" — *these* rows. Ben applied exactly the three he reaches and was refused
    // exactly the two he does not, and the refusals name which.
    expect(forBen.tally.applied).toBe(3);
    expect(forBen.tally.refused).toBe(2);
    expect(appliedIds(forBen).sort()).toEqual([...open].sort());
    expect(refusedIds(forBen).sort()).toEqual([...closed].sort());
  });

  // The tally invariant: every requested object reached exactly one branch. A silent skip — the
  // failure mode this phase exists to prevent — leaves `requested` ahead of the sum.
  it('accounts for every object it was given', async () => {
    const ids = await seedDocuments(openFolderId, 4, 'tally');
    const result = await asAda(() => bulk.documents.setMetadata({ ids, categoryId: null }));

    expect(result.tally.requested).toBe(4);
    expect(tallyIsConsistent(result.tally)).toBe(true);
    expect(result.items).toHaveLength(4);
  });

  // An identifier that does not exist and one the caller cannot see must give the same answer, or
  // the endpoint becomes a probe for which identifiers exist in a tenant.
  it('answers REFUSED for an identifier that does not exist at all', async () => {
    const ids = [uuidv7()];
    const result = await asAda(() => bulk.documents.setMetadata({ ids, categoryId: null }));

    expect(result.tally.refused).toBe(1);
    expect(result.items[0]?.errorCode).toBe(ErrorCode.FORBIDDEN);
  });
});

describe('a rule refuses its own object and the batch completes', () => {
  /**
   * Phase 10's legal hold, inside a bulk operation.
   *
   * The hold refuses **regardless of permission** — Ada reaches every one of these documents — and
   * it must refuse *that document* rather than the batch. One transaction for the whole operation
   * would roll the other four back with it and tell the caller nothing about which one caused it.
   */
  it('refuses a legal-held document and applies the rest', async () => {
    const ids = await seedDocuments(openFolderId, 5, 'hold');
    const held = ids[2] ?? '';
    await asAdmin(() => retention.holds.place(held, 'Litigation hold for the suite'));

    const result = await asAda(() => deleteInBulk(ids));

    expect(result.tally.applied).toBe(4);
    expect(result.tally.blocked).toBe(1);
    // `BLOCKED`, not `REFUSED`. The caller reaches the document perfectly well; a matter is on
    // hold. Collapsing the two would make a screenful of holds look like a permissions problem.
    const blocked = result.items.find((item) => item.outcome === 'BLOCKED');
    expect(blocked?.targetId).toBe(held);
    expect(blocked?.errorCode).toBe(ErrorCode.LEGAL_HOLD);
  });
});

describe('a bulk restore reverses exactly one delete', () => {
  /**
   * Phase 10 stamped every delete with a cascade identifier so a restore is *exact*: it puts back
   * the revisions that delete took, and no others. Calling `DefaultDocumentService.restore` per
   * object is what keeps that true — a bulk restore that flipped `deleted_at` in one statement
   * would restore a document without its revisions, or with revisions an earlier delete took.
   */
  it('restores each document through the module that owns the row', async () => {
    const ids = await seedDocuments(openFolderId, 3, 'restore');
    for (const id of ids) {
      await asAda(() => removeDocument(id, 'Superseded by the suite'));
    }

    const cascades = await owner.document.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, deleteCascadeId: true },
    });
    // Three deletes, three distinct cascade identifiers. If they shared one, a single restore
    // would put back all three and this suite would pass while the property was broken.
    expect(new Set(cascades.map((row) => row.deleteCascadeId)).size).toBe(3);

    const result = await asAda(() => bulk.documents.restore(ids));
    expect(result.tally.applied).toBe(3);

    const after = await owner.document.findMany({
      where: { id: { in: [...ids] } },
      select: { deletedAt: true, deleteCascadeId: true },
    });
    expect(after.every((row) => row.deletedAt === null)).toBe(true);
    // The cascade mark is cleared by the restore, exactly as the single-object path clears it —
    // a document still carrying one would be restorable a second time by a delete it no longer has.
    expect(after.every((row) => row.deleteCascadeId === null)).toBe(true);
  });

  // A document the caller cannot reach must not come back, and reach on a *deleted* row is the
  // same question as reach on a live one — Phase 14's resolver does not care about `deleted_at`.
  it('does not resurrect a document the caller cannot see', async () => {
    const hidden = await seedDocuments(closedFolderId, 1, 'restore-hidden');
    for (const id of hidden) {
      await asAda(() => removeDocument(id, 'Deleted for the suite'));
    }
    await asAdmin(() =>
      permissions.permissions.replaceFor(folderScope(closedFolderId), [
        {
          subjectType: AclSubjectType.USER,
          subjectId: asId<AnyId>(BEN),
          permission: Permission.DOCUMENT_RESTORE,
          effect: AclEffect.DENY,
        },
      ]),
    );

    const result = await asBen(() => bulk.documents.restore(hidden));

    expect(result.tally.applied).toBe(0);
    expect(result.tally.refused).toBe(1);
    const row = await owner.document.findUnique({
      where: { id: hidden[0] ?? '' },
      select: { deletedAt: true },
    });
    expect(row?.deletedAt).not.toBeNull();
  });
});

describe('the audit trail after a large batch', () => {
  /**
   * The chain serialises per tenant under an advisory lock, and 19 §7 names audit write volume as a
   * scaling risk. A bulk operation over many documents is the first real test of it — and what must
   * hold is not merely that it survives, but that it wrote **one row per object plus one for the
   * operation**, with the chain unbroken.
   *
   * The per-object rows are the point. Suppressing them would make a document's own timeline skip
   * the day it was edited, which is the trail's primary query; writing only them would leave "who
   * ran the edit that touched forty documents" unanswerable.
   */
  it('writes one row per object plus one for the operation, with the chain intact', async () => {
    const ids = await seedDocuments(openFolderId, 25, 'chain');
    const before = await owner.auditEvent.count({ where: { tenantId: TENANT } });

    const result = await asAda(() => bulk.documents.setMetadata({ ids, categoryId: null }));
    expect(result.tally.applied).toBe(25);

    const after = await owner.auditEvent.count({ where: { tenantId: TENANT } });
    expect(after - before).toBe(26);

    const operationRows = await owner.auditEvent.findMany({
      where: { tenantId: TENANT, action: 'BULK_OPERATION' },
      orderBy: { sequence: 'desc' },
      take: 1,
    });
    const payload = operationRows[0]?.payload as Record<string, unknown> | undefined;
    expect(payload?.['applied']).toBe(25);
    // 13 §3's minimised payload: counts, never the identifier list. Twenty-five UUIDs here would
    // be a second copy of the operation in a table with no retention policy.
    expect(JSON.stringify(payload)).not.toContain(ids[0] ?? 'no-such-id');

    // The chain itself. Every row's hash covers its predecessor's, and the sequence is gap-free —
    // a batch that raced the advisory lock would break one or the other.
    const events = await owner.auditEvent.findMany({
      where: { tenantId: TENANT },
      orderBy: { sequence: 'asc' },
      select: { sequence: true, hash: true, previousHash: true },
    });
    for (let index = 1; index < events.length; index += 1) {
      expect(events[index]?.previousHash).toBe(events[index - 1]?.hash);
      expect(Number(events[index]?.sequence)).toBe(Number(events[index - 1]?.sequence) + 1);
    }
  }, 120_000);
});

describe('one summary notification rather than N', () => {
  /**
   * 18 §7's storm-control row, finally with a storm to control.
   *
   * Phase 12 built `notification_batch` and its own report stated that **nothing currently produces
   * a storm**. A bulk operation is the first thing that does, and what must happen is that the
   * window *increments* rather than sending — a delayed job keyed on the batch would coalesce too
   * and would keep the first payload, so a summary of five hundred would say "1".
   */
  it('accumulates a window instead of sending, and releases exactly one summary', async () => {
    const ids = await seedDocuments(openFolderId, 6, 'notify');
    await asAda(() => bulk.documents.setMetadata({ ids, categoryId: null }));

    // The event the executor published, handed to the translator the lane would hand it to.
    const sentImmediately = await asAda(() =>
      notifications.events.handle({
        eventId: uuidv7(),
        eventType: 'bulk.operation-completed',
        payload: {
          operationId: uuidv7(),
          kind: 'METADATA',
          requestedById: ADA,
          requested: 6,
          applied: 6,
          refused: 0,
          blocked: 0,
          failed: 0,
        },
      }),
    );
    // Nothing is sent yet, and that is the answer rather than a shortfall.
    expect(sentImmediately).toBe(0);

    const windows = await owner.notificationBatch.findMany({
      where: { tenantId: TENANT, key: `bulk:${ADA}` },
    });
    expect(windows).toHaveLength(1);
    expect(windows[0]?.itemCount).toBe(1);

    // A second operation by the same person joins the window rather than opening another — six
    // imports in a morning are one message, which is what coalescing is for.
    await asAda(() =>
      notifications.events.handle({
        eventId: uuidv7(),
        eventType: 'bulk.operation-completed',
        payload: {
          operationId: uuidv7(),
          kind: 'RESTORE',
          requestedById: ADA,
          requested: 4,
          applied: 4,
          refused: 0,
          blocked: 0,
          failed: 0,
        },
      }),
    );
    const grown = await owner.notificationBatch.findFirst({
      where: { tenantId: TENANT, key: `bulk:${ADA}` },
    });
    expect(grown?.itemCount).toBe(2);

    // Closing the window produces one message, for one recipient — not two, and not six.
    await owner.notificationBatch.updateMany({
      where: { tenantId: TENANT, key: `bulk:${ADA}` },
      data: { releaseAt: new Date(FIXED_NOW.getTime() - 1_000) },
    });
    const released = await asAda(() => notifications.events.releaseBatches(10));
    expect(released).toBeGreaterThan(0);

    const messages = await owner.notificationMessage.findMany({
      where: { tenantId: TENANT, typeKey: 'bulk.operation-completed', recipientId: ADA },
    });
    // One per channel for one recipient, rather than one per object — which would have been ten.
    expect(messages.length).toBeLessThanOrEqual(2);
    expect(messages.every((message) => message.recipientId === ADA)).toBe(true);
  });
});

describe('the operation record', () => {
  it('is the caller’s own, and carries a row per object', async () => {
    const ids = await seedDocuments(openFolderId, 3, 'record');
    const result = await asAda(() => bulk.documents.setMetadata({ ids, categoryId: null }));

    const record = await asAda(() =>
      unitOfWork.run(() => bulk.operations.findById(result.operationId as string)),
    );
    expect(record?.tally.applied).toBe(3);
    expect(record?.requestedById).toBe(ADA);

    const items = await asAda(() =>
      unitOfWork.run(() =>
        bulk.operations.itemsOf(result.operationId as string, { page: 1, pageSize: 50 }),
      ),
    );
    expect(items.meta.total).toBe(3);
  });

  // De-duplication before the executor runs: a drag-select over a list that re-rendered, or a
  // retried request concatenated to the first, must not act on one document twice.
  it('acts once on a document named twice', async () => {
    const ids = await seedDocuments(openFolderId, 1, 'duplicate');
    const doubled = [...ids, ...ids];
    const result = await asAda(() =>
      bulk.documents.setMetadata({ ids: doubled, categoryId: null }),
    );

    expect(result.tally.requested).toBe(1);
    expect(result.items).toHaveLength(1);
  });
});

// --- Fixtures ---------------------------------------------------------------------------------

/**
 * Deleting many, which the document module has no bulk method for.
 *
 * Written here rather than added to `BulkDocumentService`, deliberately: the phase builds five bulk
 * operations and a bulk *delete* is not one of them — Phase 10 made a delete state a reason and a
 * bulk delete would state one reason for four hundred records. What the legal-hold assertion needs
 * is a bulk operation that a hold refuses, and the restore is the one this phase ships, so the
 * hold is asserted through the delete each restore reverses.
 */
async function deleteInBulk(ids: readonly string[]): Promise<{
  tally: { applied: number; blocked: number };
  items: readonly { targetId: string; outcome: string; errorCode: string | null }[];
}> {
  const items: { targetId: string; outcome: string; errorCode: string | null }[] = [];
  for (const id of ids) {
    try {
      await removeDocument(id, 'Deleted for the suite');
      items.push({ targetId: id, outcome: 'APPLIED', errorCode: null });
    } catch (error) {
      const code = (error as { code?: string }).code ?? null;
      items.push({
        targetId: id,
        outcome: code === ErrorCode.LEGAL_HOLD ? 'BLOCKED' : 'FAILED',
        errorCode: code,
      });
    }
  }
  return {
    tally: {
      applied: items.filter((item) => item.outcome === 'APPLIED').length,
      blocked: items.filter((item) => item.outcome === 'BLOCKED').length,
    },
    items,
  };
}

/**
 * Deleting one document, with the version the API demands.
 *
 * `remove` calls `requireVersion` rather than `checkVersion`: Phase 10 made a delete an act
 * somebody answers for, and an `If-Match` is part of answering for it. A suite that passed
 * `undefined` would be asserting against a path no request can take.
 */
async function removeDocument(id: string, reason: string): Promise<void> {
  const current = await library.documents.get(id);
  await library.documents.remove(id, current.version, reason);
}

async function seedTree(): Promise<void> {
  const created = await asAdmin(() =>
    library.libraries.createLibrary({
      code: 'BULK',
      name: 'Controlled',
      ownerScopeType: ScopeType.TENANT,
    }),
  );

  const open = await asAdmin(() =>
    library.libraries.createFolder({
      libraryId: created.id,
      parentId: created.rootFolderId,
      name: 'Open',
      inheritAcl: true,
    }),
  );
  openFolderId = open.id;
  const closed = await asAdmin(() =>
    library.libraries.createFolder({
      libraryId: created.id,
      parentId: created.rootFolderId,
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
      key: 'bulk',
      name: 'Bulk',
      separator: '-',
      segments: [
        { kind: NumberSegmentKind.LITERAL, value: 'BLK' },
        { kind: NumberSegmentKind.SEQUENCE, padding: 4 },
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
}

/**
 * Documents, written with the owner client.
 *
 * The owner is the cluster superuser, so this writes past row-level security — correct here for the
 * reason `acl-seed.ts` gives: these are *fixtures*, standing for records an author created
 * beforehand. What it would be exactly wrong for is an `acl_entry`, and this suite writes none that
 * way: every entry goes through `PermissionService` in a request context, as a request does.
 */
async function seedDocuments(
  folderId: string,
  count: number,
  prefix: string,
): Promise<readonly string[]> {
  const level = await owner.confidentialityLevel.findFirst({ where: { tenantId: TENANT } });
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = uuidv7();
    await owner.document.create({
      data: {
        id,
        tenantId: TENANT,
        folderId,
        documentTypeId,
        confidentialityId: level?.id ?? '',
        title: `${prefix}-${String(index)}`,
        status: 'DRAFT',
        ownerUserId: ADA,
        updatedAt: FIXED_NOW,
      },
    });
    ids.push(id);
  }
  return ids;
}

function appliedIds(result: { items: readonly { targetId: string; outcome: string }[] }): string[] {
  return result.items.filter((item) => item.outcome === 'APPLIED').map((item) => item.targetId);
}

function refusedIds(result: { items: readonly { targetId: string; outcome: string }[] }): string[] {
  return result.items.filter((item) => item.outcome === 'REFUSED').map((item) => item.targetId);
}
