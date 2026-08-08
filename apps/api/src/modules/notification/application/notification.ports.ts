import type {
  DeliveryStateKey,
  DigestFrequencyKey,
  NotificationChannelKey,
  NotificationMessageId,
  UserId,
} from '@edms/domain';
import type { Page, PageRequest } from '@edms/utils';

import type { MessageTemplate } from '../domain/template';
import type { RecipientPreference } from '../domain/notification-types';
import type { QuietHoursWindow } from '../domain/quiet-hours';

/**
 * Notification's contracts — **one file, as of Phase 12**.
 *
 * Phase 0.5 sketched these responsibilities in `application/ports.ts` before anything satisfied
 * them, and Phase 1 implemented a different shape here. The module README recorded the split as
 * temporary: "they merge when the Phase 0.5 stubs' remaining methods — digests, delivery
 * receipts — are built by the phase that owns them". That is this phase, and the sketch is gone.
 *
 * What survived the merge and what did not is worth stating, because the sketch was not simply
 * wrong. Its `NotificationService.notify` took a `templateKey`; the implemented one takes a
 * *type* key, and the difference is the whole of §5 — a type has preferences, a template is what
 * one of its channels renders with, and a caller that names a template has already chosen a
 * channel on the recipient's behalf. Its `NotificationMessageRecord` carried no rendered text;
 * the real one does, because what was sent is a fact a later template edit must not change. And
 * its preference repository was per user rather than per `(user, type)`, which could not express
 * "email me approvals and nothing else" — the preference §5 exists for.
 *
 * Its `digest` field on the preference *was* right, and had nothing reading it until now.
 */

export const NOTIFICATION_SERVICE = Symbol('NotificationService');

/**
 * What a sender says.
 *
 * `eventId` is what makes delivery idempotent: it identifies the *thing that happened*, so
 * re-running whatever produced it cannot notify anyone twice. A caller with no natural event
 * id should mint one and keep it, not generate a fresh one per attempt.
 */
export interface NotifyCommand {
  readonly eventId: string;
  readonly typeKey: string;
  readonly recipientIds: readonly UserId[];
  /** Values for the template's placeholders. `displayName` is supplied automatically. */
  readonly values: Readonly<Record<string, string>>;
}

export const NOTIFICATION_TEMPLATE_REPOSITORY = Symbol('NotificationTemplateRepository');
export const NOTIFICATION_MESSAGE_REPOSITORY = Symbol('NotificationMessageRepository');
export const NOTIFICATION_PREFERENCE_REPOSITORY = Symbol('NotificationPreferenceRepository');
export const NOTIFICATION_SUPPRESSION_REPOSITORY = Symbol('NotificationSuppressionRepository');
export const NOTIFICATION_BATCH_REPOSITORY = Symbol('NotificationBatchRepository');

export interface NotificationTemplateRepository {
  /** A tenant's override, or null to use the one the product ships. */
  findOverride(
    typeKey: string,
    channel: NotificationChannelKey,
    locale: string,
  ): Promise<MessageTemplate | null>;
  saveOverride(
    typeKey: string,
    channel: NotificationChannelKey,
    locale: string,
    template: MessageTemplate,
  ): Promise<void>;
  /** Every override a tenant holds — the administration screen's list. */
  listOverrides(): Promise<readonly TemplateOverrideRecord[]>;
  /** Removes an override, returning the type to the template the product ships. */
  deleteOverride(
    typeKey: string,
    channel: NotificationChannelKey,
    locale: string,
  ): Promise<boolean>;
}

export interface TemplateOverrideRecord extends MessageTemplate {
  readonly typeKey: string;
  readonly channel: NotificationChannelKey;
  readonly locale: string;
  readonly updatedAt: Date;
}

export interface NotificationMessageRecord {
  readonly id: NotificationMessageId;
  readonly recipientId: UserId;
  readonly typeKey: string;
  readonly channel: NotificationChannelKey;
  readonly locale: string;
  readonly subject: string;
  readonly bodyText: string;
  readonly bodyHtml: string | null;
  readonly state: DeliveryStateKey;
  readonly attempts: number;
  readonly readAt: Date | null;
  readonly createdAt: Date;
  /** The channel address it goes to. Held for delivery, never shown in an inbox. */
  readonly address: string;
  /**
   * When a held message may go out — quiet hours' end, or the digest window's.
   *
   * Null for everything that was never held. It gates the delivery claim as well as naming the
   * state: a `QUEUED` row with a future `releaseAt` cannot be claimed, which is what makes a
   * quiet-hours hold survive a restart with no scheduler state of its own.
   */
  readonly releaseAt: Date | null;
  /**
   * Which digest window this message is waiting for, or null when it waits for none.
   *
   * Stored on the message rather than re-read from the preference at collection time. The two
   * answers differ the moment somebody changes their mind mid-window, and the honest one is the
   * choice that was in force when the message was held — a user who switches from daily to
   * hourly has not retroactively asked for yesterday's messages to arrive sooner.
   */
  readonly digestWindow: DigestFrequencyKey | null;
  /** The digest this went out inside, once one collected it. */
  readonly digestMessageId: NotificationMessageId | null;
}

export interface NewNotificationMessage {
  readonly id: NotificationMessageId;
  readonly recipientId: UserId;
  readonly typeKey: string;
  readonly channel: NotificationChannelKey;
  readonly locale: string;
  readonly subject: string;
  readonly bodyText: string;
  readonly bodyHtml: string | null;
  readonly state: DeliveryStateKey;
  readonly idempotencyKey: string;
  readonly address: string;
  readonly releaseAt: Date | null;
  readonly digestWindow: DigestFrequencyKey | null;
  readonly failureReason: string | null;
}

export interface InboxQuery extends PageRequest {
  /** Only what has not been read. The inbox's default view is everything. */
  readonly unreadOnly: boolean;
}

export interface NotificationMessageRepository {
  create(message: NewNotificationMessage): Promise<void>;
  findByIdempotencyKey(key: string): Promise<NotificationMessageRecord | null>;
  /** One person's notifications, newest first. In-app only — email is not an inbox. */
  listInbox(recipientId: UserId, query: InboxQuery): Promise<Page<NotificationMessageRecord>>;
  /** How many of one person's in-app notifications are unread. */
  countUnread(recipientId: UserId): Promise<number>;
  /**
   * Marks one message read — **scoped to its recipient**, Phase 6.4.
   *
   * `recipientId` is a parameter rather than an implicit tenant predicate because the tenant is
   * not the boundary here: two colleagues in one tenant are two inboxes, and a route that takes a
   * message id from the URL reaches whichever row that id names. Until this phase the predicate
   * was `(id, tenantId)`, so a signed-in user who held a colleague's message id could clear their
   * unread marker — the one route on that controller whose "no user identifier on the wire"
   * argument did not hold, because `:id` is one.
   */
  markRead(id: NotificationMessageId, recipientId: UserId, at: Date): Promise<void>;
  /** Marks every unread in-app notification read at once, and says how many it moved. */
  markAllRead(recipientId: UserId, at: Date): Promise<number>;
  /**
   * Claims messages waiting to be sent, oldest first.
   *
   * A row whose `releaseAt` is in the future is not waiting — it is being held — so it is not
   * claimed. That predicate is what quiet hours and digests are built on.
   */
  claimQueued(
    channel: NotificationChannelKey,
    limit: number,
    now: Date,
  ): Promise<readonly NotificationMessageRecord[]>;
  /**
   * Moves held messages whose window has closed back into the queue.
   *
   * Only the ones a digest will *not* collect — `digestWindow` null — because a digested message
   * never goes out on its own and releasing it individually would send both it and the summary
   * that names it.
   */
  releaseHeld(now: Date, limit: number): Promise<number>;
  /** Held messages a digest window has closed over, per recipient and channel. */
  claimForDigest(
    frequency: DigestFrequencyKey,
    now: Date,
    limit: number,
  ): Promise<readonly NotificationMessageRecord[]>;
  /** Attaches a set of held messages to the digest that carried them. */
  markDigested(
    ids: readonly NotificationMessageId[],
    digestMessageId: NotificationMessageId,
  ): Promise<void>;
  recordDelivery(
    id: NotificationMessageId,
    outcome: {
      readonly state: DeliveryStateKey;
      readonly failureReason: string | null;
      readonly at: Date;
      /**
       * When a retryable failure may be attempted again — Phase 6.4.
       *
       * Only meaningful beside `QUEUED`: it is written to `release_at`, which `claimQueued`
       * already treats as "not due yet". Absent or null on every other outcome, which clears any
       * instant a previous attempt left behind.
       */
      readonly retryAt?: Date | null;
    },
  ): Promise<void>;
}

export interface NotificationPreferenceRepository {
  /** Null means "no opinion" — never "off". The type's defaults apply. */
  findFor(userId: UserId, typeKey: string): Promise<RecipientPreference | null>;
  /** Everything one person has expressed an opinion about, for the preference screen. */
  listFor(userId: UserId): Promise<readonly StoredPreference[]>;
  save(userId: UserId, typeKey: string, preference: RecipientPreference): Promise<void>;
  /** Returns a type to its defaults by removing the row, rather than storing "the defaults". */
  clear(userId: UserId, typeKey: string): Promise<void>;
  /** One person's quiet hours, or null when they have set none. */
  findQuietHours(userId: UserId): Promise<QuietHoursWindow | null>;
  /** Null clears them. */
  saveQuietHours(userId: UserId, window: QuietHoursWindow | null): Promise<void>;
}

export interface StoredPreference extends RecipientPreference {
  readonly typeKey: string;
}

/**
 * Addresses this tenant has stopped writing to — 18 §7's bounce row.
 *
 * **An address, not a user.** Identity owns users and nobody reads its tables, so a suppression
 * column on `user` was never available; but the stronger argument is that suppression is a fact
 * about a *mailbox*. A person who corrects their address should be reachable again immediately,
 * and one who inherits a colleague's old address should not inherit their bounces. Deriving it
 * from `notification_message` instead — counting permanent failures per address — was the third
 * option and was rejected because it makes an operational decision a scan: the count would grow
 * for ever and could not be cleared without deleting the record of what was sent.
 */
export interface SuppressionRecord {
  readonly address: string;
  readonly bounceCount: number;
  readonly suppressedAt: Date | null;
  readonly lastReason: string | null;
}

export interface NotificationSuppressionRepository {
  /** Whether this address is currently refused. The check every email send makes. */
  isSuppressed(address: string): Promise<boolean>;
  find(address: string): Promise<SuppressionRecord | null>;
  /**
   * Records one permanent failure and returns the address's state afterwards.
   *
   * Returns whether *this* call crossed the threshold, so the caller alerts once rather than on
   * every subsequent bounce — an administrator told forty times about one dead mailbox stops
   * reading the alert, which is the failure 18 §1's fifth principle is about.
   */
  recordPermanentFailure(
    address: string,
    reason: string,
    threshold: number,
    at: Date,
  ): Promise<{ readonly bounceCount: number; readonly crossedThreshold: boolean }>;
  /** Lifts a suppression — an administrator saying the address was fixed. */
  release(address: string): Promise<boolean>;
  list(page: PageRequest): Promise<Page<SuppressionRecord>>;
}

/**
 * One open coalescing window — 18 §7's "bulk operations emit one summary notification".
 *
 * The window is a row rather than a queue trick. A delayed job whose id encodes the batch would
 * coalesce too, and would carry only the *first* payload: BullMQ keeps the earliest job for a
 * repeated id and discards the rest, so the summary would say "1" however many arrived. A row
 * that increments is the only shape that can count.
 */
export interface NotificationBatch {
  readonly key: string;
  readonly typeKey: string;
  readonly recipientIds: readonly UserId[];
  readonly itemCount: number;
  readonly releaseAt: Date;
  readonly values: Readonly<Record<string, string>>;
}

export interface NotificationBatchRepository {
  /**
   * Adds one object to a window, opening it if this is the first.
   *
   * The window's end is set when it opens and never extended, so a sweep that runs for an hour
   * produces one summary at the fifteen-minute mark and a second for the remainder — rather than
   * a window that never closes because objects keep arriving.
   */
  accumulate(input: {
    readonly key: string;
    readonly typeKey: string;
    readonly recipientIds: readonly UserId[];
    readonly values: Readonly<Record<string, string>>;
    readonly releaseAt: Date;
  }): Promise<void>;
  /** Windows whose end has passed, removed as they are read so a redelivery finds nothing. */
  claimClosed(now: Date, limit: number): Promise<readonly NotificationBatch[]>;
}

/**
 * The surface other modules and the controllers call.
 *
 * Everything here is a use case; nothing reaches a repository from outside this module. The
 * shape is the Phase 0.5 sketch's, widened to what §5 actually needs — and `digestNow` is the
 * sketch's missing method, finally implemented rather than declared.
 */
export interface NotificationService {
  /** Queues per recipient and channel, honouring preferences, quiet hours and the digest window. */
  notify(command: NotifyCommand): Promise<readonly NotificationMessageId[]>;
  inbox(userId: UserId, query: InboxQuery): Promise<Page<NotificationMessageRecord>>;
  unreadCount(userId: UserId): Promise<number>;
  markRead(id: NotificationMessageId, recipientId: UserId): Promise<void>;
  markAllRead(userId: UserId): Promise<number>;
}
