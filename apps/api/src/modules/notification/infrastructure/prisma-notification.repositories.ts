import { Injectable } from '@nestjs/common';

import {
  type DeliveryStateKey,
  type DigestFrequencyKey,
  type NotificationChannelKey,
  type NotificationMessageId,
  type UserId,
  DeliveryState,
  NotificationChannel,
  asId,
} from '@edms/domain';
import { type Page, type PageRequest, skipFor, toPage, uuidv7 } from '@edms/utils';

import { requireTransaction } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';
import type { RecipientPreference } from '../domain/notification-types';
import type { QuietHoursWindow } from '../domain/quiet-hours';
import type { MessageTemplate } from '../domain/template';
import type {
  InboxQuery,
  NewNotificationMessage,
  NotificationBatch,
  NotificationBatchRepository,
  NotificationMessageRecord,
  NotificationMessageRepository,
  NotificationPreferenceRepository,
  NotificationSuppressionRepository,
  NotificationTemplateRepository,
  StoredPreference,
  SuppressionRecord,
  TemplateOverrideRecord,
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

  async listOverrides(): Promise<readonly TemplateOverrideRecord[]> {
    const rows = await requireTransaction().notificationTemplate.findMany({
      where: { tenantId: requireContext().tenantId },
      orderBy: [{ typeKey: 'asc' }, { locale: 'asc' }, { channel: 'asc' }],
    });
    return rows.map((row) => ({
      typeKey: row.typeKey,
      channel: row.channel,
      locale: row.locale,
      subject: row.subject,
      bodyText: row.bodyText,
      bodyHtml: row.bodyHtml,
      updatedAt: row.updatedAt,
    }));
  }

  async deleteOverride(
    typeKey: string,
    channel: NotificationChannelKey,
    locale: string,
  ): Promise<boolean> {
    const { count } = await requireTransaction().notificationTemplate.deleteMany({
      where: { tenantId: requireContext().tenantId, typeKey, channel, locale },
    });
    return count > 0;
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

  async listFor(userId: UserId): Promise<readonly StoredPreference[]> {
    const rows = await requireTransaction().notificationPreference.findMany({
      where: { tenantId: requireContext().tenantId, userId },
      select: { typeKey: true, channels: true, digest: true },
    });
    return rows.map((row) => ({
      typeKey: row.typeKey,
      channels: row.channels,
      digest: row.digest,
    }));
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

  async clear(userId: UserId, typeKey: string): Promise<void> {
    // Removed rather than stored as "the defaults": a row that happens to equal the defaults
    // today would stop equalling them the day the product changes its mind, and the user would
    // silently keep an opinion they never expressed.
    await requireTransaction().notificationPreference.deleteMany({
      where: { tenantId: requireContext().tenantId, userId, typeKey },
    });
  }

  async findQuietHours(userId: UserId): Promise<QuietHoursWindow | null> {
    const row = await requireTransaction().notificationQuietHours.findUnique({
      where: { userId },
      select: { startMinute: true, endMinute: true, timezone: true },
    });
    return row
      ? { startMinute: row.startMinute, endMinute: row.endMinute, timezone: row.timezone }
      : null;
  }

  async saveQuietHours(userId: UserId, window: QuietHoursWindow | null): Promise<void> {
    const tx = requireTransaction();
    const { tenantId } = requireContext();
    if (window === null) {
      await tx.notificationQuietHours.deleteMany({ where: { tenantId, userId } });
      return;
    }
    await tx.notificationQuietHours.upsert({
      where: { userId },
      create: { tenantId, userId, ...window },
      update: { ...window },
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
        releaseAt: message.releaseAt,
        digestWindow: message.digestWindow,
        failureReason: message.failureReason,
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
    query: InboxQuery,
  ): Promise<Page<NotificationMessageRecord>> {
    const tx = requireTransaction();
    // In-app only: an email is not an inbox, and listing one here would show a person a copy of
    // something already in their mail client.
    const where = {
      tenantId: requireContext().tenantId,
      recipientId,
      channel: NotificationChannel.IN_APP,
      ...(query.unreadOnly ? { readAt: null } : {}),
    };

    const total = await tx.notificationMessage.count({ where });
    if (total === 0) {
      return toPage([], 0, query);
    }
    const rows = await tx.notificationMessage.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: skipFor(query),
      take: query.pageSize,
    });
    return toPage(rows.map(toRecord), total, query);
  }

  countUnread(recipientId: UserId): Promise<number> {
    return requireTransaction().notificationMessage.count({
      where: {
        tenantId: requireContext().tenantId,
        recipientId,
        channel: NotificationChannel.IN_APP,
        readAt: null,
      },
    });
  }

  async markRead(id: NotificationMessageId, recipientId: UserId, at: Date): Promise<void> {
    // `readAt: null` in the predicate keeps the first read's timestamp: when somebody saw it is
    // a fact, and re-reading does not change it.
    //
    // `recipientId` is Phase 6.4's addition and is the one that makes this an authorisation
    // rather than a lookup: the tenant clause alone let anybody holding `notification:manage` —
    // which is seeded to every role, `GUEST` included — clear a colleague's unread marker with an
    // id they had guessed or seen. `updateMany` matching nothing is the correct refusal here: the
    // route answers `204` either way, so a wrong id cannot be used to discover a right one.
    await requireTransaction().notificationMessage.updateMany({
      where: { id, tenantId: requireContext().tenantId, recipientId, readAt: null },
      data: { readAt: at },
    });
  }

  async markAllRead(recipientId: UserId, at: Date): Promise<number> {
    const { count } = await requireTransaction().notificationMessage.updateMany({
      where: {
        tenantId: requireContext().tenantId,
        recipientId,
        channel: NotificationChannel.IN_APP,
        readAt: null,
      },
      data: { readAt: at },
    });
    return count;
  }

  async claimQueued(
    channel: NotificationChannelKey,
    limit: number,
    now: Date,
    leaseUntil: Date,
  ): Promise<readonly NotificationMessageRecord[]> {
    const tx = requireTransaction();
    const tenantId = requireContext().tenantId;
    const due = dueForDelivery(tenantId, channel, now);
    const candidates = await tx.notificationMessage.findMany({
      where: due,
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true },
    });

    /*
     * Selected, then *claimed* — Slice 52.
     *
     * The select above is what this method used to be, and a select is not a claim. The lane runs
     * every minute at concurrency eight and retries a failed pass five times, so two passes
     * meeting one queued row is ordinary; both used to read it and both used to send it, and the
     * transport is somebody's inbox. Under SMTP nothing collapses that duplicate — the adapter
     * puts the idempotency key in a `Message-ID` header, which is not an idempotency contract.
     *
     * `release_at` is the lease, because it is already the withholding mechanism: the settle below
     * writes a retry backoff into the same column, and its comment says why — "`claimQueued`
     * withholds a QUEUED row whose `release_at` is in the future". A pass that dies mid-send holds
     * a row no longer than the lane's own job budget, after which it is due again.
     *
     * One statement per row rather than one for the batch, because the affected-row count of a
     * bulk update says how many were claimed and not which — and which is what the caller sends.
     */
    const claimed: string[] = [];
    for (const candidate of candidates) {
      if (await this.claimDue(due, candidate.id, leaseUntil)) {
        claimed.push(candidate.id);
      }
    }
    if (claimed.length === 0) {
      return [];
    }

    const rows = await tx.notificationMessage.findMany({
      where: { tenantId, id: { in: claimed } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toRecord);
  }

  /**
   * One row, claimed or not claimed — the statement the affected-row count is read from.
   *
   * Its own method because the interesting instant of a delivery pass is between selecting a row
   * and claiming it, and that instant is not otherwise reachable: `claimQueued` is atomic from
   * outside, so a suite can order two whole claims but cannot make two passes select the same row
   * before either claims it. That second ordering is the one this count exists for, and the
   * ordinary one — the lane's concurrency is eight and a pass spends one of these per row, so a
   * second pass's select lands inside the first pass's loop routinely.
   *
   * `protected` rather than public: the seam is for a subclass in this module's own suite to park
   * a worker on, and the port stays four methods wide.
   */
  protected async claimDue(due: DueForDelivery, id: string, leaseUntil: Date): Promise<boolean> {
    const { count } = await requireTransaction().notificationMessage.updateMany({
      where: { ...due, id },
      data: { releaseAt: leaseUntil },
    });
    // Zero means somebody else claimed it between this pass's select and this statement. The row
    // is theirs to send, and saying so is the whole of the difference between a claim and a read.
    return count === 1;
  }

  async releaseHeld(now: Date, limit: number): Promise<number> {
    const tx = requireTransaction();
    const tenantId = requireContext().tenantId;
    // Quiet-hours holds only — `digest_window` null. A digest's members are collected by
    // `claimForDigest`; releasing them here would send both the member and the summary that
    // names it.
    const due = await tx.notificationMessage.findMany({
      where: {
        tenantId,
        state: DeliveryState.HELD,
        digestWindow: null,
        digestMessageId: null,
        releaseAt: { lte: now },
      },
      select: { id: true },
      take: limit,
    });
    if (due.length === 0) {
      return 0;
    }
    const { count } = await tx.notificationMessage.updateMany({
      where: { id: { in: due.map((row) => row.id) }, tenantId, state: DeliveryState.HELD },
      data: { state: DeliveryState.QUEUED },
    });
    return count;
  }

  async claimForDigest(
    frequency: DigestFrequencyKey,
    now: Date,
    limit: number,
  ): Promise<readonly NotificationMessageRecord[]> {
    const rows = await requireTransaction().notificationMessage.findMany({
      where: {
        tenantId: requireContext().tenantId,
        state: DeliveryState.HELD,
        digestWindow: frequency,
        digestMessageId: null,
        releaseAt: { lte: now },
      },
      orderBy: [{ recipientId: 'asc' }, { createdAt: 'asc' }],
      take: limit,
    });
    return rows.map(toRecord);
  }

  async markDigested(
    ids: readonly NotificationMessageId[],
    digestMessageId: NotificationMessageId,
  ): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await requireTransaction().notificationMessage.updateMany({
      where: {
        id: { in: [...ids] },
        tenantId: requireContext().tenantId,
        state: DeliveryState.HELD,
      },
      data: { state: DeliveryState.DIGESTED, digestMessageId },
    });
  }

  async recordDelivery(
    id: NotificationMessageId,
    outcome: {
      state: DeliveryStateKey;
      failureReason: string | null;
      at: Date;
      retryAt?: Date | null;
    },
  ): Promise<void> {
    await requireTransaction().notificationMessage.update({
      where: { id },
      data: {
        state: outcome.state,
        failureReason: outcome.failureReason,
        sentAt: outcome.state === DeliveryState.SENT ? outcome.at : null,
        attempts: { increment: 1 },
        // Phase 6.4. The one column a retry needs, and it already existed: `claimQueued` withholds
        // a QUEUED row whose `release_at` is in the future, which is how quiet hours and digests
        // have always worked. Writing a backoff instant into it makes a failed send wait rather
        // than be picked up by the pass a minute later. Cleared on every other outcome so a row
        // that was retried and then sent does not keep a stale instant.
        releaseAt: outcome.retryAt ?? null,
      },
    });
  }
}

/** 18 §7's bounce row: addresses this tenant has stopped writing to. */
@Injectable()
export class PrismaNotificationSuppressionRepository implements NotificationSuppressionRepository {
  async isSuppressed(address: string): Promise<boolean> {
    const row = await requireTransaction().notificationSuppression.findFirst({
      where: {
        tenantId: requireContext().tenantId,
        address: normalizeAddress(address),
        suppressedAt: { not: null },
      },
      select: { address: true },
    });
    return row !== null;
  }

  async find(address: string): Promise<SuppressionRecord | null> {
    const row = await requireTransaction().notificationSuppression.findFirst({
      where: { tenantId: requireContext().tenantId, address: normalizeAddress(address) },
    });
    return row
      ? {
          address: row.address,
          bounceCount: row.bounceCount,
          suppressedAt: row.suppressedAt,
          lastReason: row.lastReason,
        }
      : null;
  }

  async recordPermanentFailure(
    address: string,
    reason: string,
    threshold: number,
    at: Date,
  ): Promise<{ bounceCount: number; crossedThreshold: boolean }> {
    const tx = requireTransaction();
    const { tenantId } = requireContext();
    const normalized = normalizeAddress(address);

    const row = await tx.notificationSuppression.upsert({
      where: { tenantId_address: { tenantId, address: normalized } },
      create: {
        id: uuidv7(at.getTime()),
        tenantId,
        address: normalized,
        bounceCount: 1,
        lastReason: reason.slice(0, 500),
        lastBouncedAt: at,
        // Deliberately null even when the threshold is one. Suppression is decided below, in a
        // conditional update, and setting it here would make the row look already-suppressed to
        // the very call that suppressed it — so the first bounce would suppress the address and
        // alert nobody, which is the one outcome §7 must not have.
        suppressedAt: null,
      },
      update: {
        bounceCount: { increment: 1 },
        lastReason: reason.slice(0, 500),
        lastBouncedAt: at,
      },
    });

    if (row.suppressedAt !== null) {
      // Refused before this call. The administrator has been told once and is not told again: an
      // administrator alerted forty times about one dead mailbox stops reading the alert.
      return { bounceCount: row.bounceCount, crossedThreshold: false };
    }
    if (row.bounceCount < threshold) {
      return { bounceCount: row.bounceCount, crossedThreshold: false };
    }
    // Conditional on `suppressed_at` still being null, so two concurrent deliveries crossing the
    // threshold together produce one alert rather than two.
    const { count } = await tx.notificationSuppression.updateMany({
      where: { tenantId, address: normalized, suppressedAt: null },
      data: { suppressedAt: at },
    });
    return { bounceCount: row.bounceCount, crossedThreshold: count > 0 };
  }

  async release(address: string): Promise<boolean> {
    // The count goes back to zero with the suppression. A corrected address starts again, and
    // keeping the old count would suppress it on its first unrelated failure.
    const { count } = await requireTransaction().notificationSuppression.updateMany({
      where: {
        tenantId: requireContext().tenantId,
        address: normalizeAddress(address),
        suppressedAt: { not: null },
      },
      data: { suppressedAt: null, bounceCount: 0, lastReason: null },
    });
    return count > 0;
  }

  async list(page: PageRequest): Promise<Page<SuppressionRecord>> {
    const tx = requireTransaction();
    const where = { tenantId: requireContext().tenantId, suppressedAt: { not: null } };
    const total = await tx.notificationSuppression.count({ where });
    if (total === 0) {
      return toPage([], 0, page);
    }
    const rows = await tx.notificationSuppression.findMany({
      where,
      orderBy: { suppressedAt: 'desc' },
      skip: skipFor(page),
      take: page.pageSize,
    });
    return toPage(
      rows.map((row) => ({
        address: row.address,
        bounceCount: row.bounceCount,
        suppressedAt: row.suppressedAt,
        lastReason: row.lastReason,
      })),
      total,
      page,
    );
  }
}

/** 18 §7's storm control: one open window per bulk operation. */
@Injectable()
export class PrismaNotificationBatchRepository implements NotificationBatchRepository {
  async accumulate(input: {
    key: string;
    typeKey: string;
    recipientIds: readonly UserId[];
    values: Readonly<Record<string, string>>;
    releaseAt: Date;
  }): Promise<void> {
    const tx = requireTransaction();
    const { tenantId } = requireContext();

    const existing = await tx.notificationBatch.findUnique({
      where: { tenantId_key: { tenantId, key: input.key } },
      select: { recipientIds: true },
    });

    if (existing === null) {
      await tx.notificationBatch.create({
        data: {
          id: uuidv7(),
          tenantId,
          key: input.key,
          typeKey: input.typeKey,
          recipientIds: [...input.recipientIds],
          itemCount: 1,
          values: { ...input.values },
          // Set when the window opens and never extended, so a sweep that runs for an hour
          // produces a summary at the window mark and another for the remainder — rather than a
          // window that never closes because objects keep arriving.
          releaseAt: input.releaseAt,
        },
      });
      return;
    }

    const recipients = new Set([...existing.recipientIds, ...input.recipientIds]);
    await tx.notificationBatch.update({
      where: { tenantId_key: { tenantId, key: input.key } },
      data: { itemCount: { increment: 1 }, recipientIds: [...recipients] },
    });
  }

  async claimClosed(now: Date, limit: number): Promise<readonly NotificationBatch[]> {
    const tx = requireTransaction();
    const { tenantId } = requireContext();
    const rows = await tx.notificationBatch.findMany({
      where: { tenantId, releaseAt: { lte: now } },
      orderBy: { releaseAt: 'asc' },
      take: limit,
    });
    if (rows.length === 0) {
      return [];
    }
    // Deleted as they are claimed, in the same transaction that reads them: the summary is
    // produced from the returned rows, so a redelivery finds nothing and cannot send twice.
    await tx.notificationBatch.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });

    return rows.map((row) => ({
      key: row.key,
      typeKey: row.typeKey,
      recipientIds: row.recipientIds.map((id) => asId<UserId>(id)),
      itemCount: row.itemCount,
      releaseAt: row.releaseAt,
      values: toStringRecord(row.values),
    }));
  }
}

/**
 * Mail addresses are matched case-insensitively.
 *
 * The local part is technically case-sensitive per RFC 5321 and no mail provider in use treats
 * it that way. Suppressing `Ada@example.test` and then writing to `ada@example.test` would be a
 * suppression that suppresses nothing.
 */
function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

/**
 * What a delivery pass may take: queued, this tenant's, this channel's, and not being held.
 *
 * One definition rather than two, because the select and the claim must ask the same question.
 * A claim that re-checked something weaker than what was selected would hand out rows another
 * pass already holds; a claim that re-checked something stronger would silently drop work.
 *
 * A row whose `releaseAt` is in the future is not waiting — it is being held — so it is not
 * claimed. That predicate is what quiet hours and digests are built on, and it is why neither
 * needs a scheduler of its own: the database decides what is due, every pass, from the row itself.
 */
function dueForDelivery(tenantId: string, channel: NotificationChannelKey, now: Date) {
  return {
    tenantId,
    channel,
    state: DeliveryState.QUEUED,
    OR: [{ releaseAt: null }, { releaseAt: { lte: now } }],
  };
}

export type DueForDelivery = ReturnType<typeof dueForDelivery>;

function toStringRecord(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      result[key] = entry;
    }
  }
  return result;
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
  createdAt: Date;
  address: string;
  releaseAt: Date | null;
  digestWindow: string | null;
  digestMessageId: string | null;
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
    createdAt: row.createdAt,
    address: row.address,
    releaseAt: row.releaseAt,
    digestWindow: row.digestWindow as DigestFrequencyKey | null,
    digestMessageId: row.digestMessageId ? asId<NotificationMessageId>(row.digestMessageId) : null,
  };
}
