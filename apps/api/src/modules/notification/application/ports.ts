import type {
  DeliveryStateKey,
  DigestFrequencyKey,
  NotificationChannelKey,
  NotificationMessageId,
  UserId,
} from '@edms/domain';
import type { Page, PageRequest } from '@edms/utils';

/**
 * Rendering is this module's job; delivery belongs to the adapter behind
 * `NOTIFICATION_PORT`. Keeping them apart is what lets a tenant switch mail providers
 * without re-testing a single template.
 */
export const NOTIFICATION_TEMPLATE_REPOSITORY = Symbol('NotificationTemplateRepository');
export const NOTIFICATION_MESSAGE_REPOSITORY = Symbol('NotificationMessageRepository');
export const NOTIFICATION_PREFERENCE_REPOSITORY = Symbol('NotificationPreferenceRepository');

export interface NotificationTemplateRepository {
  findByKey(key: string, channel: NotificationChannelKey, locale: string): Promise<unknown>;
  save(template: unknown): Promise<void>;
}

export interface NotificationMessageRecord {
  readonly id: NotificationMessageId;
  readonly recipientId: UserId;
  readonly channel: NotificationChannelKey;
  readonly templateKey: string;
  readonly state: DeliveryStateKey;
  readonly attempts: number;
  readonly readAt: Date | null;
}

export interface NotificationMessageRepository {
  findById(id: NotificationMessageId): Promise<NotificationMessageRecord | null>;
  save(message: NotificationMessageRecord): Promise<void>;
  listInbox(recipientId: UserId, page: PageRequest): Promise<Page<NotificationMessageRecord>>;
  markRead(id: NotificationMessageId, at: Date): Promise<void>;
  /** Delivery is at-least-once; the key makes a re-run harmless. */
  findByIdempotencyKey(key: string): Promise<NotificationMessageRecord | null>;
}

export interface NotificationPreferenceRepository {
  findFor(
    userId: UserId,
  ): Promise<{ channels: readonly NotificationChannelKey[]; digest: DigestFrequencyKey } | null>;
  save(
    userId: UserId,
    preference: { channels: readonly NotificationChannelKey[]; digest: DigestFrequencyKey },
  ): Promise<void>;
}

export const NOTIFICATION_SERVICE = Symbol('NotificationService');

export interface NotificationService {
  /** Queues per recipient and channel, honouring their preferences and digest window. */
  notify(input: {
    recipientIds: readonly UserId[];
    templateKey: string;
    payload: Readonly<Record<string, string>>;
  }): Promise<void>;
  inbox(userId: UserId, page: PageRequest): Promise<Page<NotificationMessageRecord>>;
}
