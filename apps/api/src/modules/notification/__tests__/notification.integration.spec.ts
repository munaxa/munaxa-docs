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
import {
  type DueForDelivery,
  PrismaNotificationMessageRepository,
} from '../infrastructure/prisma-notification.repositories';
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

  /**
   * Slice 84 — a released address that goes bad again is a second suppression, and says so.
   *
   * `releaseSuppression` states the contract this asserts: "lifting one restores the ordinary
   * state, and the next bounce writes the next suppression **with its own count**". The count
   * restarts at zero, so the next episode crosses the threshold at the same number the first one
   * did — and the alert's `eventId` is `suppression:{masked}:{bounceCount}`, which is therefore
   * the *same key* as the previous episode's. `notify` finds that message and returns null, so
   * the second suppression is written to the trail and told to nobody.
   *
   * 18 §7 is "repeated hard bounces suppress the address **and alert an administrator**", and the
   * trail disagreeing with the inbox is the shape of the defect: the audit row says an address was
   * suppressed, and no administrator was told.
   */
  it('tells an administrator again when a released address is suppressed a second time', async () => {
    const address = addressOf('ada');
    // Self-contained: whatever the suite has already done to this address, start from released.
    await asSystem(() => strict.admin.releaseSuppression(address));

    const bounceOnce = async (): Promise<void> => {
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
    };

    // The first episode: suppressed, and the administrator is told.
    await bounceOnce();
    const firstAlerts = (await messagesFor(ADMIN, NotificationType.SECURITY_ADDRESS_SUPPRESSED.key))
      .length;
    const firstAudits = await owner.auditEvent.count({
      where: { tenantId: TENANT, action: NotificationAudit.SUPPRESSED },
    });
    expect(firstAlerts).toBeGreaterThan(0);

    // The mailbox is fixed, and an administrator lifts the suppression. The count restarts.
    expect(await asSystem(() => strict.admin.releaseSuppression(address))).toBe(true);
    const released = await owner.notificationSuppression.findFirstOrThrow({
      where: { tenantId: TENANT, address },
    });
    expect(released.suppressedAt).toBeNull();
    expect(released.bounceCount).toBe(0);

    // Time passes, as it must: a mailbox is corrected, released, and goes bad again. The suite's
    // clock is frozen between scenarios, so it is advanced here the way the rest of the file does
    // — no production sequence suppresses one address twice inside the same instant.
    now = new Date(now.getTime() + 3_600_000);

    // It goes bad again. This is a second suppression, not a repeat of the first.
    await bounceOnce();

    const resuppressed = await owner.notificationSuppression.findFirstOrThrow({
      where: { tenantId: TENANT, address },
    });
    expect(resuppressed.suppressedAt).not.toBeNull();
    // The trail records the second suppression …
    expect(
      await owner.auditEvent.count({
        where: { tenantId: TENANT, action: NotificationAudit.SUPPRESSED },
      }),
    ).toBeGreaterThan(firstAudits);
    // … so somebody has to have been told about it.
    expect(
      (await messagesFor(ADMIN, NotificationType.SECURITY_ADDRESS_SUPPRESSED.key)).length,
    ).toBeGreaterThan(firstAlerts);

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
    await inTransaction(() => stack.notifications.markRead(first, ADA), ADA);
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

    await inTransaction(() => stack.notifications.markRead(id, ADA), ADA);
    const firstReadAt = (await owner.notificationMessage.findUniqueOrThrow({ where: { id } }))
      .readAt;

    now = new Date(now.getTime() + 60_000);
    await inTransaction(() => stack.notifications.markRead(id, ADA), ADA);
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

/**
 * 18 §7's provider-outage row, which was the one row in that table nothing had built — Phase 6.4.
 *
 * The gap was not subtle once looked at, only invisible: a transient failure wrote `FAILED`,
 * `claimQueued` selects `QUEUED`, and `DeliveryState.FAILED` appeared in exactly one place in the
 * product — the assignment that produced it. Nothing read it, nothing re-queued it, and the
 * `attempts` column had been incremented since Phase 12 and consulted by nobody. A mail provider
 * unreachable for sixty seconds therefore lost every email queued in that minute, permanently.
 *
 * It is asserted here rather than in a unit test because the whole mechanism is a column and a
 * predicate: `release_at` in the future, `claimQueued` refusing to claim it, and the same pass a
 * few minutes later finding it due. A repository double would answer from the same belief as the
 * code under test.
 */

/**
 * 18 §7's provider-outage row, which was the one row in that table nothing had built — Phase 6.4.
 *
 * The gap was not subtle once looked at, only invisible: a transient failure wrote `FAILED`,
 * `claimQueued` selects `QUEUED`, and `DeliveryState.FAILED` appeared in exactly one place in the
 * product — the assignment that produced it. Nothing read it, nothing re-queued it, and the
 * `attempts` column had been incremented since Phase 12 and consulted by nobody. A mail provider
 * unreachable for sixty seconds therefore lost every email queued in that minute, permanently. The
 * in-app copy survived, because that row *is* its delivery, which is why the loss was invisible
 * from a screen.
 *
 * Asserted against a real database rather than a double, because the whole mechanism is a column
 * and a predicate: `release_at` in the future, `claimQueued` declining to claim it, and a pass a
 * few minutes later finding it due.
 *
 * Ada rather than Bob throughout: Bob turned `document.published` off in the preferences describe
 * above and never turned it back on, which is a good assertion there and would silently mean "no
 * row to retry" here.
 */
describe('a provider outage delays a message rather than losing it', () => {
  const transient = {
    accepted: false,
    providerMessageId: null,
    failureReason: 'connection refused',
    permanentFailure: false,
  };
  const accepted = {
    accepted: true,
    providerMessageId: 'provider-ok',
    failureReason: null,
    permanentFailure: false,
  };

  /** Queues one email for Ada and returns its row id. */
  async function queueOne(): Promise<string> {
    const eventId = uuidv7();
    await asSystem(() =>
      stack.events.handle({
        eventId,
        eventType: 'document.published',
        payload: { documentId: DOCUMENT },
      }),
    );
    // By the idempotency key rather than by recency: `created_at` is the database's clock while
    // everything else here runs on the movable one, so "the newest row" is not a question this
    // suite can ask honestly.
    const row = await owner.notificationMessage.findFirstOrThrow({
      where: {
        tenantId: TENANT,
        idempotencyKey: `${eventId}:${ADA}:${NotificationChannel.EMAIL}`,
      },
    });
    return row.id;
  }

  function failuresSince(index: number, outcome: string): number {
    return stack.metrics.recorded
      .slice(index)
      .filter(
        (entry) =>
          entry.name === 'notification.delivery.failures' && entry.labels['outcome'] === outcome,
      ).length;
  }

  it('re-queues a transient failure behind a backoff instead of marking it failed', async () => {
    now = new Date('2026-08-20T09:00:00.000Z');
    const id = await queueOne();

    stack.transport.receipt = transient;
    await runWithContext(contextFor(null), () =>
      stack.delivery.deliverBatch(NotificationChannel.EMAIL, 50),
    );

    const afterFirst = await owner.notificationMessage.findUniqueOrThrow({ where: { id } });
    // Queued again, not failed — and held behind an instant, which is the whole mechanism.
    expect(afterFirst.state).toBe(DeliveryState.QUEUED);
    expect(afterFirst.attempts).toBe(1);
    expect(afterFirst.releaseAt).not.toBeNull();
    expect(afterFirst.releaseAt?.getTime()).toBeGreaterThan(now.getTime());

    // And it is genuinely withheld: a pass a second later must not pick it up, or the backoff is
    // a number in a column rather than a delay.
    const sentBefore = stack.transport.sent.length;
    now = new Date('2026-08-20T09:00:01.000Z');
    await runWithContext(contextFor(null), () =>
      stack.delivery.deliverBatch(NotificationChannel.EMAIL, 50),
    );
    expect(stack.transport.sent.length).toBe(sentBefore);

    // Once the backoff has elapsed and the provider is back, it goes out — and the retry instant
    // is cleared, so a message that was retried and then sent keeps no stale one.
    now = new Date('2026-08-20T09:10:00.000Z');
    stack.transport.receipt = accepted;
    await runWithContext(contextFor(null), () =>
      stack.delivery.deliverBatch(NotificationChannel.EMAIL, 50),
    );

    const settled = await owner.notificationMessage.findUniqueOrThrow({ where: { id } });
    expect(settled.state).toBe(DeliveryState.SENT);
    expect(settled.attempts).toBe(2);
    expect(settled.releaseAt).toBeNull();
    expect(settled.sentAt).not.toBeNull();
  });

  it('gives up after the capped attempts and leaves the message dead, visibly', async () => {
    now = new Date('2026-08-21T09:00:00.000Z');
    const id = await queueOne();
    const before = stack.metrics.recorded.length;

    stack.transport.receipt = transient;
    // Five attempts is the cap. Each pass moves the clock past the previous backoff, which is the
    // only reason a later pass claims the row at all.
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      now = new Date(now.getTime() + 600_000);
      await runWithContext(contextFor(null), () =>
        stack.delivery.deliverBatch(NotificationChannel.EMAIL, 50),
      );
    }

    const dead = await owner.notificationMessage.findUniqueOrThrow({ where: { id } });
    expect(dead.state).toBe(DeliveryState.FAILED);
    expect(dead.attempts).toBe(5);
    // No further instant: a dead letter is not a message waiting, and tomorrow's pass must not
    // resurrect it. §8's "never silently dropped" is honoured by the row, which still says why.
    expect(dead.releaseAt).toBeNull();
    expect(dead.failureReason).toContain('connection refused');

    // What an operator sees. Counted loosely on purpose: a delivery pass claims every due message
    // in the tenant, so the batch legitimately contains other rows left over from the describes
    // above. What matters is that both labels are produced, because alerting belongs on `terminal`
    // — `retrying` is what an ordinary provider blip looks like and must not page anybody.
    expect(failuresSince(before, 'retrying')).toBeGreaterThanOrEqual(4);
    expect(failuresSince(before, 'terminal')).toBeGreaterThanOrEqual(1);

    // And it stays dead.
    now = new Date('2026-08-22T09:00:00.000Z');
    const sentBefore = stack.transport.sent.length;
    await runWithContext(contextFor(null), () =>
      stack.delivery.deliverBatch(NotificationChannel.EMAIL, 50),
    );
    expect(stack.transport.sent.length).toBe(sentBefore);

    stack.transport.receipt = accepted;
  });

  it('still refuses to retry a hard bounce, which is about the address rather than the provider', async () => {
    now = new Date('2026-08-23T09:00:00.000Z');
    const id = await queueOne();

    stack.transport.receipt = {
      accepted: false,
      providerMessageId: null,
      failureReason: 'mailbox does not exist',
      permanentFailure: true,
    };
    await runWithContext(contextFor(null), () =>
      stack.delivery.deliverBatch(NotificationChannel.EMAIL, 50),
    );

    const bounced = await owner.notificationMessage.findUniqueOrThrow({ where: { id } });
    // Suppressed on the first attempt, with no backoff: repeating a send to a mailbox that does
    // not exist only damages the sending domain's reputation. This is the case the retry above
    // must not have swallowed.
    expect(bounced.state).toBe(DeliveryState.SUPPRESSED);
    expect(bounced.releaseAt).toBeNull();

    stack.transport.receipt = accepted;
    await inTransaction(() => stack.admin.releaseSuppression(addressOf('ada')));
  });
});

/**
 * Whose inbox is whose — Phase 6.4's authorisation finding.
 *
 * `NotificationController`'s own comment states the property this describe checks: "every route
 * here is about the caller's own notifications, and none takes a user identifier — that absence is
 * the authorisation". It was true of four routes out of five. `POST /notifications/:id/read` takes
 * an identifier, and the predicate behind it was `(id, tenantId)`, so anybody in the tenant holding
 * `notification:manage` — a permission seeded to *every* role, `GUEST` included — could clear a
 * colleague's unread marker with an id they had seen or guessed. Message ids are UUIDv7, which are
 * time-ordered, so guessing is not the barrier it looks like.
 *
 * Not a disclosure: the route returns `204` whichever way it goes, so it is not even an oracle for
 * whether an id exists. It is an integrity defect, and it made a stated security property false.
 */
describe('a notification belongs to one person', () => {
  async function anUnreadFor(recipientId: UserId): Promise<string> {
    const eventId = uuidv7();
    await asSystem(() =>
      stack.events.handle({
        eventId,
        eventType: 'document.checked-in',
        payload: { documentId: DOCUMENT, newRevisionId: uuidv7(), ordinal: 9 },
      }),
    );
    const row = await owner.notificationMessage.findFirstOrThrow({
      where: {
        tenantId: TENANT,
        idempotencyKey: `${eventId}:${recipientId}:${NotificationChannel.IN_APP}`,
      },
    });
    return row.id;
  }

  it('refuses to let one user mark another user’s notification read', async () => {
    now = new Date('2026-08-24T09:00:00.000Z');
    const adasMessage = await anUnreadFor(ADA);

    // Bob is an ordinary signed-in colleague, holding the same permission the controller requires.
    await inTransaction(() => stack.notifications.markRead(asId(adasMessage), BOB), BOB);

    const untouched = await owner.notificationMessage.findUniqueOrThrow({
      where: { id: adasMessage },
    });
    expect(untouched.readAt).toBeNull();

    // And Ada can still read her own, so the predicate refuses the impostor rather than everybody.
    await inTransaction(() => stack.notifications.markRead(asId(adasMessage), ADA), ADA);
    expect(
      (await owner.notificationMessage.findUniqueOrThrow({ where: { id: adasMessage } })).readAt,
    ).not.toBeNull();
  });

  it('never lets a recipient from another tenant reach a message', async () => {
    now = new Date('2026-08-24T10:00:00.000Z');
    const adasMessage = await anUnreadFor(ADA);

    // A neighbouring tenant's user id, carried in a context that names *this* tenant — the shape a
    // manipulated payload would take, since a real cross-tenant request cannot reach this database
    // at all under ADR-0015. Neither half matches, and the row is untouched.
    const stranger = asId<UserId>(uuidv7());
    await inTransaction(() => stack.notifications.markRead(asId(adasMessage), stranger), stranger);

    expect(
      (await owner.notificationMessage.findUniqueOrThrow({ where: { id: adasMessage } })).readAt,
    ).toBeNull();
  });

  it('shows a person only their own inbox, and counts only their own unread', async () => {
    now = new Date('2026-08-24T11:00:00.000Z');
    const page = await inTransaction(
      () => stack.notifications.inbox(BOB, { ...normalizePageRequest({}), unreadOnly: false }),
      BOB,
    );
    // The list is the assertion: every row is Bob's, so a page cannot carry a neighbour's subject
    // line even when the two were produced by one event.
    const rows = await owner.notificationMessage.findMany({
      where: { tenantId: TENANT, id: { in: page.data.map((entry) => entry.id) } },
      select: { recipientId: true },
    });
    expect(rows.every((row) => row.recipientId === BOB)).toBe(true);
  });

  it('tells nobody about a document they may not see, however the event names them', async () => {
    now = new Date('2026-08-24T12:00:00.000Z');
    const before = (await messagesFor(MALLORY)).length;

    // Mallory holds no role, so the ACL walk refuses her — and the event names her *explicitly* as
    // an assignee, which is the case that matters: a recipient list is derived from an event, and
    // an event is not entitled to decide who may be told a document exists (18 §8).
    await asSystem(() =>
      stack.events.handle({
        eventId: uuidv7(),
        eventType: 'workflow.task-assigned',
        payload: {
          documentId: DOCUMENT,
          assigneeIds: [MALLORY],
          stageName: 'Quality review',
          dueAt: '2026-08-25T09:00:00.000Z',
        },
      }),
    );

    expect((await messagesFor(MALLORY)).length).toBe(before);
  });
});

/**
 * One queued message is sent once, however many delivery passes meet it — Slice 52.
 *
 * `claimQueued` is named for what it is meant to do and does not do it: it is a `findMany` over
 * `state = QUEUED AND (release_at IS NULL OR release_at <= now)`, marking nothing. The lane runs
 * `notifications.deliver` every minute at concurrency eight and retries a failed pass five times,
 * so two passes meeting the same queued row is ordinary — and the transport is somebody's inbox.
 *
 * `release_at` is already the gate: the schema says it "gates the delivery claim as well as
 * explaining the state".
 */
describe('one queued message, one send, however many passes meet it', () => {
  async function queuedFor(recipient: UserId): Promise<number> {
    return owner.notificationMessage.count({
      where: {
        tenantId: TENANT,
        recipientId: recipient,
        channel: NotificationChannel.EMAIL,
        state: DeliveryState.QUEUED,
      },
    });
  }

  function sendsTo(address: string): number {
    return stack.transport.sent.filter((message) => message.address === address).length;
  }

  it('sends a queued message once when one pass runs', async () => {
    const before = sendsTo(addressOf('ada'));
    const queued = await queuedFor(ADA);

    const outcome = await runWithContext(contextFor(null), () =>
      stack.delivery.deliverBatch(NotificationChannel.EMAIL, 50),
    );

    // The control that stops the race assertion below passing because nothing was ever sent.
    expect(outcome.attempted).toBe(queued);
    expect(sendsTo(addressOf('ada')) - before).toBe(queued);
  });

  it('sends a queued message once when a second pass runs while the first is in flight', async () => {
    // A fresh queued message, produced the way the product produces them.
    await asSystem(() =>
      stack.events.handle({
        eventId: uuidv7(),
        eventType: 'workflow.task-assigned',
        payload: {
          workflowInstanceId: uuidv7(),
          documentId: DOCUMENT,
          stageIndex: 0,
          stageName: 'Race',
          assigneeIds: [ADA],
          dueAt: '2026-08-12T09:00:00.000Z',
        },
      }),
    );
    const before = sendsTo(addressOf('ada'));
    const queued = await queuedFor(ADA);
    expect(queued).toBe(1);

    /*
     * The seam: the real transport, held on its first send.
     *
     * The second pass is started only once the first has *arrived* at the transport, rather than
     * both being launched and left to race for the latch. Which of two concurrent passes reaches
     * the transport first is the scheduler's business, and a test that depends on the answer is a
     * test that reports whichever answer it got that run. Waiting for the arrival makes the first
     * pass definitively the one holding the claim, which is the interleaving under examination:
     * a minute's pass still sending when the next minute's pass begins.
     */
    let arrived: () => void = () => undefined;
    const atTransport = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    let admit: () => void = () => undefined;
    const inFlight = new Promise<void>((resolve) => {
      admit = resolve;
    });
    let held = false;
    const realSend = stack.transport.send.bind(stack.transport);
    stack.transport.send = async (message: Parameters<typeof realSend>[0]) => {
      if (!held) {
        held = true;
        arrived();
        await inFlight;
      }
      return realSend(message);
    };

    try {
      const first = runWithContext(contextFor(null), () =>
        stack.delivery.deliverBatch(NotificationChannel.EMAIL, 50),
      );
      await atTransport;
      const second = await runWithContext(contextFor(null), () =>
        stack.delivery.deliverBatch(NotificationChannel.EMAIL, 50),
      );
      admit();
      await first;

      // The second pass must claim nothing: the row is already being sent.
      expect(second.attempted).toBe(0);
    } finally {
      stack.transport.send = realSend;
    }

    // One message, one send. A second is a duplicate in somebody's inbox that no retry policy
    // asked for and no provider will collapse under SMTP.
    expect(sendsTo(addressOf('ada')) - before).toBe(1);
  });

  it('sends nothing more when a second pass runs after the first', async () => {
    const before = sendsTo(addressOf('ada'));

    // The sequential second pass, which is the answer the concurrent one has to match: the rows
    // are no longer QUEUED, so it claims nothing and sends nothing.
    const outcome = await runWithContext(contextFor(null), () =>
      stack.delivery.deliverBatch(NotificationChannel.EMAIL, 50),
    );

    expect(outcome.attempted).toBe(0);
    expect(sendsTo(addressOf('ada')) - before).toBe(0);
  });

  /*
   * Two passes over one batch, neither held — the interleaving the row count exists for.
   *
   * The test above orders the two passes: the first has committed its claim before the second
   * begins, so the second's *candidate select* already excludes the row and the claim's affected
   * row count is never what saved it. That count is for the other order — both passes selecting
   * before either claims, which is what concurrency eight over a batch of fifty produces every
   * time two passes overlap. A batch is what opens that window: the first pass spends one
   * statement per row claiming, and the second pass's select lands inside that loop.
   *
   * Whatever the interleaving, the property is the same one and holds under all of them: a row is
   * sent by the pass whose claim affected it, and one row is affected once.
   */
  it('sends each of a batch once when two passes run at the same time', async () => {
    const BATCH = 20;
    for (let index = 0; index < BATCH; index += 1) {
      await asSystem(() =>
        stack.events.handle({
          eventId: uuidv7(),
          eventType: 'workflow.task-assigned',
          payload: {
            workflowInstanceId: uuidv7(),
            documentId: DOCUMENT,
            stageIndex: 0,
            stageName: `Concurrent ${String(index)}`,
            assigneeIds: [ADA],
            dueAt: '2026-08-12T09:00:00.000Z',
          },
        }),
      );
    }
    const before = sendsTo(addressOf('ada'));
    expect(await queuedFor(ADA)).toBe(BATCH);

    const [first, second] = await Promise.all([
      runWithContext(contextFor(null), () =>
        stack.delivery.deliverBatch(NotificationChannel.EMAIL, 50),
      ),
      runWithContext(contextFor(null), () =>
        stack.delivery.deliverBatch(NotificationChannel.EMAIL, 50),
      ),
    ]);

    // Between them the two passes claimed every row and claimed none of them twice.
    expect(first.attempted + second.attempted).toBe(BATCH);
    expect(sendsTo(addressOf('ada')) - before).toBe(BATCH);
    expect(await queuedFor(ADA)).toBe(0);
  });

  /*
   * Both passes select the row; one claims it; the other is refused *by the count*.
   *
   * The two tests above cannot establish this ordering. Ordering whole claims puts the first
   * pass's commit before the second pass's select, so the second is turned away by its own
   * predicate and the affected-row count is never consulted. The batch test opens the window by
   * making the first pass's claim loop long enough for the second pass's select to land inside
   * it — which works, and works every time it has been run, but it is the scheduler's doing and
   * not the test's. "It failed under the mutation twenty times" is evidence; it is not proof.
   *
   * So both passes are parked *inside* `claimQueued`, between selecting a row and claiming it,
   * and released in a fixed order. Reaching the park is itself the evidence the assertion needs:
   * a pass can only be parked on a row its SELECT returned. That is what separates "B never saw
   * the row" from "B saw it and its UPDATE affected nothing", and only the second is the property
   * under test.
   *
   * Each pass runs its own `deliverBatch` from its own `runWithContext`, so each opens its own
   * transaction. Neither is invoked from inside the other's callback — a nested `run` would join
   * the ambient transaction, and the test would then be one transaction racing itself, which is
   * both deterministic and meaningless.
   */
  it('refuses the second pass at the claim rather than at the select', async () => {
    const parked = new ParkedClaims();
    const seam = realNotifications({
      clock,
      unitOfWork,
      config: appConfig,
      documents,
      messages: parked,
    });

    await asSystem(() =>
      seam.events.handle({
        eventId: uuidv7(),
        eventType: 'workflow.task-assigned',
        payload: {
          workflowInstanceId: uuidv7(),
          documentId: DOCUMENT,
          stageIndex: 0,
          stageName: 'Contended',
          assigneeIds: [ADA],
          dueAt: '2026-08-12T09:00:00.000Z',
        },
      }),
    );
    const queued = await owner.notificationMessage.findMany({
      where: {
        tenantId: TENANT,
        recipientId: ADA,
        channel: NotificationChannel.EMAIL,
        state: DeliveryState.QUEUED,
      },
      select: { id: true },
    });
    expect(queued.length).toBe(1);
    const contended = queued[0]!.id;

    /*
     * The first pass is also held at the transport, and that is not decoration.
     *
     * Releasing the second pass only after the first has *finished* would let the delivery
     * outcome do the refusing: `recordDelivery` moves the row to `SENT`, and a second pass is
     * then turned away by `state = QUEUED` whether or not a lease was ever written. The claim
     * would look load-bearing while the terminal state was doing the work — and an earlier
     * draft of this test passed with the claim degraded to a plain read for exactly that reason.
     *
     * Held at the transport, the first pass has committed its claim and written nothing else.
     * The row the second pass meets is still `QUEUED`, still addressed to the same person, and
     * refused by one thing only: the lease the claim put in `release_at`.
     */
    let admitTransport: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      admitTransport = resolve;
    });
    let sending: () => void = () => undefined;
    const atTransport = new Promise<'sending'>((resolve) => {
      sending = () => {
        resolve('sending');
      };
    });
    let held = false;
    const realSend = seam.transport.send.bind(seam.transport);
    seam.transport.send = async (message: Parameters<typeof realSend>[0]) => {
      if (!held) {
        held = true;
        sending();
        await released;
      }
      return realSend(message);
    };

    const first = runWithContext(contextFor(null), () =>
      seam.delivery.deliverBatch(NotificationChannel.EMAIL, 50),
    );
    expect(await parked.arrivalOf(1, first)).toBe('parked');

    // Started only now, so its select cannot precede the first pass's — and cannot follow the
    // first pass's claim either, because that pass is held before making it.
    const second = runWithContext(contextFor(null), () =>
      seam.delivery.deliverBatch(NotificationChannel.EMAIL, 50),
    );
    expect(await parked.arrivalOf(2, second)).toBe('parked');

    // The assertion the whole test exists for: *both* passes selected the same row. Neither is
    // about to be turned away by a predicate that never returned it.
    expect(parked.claiming).toEqual([contended, contended]);

    // The first pass claims, commits, and stops at the transport.
    parked.admit(1);
    expect(await Promise.race([atTransport, first.then(() => 'finished' as const)])).toBe(
      'sending',
    );
    const midFlight = await owner.notificationMessage.findUnique({
      where: { id: contended },
      select: { state: true, releaseAt: true },
    });
    expect(midFlight?.state).toBe(DeliveryState.QUEUED);
    // Still queued, and held only by the lease the claim wrote. Asserted separately from the
    // instant so that a claim which writes nothing fails here, naming the absent lease, rather
    // than further down on a comparison against `undefined`.
    const lease = midFlight?.releaseAt ?? null;
    expect(lease).not.toBeNull();
    expect(lease!.getTime()).toBeGreaterThan(clock.now().getTime());

    // The second pass now issues the claim it selected a row for, against a row that is still
    // queued and is nevertheless not its to send.
    parked.admit(2);
    const secondOutcome = await second;
    expect(secondOutcome.attempted).toBe(0);
    expect(secondOutcome.sent).toBe(0);

    admitTransport();
    const firstOutcome = await first;
    expect(firstOutcome.attempted).toBe(1);
    expect(firstOutcome.sent).toBe(1);

    // One message, one send, one row in a terminal state.
    expect(
      seam.transport.sent.filter((message) => message.address === addressOf('ada')).length,
    ).toBe(1);
    const after = await owner.notificationMessage.findUnique({
      where: { id: contended },
      select: { state: true },
    });
    expect(after?.state).toBe(DeliveryState.SENT);
  });
});

/**
 * The real message repository, with every pass held between selecting a row and claiming it.
 *
 * A subclass rather than a substitute: `claimDue` records the row, waits to be let go, and then
 * runs the production statement through `super`. Every other method, `claimQueued` included, is
 * the one the product ships — the select, the predicate, the read-back and the transaction are
 * all untouched, and the only thing this class decides is *when* the claim is issued.
 */
class ParkedClaims extends PrismaNotificationMessageRepository {
  /** The rows passes are currently parked on, in arrival order. */
  readonly claiming: string[] = [];
  private readonly gates: (() => void)[] = [];
  private readonly watchers: (() => void)[] = [];

  protected override async claimDue(
    due: DueForDelivery,
    id: string,
    leaseUntil: Date,
  ): Promise<boolean> {
    const admitted = new Promise<void>((resolve) => {
      this.gates.push(resolve);
    });
    this.claiming.push(id);
    this.watchers.splice(0).forEach((notify) => {
      notify();
    });
    await admitted;
    return super.claimDue(due, id, leaseUntil);
  }

  /**
   * Waits for the nth pass to park, or for its `deliverBatch` to finish without parking.
   *
   * Raced against the worker rather than left to wait, so a change that stops issuing the claim
   * at all fails on an assertion that names the problem instead of on a suite timeout.
   */
  async arrivalOf(nth: number, worker: Promise<unknown>): Promise<'parked' | 'finished'> {
    const arrived = new Promise<'parked'>((resolve) => {
      const check = (): void => {
        if (this.claiming.length >= nth) {
          resolve('parked');
        } else {
          this.watchers.push(check);
        }
      };
      check();
    });
    return Promise.race([arrived, worker.then(() => 'finished' as const)]);
  }

  /** Lets the nth parked pass issue its claim. */
  admit(nth: number): void {
    this.gates[nth - 1]?.();
  }
}
