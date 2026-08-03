import { type DomainEventDraft, defineEvent } from '@edms/domain';

/**
 * Notification's domain events.
 *
 * An event is a fact in the past tense, its payload shape never changes once shipped, and
 * delivery is at least once — so every handler is idempotent on `eventId`
 * (`docs/architecture/02-backend-architecture.md` §6).
 *
 * The payloads are deliberately thin: an event carries identifiers and the facts a consumer
 * cannot derive, never a copy of the aggregate. A fat event becomes a second schema that
 * nobody migrates.
 */
export const NOTIFICATION_AGGREGATE = 'notification';

/** A message exists for a recipient and channel. */
export const NOTIFICATION_QUEUED = 'notification.queued' as const;

export interface NotificationQueuedPayload {
  readonly messageId: string;
  readonly recipientId: string;
  readonly channel: string;
  readonly templateKey: string;
}

export const notificationQueuedEvent = defineEvent<
  typeof NOTIFICATION_QUEUED,
  NotificationQueuedPayload
>(NOTIFICATION_QUEUED, 1, NOTIFICATION_AGGREGATE);

/** The provider accepted it. */
export const NOTIFICATION_SENT = 'notification.sent' as const;

export interface NotificationSentPayload {
  readonly messageId: string;
  readonly channel: string;
  readonly providerMessageId: string | null;
}

export const notificationSentEvent = defineEvent<typeof NOTIFICATION_SENT, NotificationSentPayload>(
  NOTIFICATION_SENT,
  1,
  NOTIFICATION_AGGREGATE,
);

/** Delivery failed; carries whether a retry is worthwhile. */
export const NOTIFICATION_FAILED = 'notification.failed' as const;

export interface NotificationFailedPayload {
  readonly messageId: string;
  readonly channel: string;
  readonly permanent: boolean;
  readonly reason: string;
}

export const notificationFailedEvent = defineEvent<
  typeof NOTIFICATION_FAILED,
  NotificationFailedPayload
>(NOTIFICATION_FAILED, 1, NOTIFICATION_AGGREGATE);

/** Every event type this module publishes, for the outbox's routing table. */
export const NOTIFICATION_EVENT_TYPES: readonly string[] = Object.freeze([
  NOTIFICATION_QUEUED,
  NOTIFICATION_SENT,
  NOTIFICATION_FAILED,
]);

export type NotificationEvent = DomainEventDraft;
