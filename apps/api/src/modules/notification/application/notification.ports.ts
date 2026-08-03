import type {
  DeliveryStateKey,
  NotificationChannelKey,
  NotificationMessageId,
  UserId,
} from '@edms/domain';
import type { Page, PageRequest } from '@edms/utils';

import type { MessageTemplate } from '../domain/template';
import type { RecipientPreference } from '../domain/notification-types';

/**
 * Notification's contracts, as Phase 1 implements them.
 *
 * The Phase 0.5 shapes in `ports.ts` sketched the same responsibilities before there was
 * anything to satisfy them; these are the ones with implementations behind them. The split is
 * temporary: they merge when the Phase 0.5 stubs' remaining methods — digests, delivery
 * receipts — are built by the phase that owns them.
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
  /** The channel address it goes to. Held for delivery, never shown in an inbox. */
  readonly address: string;
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
}

export interface NotificationMessageRepository {
  create(message: NewNotificationMessage): Promise<void>;
  findByIdempotencyKey(key: string): Promise<NotificationMessageRecord | null>;
  /** One person's notifications, newest first. In-app only — email is not an inbox. */
  listInbox(recipientId: UserId, page: PageRequest): Promise<Page<NotificationMessageRecord>>;
  markRead(id: NotificationMessageId, at: Date): Promise<void>;
  /** Claims messages waiting to be sent, oldest first. */
  claimQueued(
    channel: NotificationChannelKey,
    limit: number,
  ): Promise<readonly NotificationMessageRecord[]>;
  recordDelivery(
    id: NotificationMessageId,
    outcome: {
      readonly state: DeliveryStateKey;
      readonly failureReason: string | null;
      readonly at: Date;
    },
  ): Promise<void>;
}

export interface NotificationPreferenceRepository {
  /** Null means "no opinion" — never "off". The type's defaults apply. */
  findFor(userId: UserId, typeKey: string): Promise<RecipientPreference | null>;
  save(userId: UserId, typeKey: string, preference: RecipientPreference): Promise<void>;
}
