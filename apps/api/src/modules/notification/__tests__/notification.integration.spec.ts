import 'reflect-metadata';

import { PrismaClient } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  type DocumentId,
  type TenantId,
  type UserId,
  DeliveryState,
  DigestFrequency,
  NotificationChannel,
  Permission,
  Settings,
  asId,
} from '@edms/domain';
import { normalizePageRequest, uuidv7 } from '@edms/utils';

import type { AppConfig } from '../../../core/config/configuration';
import type { Logger } from '../../../core/observability/logger';
import { PrismaUnitOfWork } from '../../../core/prisma/unit-of-work';
import { type RequestContext, runWithContext } from '../../../core/tenancy/tenant-context';
import type { DocumentRecord, DocumentService } from '../../document/application/ports';
import { type NotificationStack, realNotifications } from '../../../testing/real-collaborators';
import { sharedDatabase } from '../../../testing/tenant-database';
import { NotificationType } from '../domain/notification-types';
import { NotificationAudit } from '../domain/audit-actions';

/**
 * Phase 12 against a real PostgreSQL — the assertions only a database can be trusted about.
 *
 * Every one of these is a question about what is in a table *at an instant*, which is precisely
 * what a repository double cannot be asked: a double answers from the same belief as the code
 * under test, and every rule 18 §§5 and 7 state is a rule about time passing or about a row
 * somebody else wrote.
 *
 * - **An event consumed once produces one message per recipient and channel, and the same event
 *   redelivered produces none** — the idempotency key, against the unique index that enforces it.
 * - **A preference silences a type, and cannot silence a mandatory one.**
 * - **A digest collects a window and releases it as one message**, with its members moved to
 *   `DIGESTED` and pointing at the summary that carried them.
 * - **Quiet hours hold a non-urgent message and release it afterwards**, with the urgent one
 *   beside it going out immediately.
 * - **A hard bounce suppresses an address**, so the next send is `SUPPRESSED` rather than
 *   attempted — and the suppression is in the audit trail.
 * - **A bulk sweep produces one summary rather than five hundred rows.**
 * - **A recipient who may not see the document is not told about it** — the phase's named risk,
 *   asserted through the real ACL resolver rather than a stub.
 */

const OWNER_URL = process.env['DATABASE_MIGRATION_URL'] ?? '';
const APP_URL = process.env['DATABASE_URL'] ?? '';

/** Movable, because half of these assertions are about a window closing. */
let now = new Date('2026-08-05T09:00:00.000Z');
const clock = { now: () => new Date(now), timestamp: () => 0, elapsedMs: () => 0 };

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const TENANT = asId<TenantId>(uuidv7());
/** The document's owner and author. Sees everything. */
const ADA = asId<UserId>(uuidv7());
/** An approver who holds `document:view` — the ordinary recipient. */
const BOB = asId<UserId>(uuidv7());
/** Holds no role at all: the person the ACL walk refuses. */
const MALLORY = asId<UserId>(uuidv7());
/** Holds `user:manage`, `retention:manage` and `audit:view` — the three capabilities §4 addresses. */
const ADMIN = asId<UserId>(uuidv7());

const DOCUMENT = asId<DocumentId>(uuidv7());

const PEOPLE: readonly (readonly [UserId, string])[] = [
  [ADA, 'ada'],
  [BOB, 'bob'],
  [MALLORY, 'mallory'],
  [ADMIN, 'admin'],
];

/** Distinct per person, because `(tenant_id, email_normalized)` is unique and a UUID prefix is not. */
function addressOf(name: string): string {
  return `${name}@notif.test`;
}

let owner: PrismaClient;
let unitOfWork: PrismaUnitOfWork;
let stack: NotificationStack;
/** A second stack whose bounce threshold is one, so the suppression assertion needs one bounce. */
let strict: NotificationStack;

const appConfig = {
  env: 'test',
  database: { url: APP_URL, poolSize: 10 },
  mail: {
    resendApiKey: null,
    resendEndpoint: 'https://example.invalid/emails',
    timeoutMs: 1_000,
    fromAddress: 'docs@example.test',
    fromName: 'Munaxa Docs',
    webBaseUrl: 'https://docs.example.test',
  },
} as unknown as AppConfig;

/**
 * Document's public surface, stood in for.
 *
 * The real one belongs to Document and this suite is about what Notification does with the
 * answer, not about whether Document reads its own table — which its own suite proves. The
 * *visibility* half is emphatically not stubbed: `RecipientVisibilityService` runs the real
 * `PrismaAclResolver` against the real roles seeded below, because that is the assertion.
 */
const documents: DocumentService = {
  get: (id) =>
    Promise.resolve(
      id === DOCUMENT
        ? ({
            id: DOCUMENT,
            title: 'Supplier Audit Procedure',
            documentNumber: 'QA-001',
            ownerUserId: ADA,
            createdBy: BOB,
          } as unknown as DocumentRecord)
        : null,
    ),
  exists: () => Promise.resolve(true),
  availableTransitions: () => Promise.resolve([]),
  restore: () => Promise.resolve(),
  expireEffective: () => Promise.resolve({ examined: 0, expired: 0 }),
};

function contextFor(userId: UserId | null): RequestContext {
  return {
    tenantId: TENANT,
    userId,
    roles: [],
    permissions: [],
    sessionId: null,
    correlationId: 'notification-integration',
    permissionVersion: 1,
    locale: 'en',
  };
}

/** The lane runs as nobody: a committed event acted, not a person. */
function asSystem<T>(work: () => Promise<T>): Promise<T> {
  return runWithContext(contextFor(null), work);
}

function inTransaction<T>(work: () => Promise<T>, userId: UserId | null = null): Promise<T> {
  return runWithContext(contextFor(userId), () => unitOfWork.run(work));
}

/** Every message in the tenant, straight from the table — never through the code under test. */
async function messagesFor(
  recipientId: UserId,
  typeKey?: string,
): Promise<
  { channel: string; state: string; releaseAt: Date | null; digestMessageId: string | null }[]
> {
  return owner.notificationMessage.findMany({
    where: { tenantId: TENANT, recipientId, ...(typeKey ? { typeKey } : {}) },
    orderBy: { createdAt: 'asc' },
    select: { channel: true, state: true, releaseAt: true, digestMessageId: true },
  });
}

beforeAll(async () => {
  if (!OWNER_URL || !APP_URL) {
    throw new Error('DATABASE_URL and DATABASE_MIGRATION_URL must both be set.');
  }
  const prisma = sharedDatabase(appConfig, logger, APP_URL);
  unitOfWork = new PrismaUnitOfWork(prisma);
  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });

  await owner.tenant.create({
    data: {
      id: TENANT,
      slug: `nt-${String(Date.now())}-${TENANT.slice(0, 8)}`,
      name: 'Notification Test',
      status: 'ACTIVE',
    },
  });

  // A reader's role and an administrator's. The ACL resolver falls through to the tenant-level
  // role grant, so holding `document:view` through a role is exactly what "may see the document"
  // means today — and Mallory's holding no role is what makes the refusal real rather than
  // arranged.
  const reader = await owner.role.create({
    data: {
      id: uuidv7(),
      tenantId: TENANT,
      key: `reader-${TENANT.slice(0, 8)}`,
      name: 'Reader',
      isSystem: false,
      updatedAt: clock.now(),
      permissions: { create: [{ tenantId: TENANT, permission: Permission.DOCUMENT_VIEW }] },
    },
  });
  const administrator = await owner.role.create({
    data: {
      id: uuidv7(),
      tenantId: TENANT,
      key: `admin-${TENANT.slice(0, 8)}`,
      name: 'Administrator',
      isSystem: false,
      updatedAt: clock.now(),
      permissions: {
        create: [
          { tenantId: TENANT, permission: Permission.DOCUMENT_VIEW },
          { tenantId: TENANT, permission: Permission.USER_MANAGE },
          { tenantId: TENANT, permission: Permission.RETENTION_MANAGE },
          { tenantId: TENANT, permission: Permission.AUDIT_VIEW },
        ],
      },
    },
  });

  for (const [id, name] of PEOPLE) {
    await owner.user.create({
      data: {
        id,
        tenantId: TENANT,
        email: addressOf(name),
        emailNormalized: addressOf(name),
        displayName: name,
        status: 'ACTIVE',
        updatedAt: clock.now(),
      },
    });
  }
  for (const [userId, roleId] of [
    [ADA, reader.id],
    [BOB, reader.id],
    [ADMIN, administrator.id],
  ] as const) {
    await owner.userRole.create({
      data: { tenantId: TENANT, userId, roleId, assignedAt: clock.now() },
    });
  }

  // Phase 14: the walk is object-dependent, so the document the recipient filter asks about has to
  // exist. Before the ACL entries and the chain, `resolve` answered from the caller's role grants
  // without consulting the object at all — which is exactly what `AccessDenialRecorder`'s comment
  // says stops being true when the walk arrives. A recipient list filtered against a document id
  // naming nothing would now refuse everybody, so this suite seeds the real chain: a tenant-owned
  // library, its root folder, and the document in it.
  await seedDocumentChain();

  stack = realNotifications({ clock, unitOfWork, config: appConfig, documents });
  strict = realNotifications({
    clock,
    unitOfWork,
    config: appConfig,
    documents,
    settings: { [Settings.NOTIFICATION_BOUNCE_THRESHOLD.key]: 1 },
  });
}, 90_000);

/** The smallest chain the ACL walk can cross: tenant → library → root folder → document. */
async function seedDocumentChain(): Promise<void> {
  const libraryId = uuidv7();
  const folderId = uuidv7();
  const numberingRuleId = uuidv7();
  const confidentialityId = uuidv7();
  const documentTypeId = uuidv7();

  await owner.library.create({
    data: {
      id: libraryId,
      tenantId: TENANT,
      code: 'LIB',
      name: 'Quality',
      ownerScopeType: 'TENANT',
      rootFolderId: null,
      updatedAt: clock.now(),
    },
  });
  await owner.folder.create({
    data: {
      id: folderId,
      tenantId: TENANT,
      libraryId,
      name: 'Root',
      // The folder's own id, because that is what a materialised path is: `pathFor(null, id)`.
      // A label here would make the chain reader look up a folder called "root".
      path: folderId,
      isRoot: true,
      updatedAt: clock.now(),
    },
  });
  await owner.library.update({ where: { id: libraryId }, data: { rootFolderId: folderId } });
  await owner.confidentialityLevel.create({
    data: {
      id: confidentialityId,
      tenantId: TENANT,
      code: 'INTERNAL',
      name: 'Internal',
      rank: 1,
      updatedAt: clock.now(),
    },
  });
  await owner.numberingRule.create({
    data: {
      id: numberingRuleId,
      tenantId: TENANT,
      key: 'default',
      name: 'Default',
      segments: [],
      updatedAt: clock.now(),
    },
  });
  await owner.documentType.create({
    data: {
      id: documentTypeId,
      tenantId: TENANT,
      code: 'PROC',
      name: 'Procedure',
      numberingRuleId,
      defaultConfidentialityId: confidentialityId,
      updatedAt: clock.now(),
    },
  });
  await owner.document.create({
    data: {
      id: DOCUMENT,
      tenantId: TENANT,
      folderId,
      documentTypeId,
      confidentialityId,
      title: 'Supplier Audit Procedure',
      status: 'DRAFT',
      ownerUserId: ADA,
      updatedAt: clock.now(),
    },
  });
}

beforeEach(() => {
  now = new Date('2026-08-05T09:00:00.000Z');
});

describe('an event becomes notifications, once', () => {
  const eventId = uuidv7();

  it('produces one message per recipient and channel', async () => {
    const created = await asSystem(() =>
      stack.events.handle({
        eventId,
        eventType: 'workflow.task-assigned',
        payload: {
          workflowInstanceId: uuidv7(),
          documentId: DOCUMENT,
          stageIndex: 0,
          stageName: 'Review',
          assigneeIds: [ADA, BOB],
          dueAt: '2026-08-12T09:00:00.000Z',
        },
      }),
    );

    // Two recipients × two channels: the type defaults to email and in-app, and both have a
    // template.
    expect(created).toBe(4);
    expect(await messagesFor(ADA, NotificationType.APPROVAL_TASK_ASSIGNED.key)).toHaveLength(2);
  });

  it('produces none when the same event is redelivered', async () => {
    const again = await asSystem(() =>
      stack.events.handle({
        eventId,
        eventType: 'workflow.task-assigned',
        payload: {
          workflowInstanceId: uuidv7(),
          documentId: DOCUMENT,
          stageIndex: 0,
          stageName: 'Review',
          assigneeIds: [ADA, BOB],
          dueAt: '2026-08-12T09:00:00.000Z',
        },
      }),
    );

    expect(again).toBe(0);
    expect(await messagesFor(ADA, NotificationType.APPROVAL_TASK_ASSIGNED.key)).toHaveLength(2);
  });

  it('tells nobody about an event whose type this phase does not translate', async () => {
    const created = await asSystem(() =>
      stack.events.handle({
        eventId: uuidv7(),
        eventType: 'audit.chain-verified',
        payload: {},
      }),
    );
    expect(created).toBe(0);
  });
});

describe('the ACL decides who is told a document exists', () => {
  it('does not tell a recipient who may not see the document', async () => {
    const created = await asSystem(() =>
      stack.events.handle({
        eventId: uuidv7(),
        eventType: 'workflow.task-assigned',
        payload: {
          workflowInstanceId: uuidv7(),
          documentId: DOCUMENT,
          stageIndex: 0,
          stageName: 'Review',
          // Mallory holds an approval task and no role. A notification naming the document's
          // number and title would be a disclosure even though the link then refuses her.
          assigneeIds: [BOB, MALLORY],
          dueAt: null,
        },
      }),
    );

    // Bob's two channels, and nothing at all for Mallory.
    expect(created).toBe(2);
    expect(await messagesFor(MALLORY)).toEqual([]);
  });
});

describe('preferences decide the channel', () => {
  it('silences a type the user turned off', async () => {
    await inTransaction(
      () =>
        stack.admin.savePreference(BOB, NotificationType.DOCUMENT_PUBLISHED.key, {
          channels: [],
          digest: DigestFrequency.IMMEDIATE,
        }),
      BOB,
    );

    await asSystem(() =>
      stack.events.handle({
        eventId: uuidv7(),
        eventType: 'document.published',
        payload: { documentId: DOCUMENT },
      }),
    );

    expect(await messagesFor(BOB, NotificationType.DOCUMENT_PUBLISHED.key)).toEqual([]);
    // Ada, who expressed no opinion, still hears about it on both channels.
    expect(await messagesFor(ADA, NotificationType.DOCUMENT_PUBLISHED.key)).toHaveLength(2);
  });

  it('cannot silence a mandatory type', async () => {
    await inTransaction(
      () =>
        stack.admin.savePreference(ADMIN, NotificationType.AUDIT_CHAIN_BROKEN.key, {
          channels: [],
          digest: DigestFrequency.IMMEDIATE,
        }),
      ADMIN,
    );

    await asSystem(() =>
      stack.events.handle({
        eventId: uuidv7(),
        eventType: 'audit.chain-broken',
        payload: { reason: 'DIGEST_MISMATCH' },
      }),
    );

    // A person must be told their trail was tampered with, and an attacker who can suppress the
    // warning has already won.
    const alerts = await messagesFor(ADMIN, NotificationType.AUDIT_CHAIN_BROKEN.key);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.channel).toBe(NotificationChannel.EMAIL);
  });
});

describe('quiet hours hold a non-urgent message and release it afterwards', () => {
  it('holds the non-urgent one and lets the urgent one through', async () => {
    // 22:00–07:00 UTC. The clock reads 23:00, which is inside it.
    await inTransaction(
      () =>
        stack.admin.saveQuietHours(ADA, {
          startMinute: 22 * 60,
          endMinute: 7 * 60,
          timezone: 'UTC',
        }),
      ADA,
    );
    now = new Date('2026-08-05T23:00:00.000Z');

    await asSystem(() =>
      stack.events.handle({
        eventId: uuidv7(),
        eventType: 'document.approved',
        payload: { documentId: DOCUMENT },
      }),
    );
    await asSystem(() =>
      stack.events.handle({
        eventId: uuidv7(),
        eventType: 'audit.chain-broken',
        payload: { reason: 'LINK_MISMATCH' },
      }),
    );

    const approved = await messagesFor(ADA, NotificationType.DOCUMENT_APPROVED.key);
    const email = approved.find((row) => row.channel === NotificationChannel.EMAIL);
    expect(email?.state).toBe(DeliveryState.HELD);
    // Released at 07:00 the next morning — eight hours after the clock reads 23:00.
    expect(email?.releaseAt?.toISOString()).toBe('2026-08-06T07:00:00.000Z');

    // In-app is never held: §3 calls it the authoritative inbox, and a row in an inbox nobody is
    // looking at interrupts nobody.
    const inApp = approved.find((row) => row.channel === NotificationChannel.IN_APP);
    expect(inApp?.state).toBe(DeliveryState.DELIVERED);
    expect(inApp?.releaseAt).toBeNull();
  });

  it('does not send a held message, and sends it once the window closes', async () => {
    const before = await runWithContext(contextFor(null), () =>
      stack.delivery.deliverBatch(NotificationChannel.EMAIL, 50),
    );
    const heldNow = await owner.notificationMessage.count({
      where: { tenantId: TENANT, recipientId: ADA, state: DeliveryState.HELD },
    });
    expect(heldNow).toBe(1);

    now = new Date('2026-08-06T07:30:00.000Z');
    const released = await runWithContext(contextFor(null), () => stack.delivery.releaseHeld());
    expect(released).toBe(1);

    const after = await runWithContext(contextFor(null), () =>
      stack.delivery.deliverBatch(NotificationChannel.EMAIL, 50),
    );
    expect(after.sent).toBeGreaterThan(before.sent - before.sent);
    expect(
      await owner.notificationMessage.count({
        where: { tenantId: TENANT, recipientId: ADA, state: DeliveryState.HELD },
      }),
    ).toBe(0);

    await inTransaction(() => stack.admin.saveQuietHours(ADA, null), ADA);
  });
});

describe('a digest collects a window and releases it as one message', () => {
  it('holds each member and produces one summary that names them all', async () => {
    now = new Date('2026-08-07T09:00:00.000Z');
    await inTransaction(
      () =>
        stack.admin.savePreference(BOB, NotificationType.DOCUMENT_APPROVED.key, {
          channels: [NotificationChannel.EMAIL],
          digest: DigestFrequency.HOURLY,
        }),
      BOB,
    );

    for (let index = 0; index < 3; index += 1) {
      await asSystem(() =>
        stack.events.handle({
          eventId: uuidv7(),
          eventType: 'document.approved',
          payload: { documentId: DOCUMENT },
        }),
      );
    }

    const held = await owner.notificationMessage.findMany({
      where: {
        tenantId: TENANT,
        recipientId: BOB,
        typeKey: NotificationType.DOCUMENT_APPROVED.key,
        state: DeliveryState.HELD,
      },
    });
    expect(held).toHaveLength(3);
    expect(held.every((row) => row.digestWindow === DigestFrequency.HOURLY)).toBe(true);

    // The window closes at the top of the hour.
    now = new Date('2026-08-07T10:01:00.000Z');
    const produced = await asSystem(() => stack.digests.collect(DigestFrequency.HOURLY));
    expect(produced).toBe(1);

    const summary = await owner.notificationMessage.findFirstOrThrow({
      where: { tenantId: TENANT, recipientId: BOB, typeKey: NotificationType.DIGEST_SUMMARY.key },
    });
    expect(summary.state).toBe(DeliveryState.QUEUED);
    expect(summary.bodyText).toContain('3');

    // Every member points at the summary that carried it, and none is still waiting to go out on
    // its own — which is what "replacing individual sends" means.
    const members = await owner.notificationMessage.findMany({
      where: { tenantId: TENANT, digestMessageId: summary.id },
    });
    expect(members).toHaveLength(3);
    expect(members.every((row) => row.state === DeliveryState.DIGESTED)).toBe(true);

    await inTransaction(
      () => stack.admin.clearPreference(BOB, NotificationType.DOCUMENT_APPROVED.key),
      BOB,
    );
  });
});

describe('a hard bounce suppresses the address', () => {
  it('records the suppression, tells an administrator, and writes it to the trail', async () => {
    now = new Date('2026-08-08T09:00:00.000Z');
    await asSystem(() =>
      strict.events.handle({
        eventId: uuidv7(),
        eventType: 'document.rejected',
        payload: { documentId: DOCUMENT, comment: 'Section 4 is wrong.' },
      }),
    );

    strict.transport.receipt = {
      accepted: false,
      providerMessageId: null,
      failureReason: 'mailbox does not exist',
      permanentFailure: true,
    };
    await runWithContext(contextFor(null), () =>
      strict.delivery.deliverBatch(NotificationChannel.EMAIL, 50),
    );

    const suppression = await owner.notificationSuppression.findFirstOrThrow({
      where: { tenantId: TENANT, address: addressOf('ada') },
    });
    expect(suppression.suppressedAt).not.toBeNull();

    // Suppressing an address stops a person being told things, which is why it is the one
    // notification act this phase put in the trail (13 §2).
    const audited = await owner.auditEvent.findFirst({
      where: { tenantId: TENANT, action: NotificationAudit.SUPPRESSED },
    });
    expect(audited).not.toBeNull();
    // Masked, per 13 §3: an administrator recognises the mailbox without the trail becoming a
    // copy of the directory.
    expect(audited?.reason).toBe('mailbox does not exist');

    const alerts = await messagesFor(ADMIN, NotificationType.SECURITY_ADDRESS_SUPPRESSED.key);
    expect(alerts.length).toBeGreaterThan(0);

    strict.transport.receipt = {
      accepted: true,
      providerMessageId: 'provider-1',
      failureReason: null,
      permanentFailure: false,
    };
  });

  it('does not attempt the next send to that address', async () => {
    const attemptsBefore = strict.transport.sent.filter(
      (message) => message.address === addressOf('ada'),
    ).length;
    await asSystem(() =>
      strict.events.handle({
        eventId: uuidv7(),
        eventType: 'document.published',
        payload: { documentId: DOCUMENT },
      }),
    );

    const message = await owner.notificationMessage.findFirstOrThrow({
      where: {
        tenantId: TENANT,
        recipientId: ADA,
        typeKey: NotificationType.DOCUMENT_PUBLISHED.key,
        channel: NotificationChannel.EMAIL,
      },
      orderBy: { createdAt: 'desc' },
    });
    // A record, not a silence: §8 forbids a notification being silently dropped, and "we did not
    // try, because this address is dead" is what somebody investigating needs to read.
    expect(message.state).toBe(DeliveryState.SUPPRESSED);
    expect(message.failureReason).toContain('suppressed');

    await runWithContext(contextFor(null), () =>
      strict.delivery.deliverBatch(NotificationChannel.EMAIL, 50),
    );
    // Other people's mail still goes out — a suppression is about one mailbox, not about the
    // tenant — but nothing further is written to this one.
    expect(
      strict.transport.sent.filter((message) => message.address === addressOf('ada')).length,
    ).toBe(attemptsBefore);

    await inTransaction(() => strict.admin.releaseSuppression(addressOf('ada')));
  });
});

describe('a bulk sweep produces one summary rather than one message per object', () => {
  it('coalesces five hundred due schedules into a single notification', async () => {
    now = new Date('2026-08-09T02:00:00.000Z');

    for (let index = 0; index < 500; index += 1) {
      await asSystem(() =>
        stack.events.handle({
          eventId: uuidv7(),
          eventType: 'retention.due',
          payload: { documentId: DOCUMENT, dueAt: now.toISOString(), reviewRequired: true },
        }),
      );
    }

    // Nothing has been sent yet, and that is the answer rather than a shortfall.
    expect(await messagesFor(ADMIN, NotificationType.RETENTION_REVIEW_DUE.key)).toEqual([]);
    const window = await owner.notificationBatch.findFirstOrThrow({
      where: { tenantId: TENANT },
    });
    expect(window.itemCount).toBe(500);

    now = new Date('2026-08-09T02:30:00.000Z');
    await asSystem(() => stack.events.releaseBatches(50));

    // One summary per channel for the one controller — not five hundred.
    const summaries = await messagesFor(ADMIN, NotificationType.RETENTION_REVIEW_DUE.key);
    expect(summaries).toHaveLength(2);
    const email = await owner.notificationMessage.findFirstOrThrow({
      where: {
        tenantId: TENANT,
        recipientId: ADMIN,
        typeKey: NotificationType.RETENTION_REVIEW_DUE.key,
        channel: NotificationChannel.EMAIL,
      },
    });
    expect(email.subject).toContain('500');

    // The window is deleted as it is claimed, so a redelivered release finds nothing.
    await asSystem(() => stack.events.releaseBatches(50));
    expect(await messagesFor(ADMIN, NotificationType.RETENTION_REVIEW_DUE.key)).toHaveLength(2);
  }, 120_000);
});

describe('the inbox', () => {
  it('lists in-app notifications only, newest first, and counts the unread', async () => {
    const inbox = await inTransaction(
      () => stack.notifications.inbox(ADA, { ...normalizePageRequest({}), unreadOnly: false }),
      ADA,
    );
    expect(inbox.data.length).toBeGreaterThan(0);
    expect(inbox.data.every((row) => row.channel === NotificationChannel.IN_APP)).toBe(true);

    const unread = await inTransaction(() => stack.notifications.unreadCount(ADA), ADA);
    expect(unread).toBe(inbox.meta.total);

    const first = inbox.data[0]!.id;
    await inTransaction(() => stack.notifications.markRead(first), ADA);
    const afterOne = await inTransaction(() => stack.notifications.unreadCount(ADA), ADA);
    expect(afterOne).toBe(unread - 1);

    const marked = await inTransaction(() => stack.notifications.markAllRead(ADA), ADA);
    expect(marked).toBe(afterOne);
    expect(await inTransaction(() => stack.notifications.unreadCount(ADA), ADA)).toBe(0);
  });

  it('keeps the first read timestamp when something is read twice', async () => {
    const created = await asSystem(() =>
      stack.events.handle({
        eventId: uuidv7(),
        eventType: 'document.checked-in',
        payload: { documentId: DOCUMENT, newRevisionId: uuidv7(), ordinal: 2 },
      }),
    );
    expect(created).toBeGreaterThan(0);

    const unreadPage = await inTransaction(
      () => stack.notifications.inbox(ADA, { ...normalizePageRequest({}), unreadOnly: true }),
      ADA,
    );
    const id = unreadPage.data[0]!.id;

    await inTransaction(() => stack.notifications.markRead(id), ADA);
    const firstReadAt = (await owner.notificationMessage.findUniqueOrThrow({ where: { id } }))
      .readAt;

    now = new Date(now.getTime() + 60_000);
    await inTransaction(() => stack.notifications.markRead(id), ADA);
    const secondReadAt = (await owner.notificationMessage.findUniqueOrThrow({ where: { id } }))
      .readAt;

    // When somebody saw it is a fact; re-reading does not change it.
    expect(secondReadAt?.getTime()).toBe(firstReadAt?.getTime());
  });
});

describe('a tenant template override replaces the shipped one', () => {
  it('renders the override, and reverts when it is removed', async () => {
    await inTransaction(
      () =>
        stack.admin.saveTemplate(
          NotificationType.DOCUMENT_PUBLISHED.key,
          NotificationChannel.IN_APP,
          'en',
          {
            subject: 'Now effective: {{documentNumber}}',
            bodyText: 'Read {{documentTitle}} at {{documentLink}}.',
            bodyHtml: null,
          },
        ),
      ADMIN,
    );

    await asSystem(() =>
      stack.events.handle({
        eventId: uuidv7(),
        eventType: 'document.published',
        payload: { documentId: DOCUMENT },
      }),
    );
    const overridden = await owner.notificationMessage.findFirstOrThrow({
      where: {
        tenantId: TENANT,
        recipientId: ADA,
        typeKey: NotificationType.DOCUMENT_PUBLISHED.key,
        channel: NotificationChannel.IN_APP,
      },
      orderBy: { createdAt: 'desc' },
    });
    expect(overridden.subject).toBe('Now effective: QA-001');

    await inTransaction(
      () =>
        stack.admin.deleteTemplate(
          NotificationType.DOCUMENT_PUBLISHED.key,
          NotificationChannel.IN_APP,
          'en',
        ),
      ADMIN,
    );
    await asSystem(() =>
      stack.events.handle({
        eventId: uuidv7(),
        eventType: 'document.published',
        payload: { documentId: DOCUMENT },
      }),
    );
    const shipped = await owner.notificationMessage.findFirstOrThrow({
      where: {
        tenantId: TENANT,
        recipientId: ADA,
        typeKey: NotificationType.DOCUMENT_PUBLISHED.key,
        channel: NotificationChannel.IN_APP,
      },
      orderBy: { createdAt: 'desc' },
    });
    expect(shipped.subject).toContain('Published');
  });

  it('refuses a template that names a placeholder its type does not provide', async () => {
    await expect(
      inTransaction(
        () =>
          stack.admin.saveTemplate(
            NotificationType.DOCUMENT_PUBLISHED.key,
            NotificationChannel.IN_APP,
            'en',
            { subject: 'Hello {{password}}', bodyText: 'x', bodyHtml: null },
          ),
        ADMIN,
      ),
    ).rejects.toThrowError(/password/);
  });
});

describe('delegation events, delivered at last', () => {
  it('tells both parties about a delegation that came into force', async () => {
    const created = await asSystem(() =>
      stack.events.handle({
        eventId: uuidv7(),
        eventType: 'delegation.approved',
        payload: {
          delegationId: uuidv7(),
          delegatorId: ADA,
          delegateId: BOB,
          startsAt: '2026-08-05T00:00:00.000Z',
          endsAt: '2026-08-19T00:00:00.000Z',
        },
      }),
    );

    // Two people, two channels each. Not ACL-filtered: a delegation names two people and
    // concerns no document, so there is no object to resolve.
    expect(created).toBe(4);
  });
});
