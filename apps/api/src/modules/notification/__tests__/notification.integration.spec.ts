import 'reflect-metadata';

import { PrismaClient } from '@prisma/client';
import { beforeAll, describe, expect, it } from 'vitest';

import { type TenantId, type UserId, NotificationChannel, asId } from '@edms/domain';
import { normalizePageRequest, uuidv7 } from '@edms/utils';

import type { AppConfig } from '../../../core/config/configuration';
import type { Logger } from '../../../core/observability/logger';
import { PrismaService } from '../../../core/prisma/prisma.service';
import { PrismaUnitOfWork } from '../../../core/prisma/unit-of-work';
import type { SettingsReader } from '../../../core/settings/settings.port';
import { type RequestContext, runWithContext } from '../../../core/tenancy/tenant-context';
import type { DeliveryReceipt, NotificationPort } from '../../../ports/notification.port';
import type { UserDirectory } from '../../identity/application/ports';
import { FakeClock } from '../../../testing/fake-ports';
import { DeliveryService } from '../application/delivery.service';
import { DefaultNotificationService } from '../application/notification.service';
import { NotificationType } from '../domain/notification-types';
import {
  PrismaNotificationMessageRepository,
  PrismaNotificationPreferenceRepository,
  PrismaNotificationTemplateRepository,
} from '../infrastructure/prisma-notification.repositories';

const OWNER_URL = process.env['DATABASE_MIGRATION_URL'] ?? '';
const APP_URL = process.env['DATABASE_URL'] ?? '';

const tenantId = asId<TenantId>(uuidv7());
const userId = asId<UserId>(uuidv7());
const slug = `notif-${tenantId.replaceAll('-', '').slice(-12)}`;

const config = { env: 'test', database: { url: APP_URL, poolSize: 5 } } as unknown as AppConfig;
const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const clock = new FakeClock(new Date('2026-01-01T12:00:00Z'));
const prisma = new PrismaService(config, logger);
const unitOfWork = new PrismaUnitOfWork(prisma);
const messages = new PrismaNotificationMessageRepository();

/** Settings are their own module's concern; here only the locale matters. */
const settings = {
  get: () => Promise.resolve('en'),
  all: () => Promise.resolve({}),
  invalidate: () => Promise.resolve(),
} as unknown as SettingsReader;

/**
 * Identity's directory, stood in for.
 *
 * The real one belongs to Identity and reaching into it would cross a boundary the architecture
 * forbids — and the lint enforces. Whether it reads the right rows is Identity's suite to prove;
 * this one is about what Notification does with the answer.
 */
const users: UserDirectory = {
  contactFor: () => Promise.resolve(null),
  contactsFor: () =>
    Promise.resolve([{ userId, email: 'ada@notif.test', displayName: 'Ada Lovelace' }]),
};

const service = new DefaultNotificationService(
  messages,
  new PrismaNotificationPreferenceRepository(),
  new PrismaNotificationTemplateRepository(),
  users,
  settings,
  clock,
  logger,
);

/** Records what it was asked to send, and answers however the test needs. */
class RecordingTransport implements NotificationPort {
  readonly channel = NotificationChannel.EMAIL;
  readonly sent: { address: string; subject: string }[] = [];
  receipt: DeliveryReceipt = {
    accepted: true,
    providerMessageId: 'provider-1',
    failureReason: null,
    permanentFailure: false,
  };

  send(message: { recipient: { address: string }; subject: string }): Promise<DeliveryReceipt> {
    this.sent.push({ address: message.recipient.address, subject: message.subject });
    return Promise.resolve(this.receipt);
  }
}

function contextFor(): RequestContext {
  return {
    tenantId,
    userId: null,
    roles: [],
    permissions: [],
    sessionId: null,
    correlationId: 'notification-integration',
    permissionVersion: 0,
    locale: 'en',
  };
}

function inTenant<T>(work: () => Promise<T>): Promise<T> {
  return runWithContext(contextFor(), () => unitOfWork.run(work));
}

beforeAll(async () => {
  if (!OWNER_URL || !APP_URL) {
    throw new Error('DATABASE_URL and DATABASE_MIGRATION_URL must both be set.');
  }
  const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  await owner.tenant.create({ data: { id: tenantId, slug, name: 'Notif Ltd', status: 'ACTIVE' } });
  await owner.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SELECT set_config('app.tenant_id', $1, true)", tenantId);
    await tx.user.create({
      data: {
        id: userId,
        tenantId,
        email: 'ada@notif.test',
        emailNormalized: 'ada@notif.test',
        displayName: 'Ada Lovelace',
        status: 'ACTIVE',
      },
    });
  });
  await owner.$disconnect();
});

describe('the notification framework against PostgreSQL', () => {
  const eventId = uuidv7();

  it('renders one message per resolved channel', async () => {
    const created = await inTenant(() =>
      service.notify({
        eventId,
        typeKey: NotificationType.SECURITY_SESSION_REVOKED.key,
        recipientIds: [userId],
        values: { occurredAt: '1 January 2026, 12:00', reason: 'SIGNED_OUT' },
      }),
    );

    // The type defaults to both channels, and both have a template.
    expect(created).toHaveLength(2);
  });

  it('stores the rendered text, with the recipient’s name substituted', async () => {
    const inbox = await inTenant(() => service.inbox(userId, normalizePageRequest({})));

    expect(inbox.data).toHaveLength(1);
    expect(inbox.data[0]?.channel).toBe('IN_APP');
    expect(inbox.data[0]?.bodyText).toContain('1 January 2026');
    expect(inbox.data[0]?.readAt).toBeNull();
  });

  it('delivers in-app the moment it is written, since the row is the delivery', async () => {
    const inbox = await inTenant(() => service.inbox(userId, normalizePageRequest({})));

    // A mail provider outage never affects this, because no provider is involved.
    expect(inbox.data[0]?.state).toBe('DELIVERED');
  });

  it('is idempotent: the same event cannot notify the same person twice', async () => {
    const again = await inTenant(() =>
      service.notify({
        eventId,
        typeKey: NotificationType.SECURITY_SESSION_REVOKED.key,
        recipientIds: [userId],
        values: { occurredAt: '1 January 2026, 12:00', reason: 'SIGNED_OUT' },
      }),
    );

    expect(again).toEqual([]);
  });

  it('sends the queued email and records the outcome', async () => {
    const transport = new RecordingTransport();
    const delivery = new DeliveryService(messages, transport, clock, unitOfWork, logger);

    const outcome = await runWithContext(contextFor(), () => delivery.deliverBatch('EMAIL', 10));

    expect(outcome).toEqual({ attempted: 1, sent: 1, failed: 0 });
    expect(transport.sent[0]?.address).toBe('ada@notif.test');
    expect(transport.sent[0]?.subject).toContain('session');

    const queued = await inTenant(() => messages.claimQueued('EMAIL', 10));
    expect(queued).toEqual([]);
  });

  it('suppresses rather than retries a permanent failure', async () => {
    const transport = new RecordingTransport();
    transport.receipt = {
      accepted: false,
      providerMessageId: null,
      failureReason: 'mailbox does not exist',
      permanentFailure: true,
    };
    const delivery = new DeliveryService(messages, transport, clock, unitOfWork, logger);

    await inTenant(() =>
      service.notify({
        eventId: uuidv7(),
        typeKey: NotificationType.SECURITY_PASSWORD_CHANGED.key,
        recipientIds: [userId],
        values: { occurredAt: '2 January 2026, 09:00' },
      }),
    );

    const outcome = await runWithContext(contextFor(), () => delivery.deliverBatch('EMAIL', 10));

    expect(outcome).toEqual({ attempted: 1, sent: 0, failed: 1 });
    // Repeating a hard bounce only damages the sending domain's reputation.
    const still = await inTenant(() => messages.claimQueued('EMAIL', 10));
    expect(still).toEqual([]);
  });

  it('refuses to "deliver" in-app, which would report success for doing nothing', async () => {
    const delivery = new DeliveryService(
      messages,
      new RecordingTransport(),
      clock,
      unitOfWork,
      logger,
    );

    await expect(
      runWithContext(contextFor(), () => delivery.deliverBatch('IN_APP', 10)),
    ).rejects.toThrowError(/delivered when they are written/);
  });

  it('marks an inbox entry read once, keeping the first timestamp', async () => {
    const inbox = await inTenant(() => service.inbox(userId, normalizePageRequest({})));
    const id = inbox.data[0]!.id;

    await inTenant(() => service.markRead(id));
    const first = await inTenant(() => service.inbox(userId, normalizePageRequest({})));
    const firstReadAt = first.data[0]?.readAt;

    clock.advanceBy(60_000);
    await inTenant(() => service.markRead(id));
    const second = await inTenant(() => service.inbox(userId, normalizePageRequest({})));

    expect(firstReadAt).not.toBeNull();
    // When somebody saw it is a fact; re-reading does not change it.
    expect(second.data[0]?.readAt?.getTime()).toBe(firstReadAt?.getTime());
  });
});
