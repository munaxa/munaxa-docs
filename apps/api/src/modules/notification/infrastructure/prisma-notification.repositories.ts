import { Injectable } from '@nestjs/common';

import {
  type DeliveryStateKey,
  type NotificationChannelKey,
  type NotificationMessageId,
  type UserId,
  asId,
} from '@edms/domain';
import { type Page, type PageRequest, skipFor, toPage, uuidv7 } from '@edms/utils';

import { requireTransaction } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';
import type { RecipientPreference } from '../domain/notification-types';
import type { MessageTemplate } from '../domain/template';
import type {
  NewNotificationMessage,
  NotificationMessageRecord,
  NotificationMessageRepository,
  NotificationPreferenceRepository,
  NotificationTemplateRepository,
} from '../application/notification.ports';

/** Tenant overrides of the shipped templates. An empty table is a fully working tenant. */
@Injectable()
export class PrismaNotificationTemplateRepository implements NotificationTemplateRepository {
  async findOverride(
    typeKey: string,
    channel: NotificationChannelKey,
    locale: string,
  ): Promise<MessageTemplate | null> {
    const row = await requireTransaction().notificationTemplate.findFirst({
      where: { tenantId: requireContext().tenantId, typeKey, channel, locale },
      select: { subject: true, bodyText: true, bodyHtml: true },
    });
    return row ?? null;
  }

  async saveOverride(
    typeKey: string,
    channel: NotificationChannelKey,
    locale: string,
    template: MessageTemplate,
  ): Promise<void> {
    const { tenantId } = requireContext();
    await requireTransaction().notificationTemplate.upsert({
      where: { tenantId_typeKey_channel_locale: { tenantId, typeKey, channel, locale } },
      create: { id: uuidv7(), tenantId, typeKey, channel, locale, ...template },
      update: { ...template },
    });
  }
}

@Injectable()
export class PrismaNotificationPreferenceRepository implements NotificationPreferenceRepository {
  async findFor(userId: UserId, typeKey: string): Promise<RecipientPreference | null> {
    const row = await requireTransaction().notificationPreference.findUnique({
      where: { userId_typeKey: { userId, typeKey } },
      select: { channels: true, digest: true },
    });
    return row ? { channels: row.channels, digest: row.digest } : null;
  }

  async save(userId: UserId, typeKey: string, preference: RecipientPreference): Promise<void> {
    const { tenantId } = requireContext();
    await requireTransaction().notificationPreference.upsert({
      where: { userId_typeKey: { userId, typeKey } },
      create: {
        tenantId,
        userId,
        typeKey,
        channels: [...preference.channels],
        digest: preference.digest,
      },
      update: { channels: [...preference.channels], digest: preference.digest },
    });
  }
}

@Injectable()
export class PrismaNotificationMessageRepository implements NotificationMessageRepository {
  async create(message: NewNotificationMessage): Promise<void> {
    await requireTransaction().notificationMessage.create({
      data: {
        id: message.id,
        tenantId: requireContext().tenantId,
        recipientId: message.recipientId,
        typeKey: message.typeKey,
        channel: message.channel,
        locale: message.locale,
        subject: message.subject,
        bodyText: message.bodyText,
        bodyHtml: message.bodyHtml,
        state: message.state,
        idempotencyKey: message.idempotencyKey,
        address: message.address,
      },
    });
  }

  async findByIdempotencyKey(key: string): Promise<NotificationMessageRecord | null> {
    const row = await requireTransaction().notificationMessage.findFirst({
      where: { tenantId: requireContext().tenantId, idempotencyKey: key },
    });
    return row ? toRecord(row) : null;
  }

  async listInbox(
    recipientId: UserId,
    page: PageRequest,
  ): Promise<Page<NotificationMessageRecord>> {
    const tx = requireTransaction();
    // In-app only: an email is not an inbox, and listing one here would show a person a copy of
    // something already in their mail client.
    const where = {
      tenantId: requireContext().tenantId,
      recipientId,
      channel: 'IN_APP' as const,
    };

    const total = await tx.notificationMessage.count({ where });
    if (total === 0) {
      return toPage([], 0, page);
    }
    const rows = await tx.notificationMessage.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: skipFor(page),
      take: page.pageSize,
    });
    return toPage(rows.map(toRecord), total, page);
  }

  async markRead(id: NotificationMessageId, at: Date): Promise<void> {
    // `readAt: null` in the predicate keeps the first read's timestamp: when somebody saw it is
    // a fact, and re-reading does not change it.
    await requireTransaction().notificationMessage.updateMany({
      where: { id, tenantId: requireContext().tenantId, readAt: null },
      data: { readAt: at },
    });
  }

  async claimQueued(
    channel: NotificationChannelKey,
    limit: number,
  ): Promise<readonly NotificationMessageRecord[]> {
    const rows = await requireTransaction().notificationMessage.findMany({
      where: { tenantId: requireContext().tenantId, channel, state: 'QUEUED' },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    return rows.map(toRecord);
  }

  async recordDelivery(
    id: NotificationMessageId,
    outcome: { state: DeliveryStateKey; failureReason: string | null; at: Date },
  ): Promise<void> {
    await requireTransaction().notificationMessage.update({
      where: { id },
      data: {
        state: outcome.state,
        failureReason: outcome.failureReason,
        sentAt: outcome.state === 'SENT' ? outcome.at : null,
        attempts: { increment: 1 },
      },
    });
  }
}

interface MessageRow {
  id: string;
  recipientId: string;
  typeKey: string;
  channel: string;
  locale: string;
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  state: string;
  attempts: number;
  readAt: Date | null;
  address: string;
}

function toRecord(row: MessageRow): NotificationMessageRecord {
  return {
    id: asId<NotificationMessageId>(row.id),
    recipientId: asId<UserId>(row.recipientId),
    typeKey: row.typeKey,
    channel: row.channel as NotificationChannelKey,
    locale: row.locale,
    subject: row.subject,
    bodyText: row.bodyText,
    bodyHtml: row.bodyHtml,
    state: row.state as DeliveryStateKey,
    attempts: row.attempts,
    readAt: row.readAt,
    address: row.address,
  };
}
