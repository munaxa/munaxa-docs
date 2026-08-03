import type { NotificationChannelKey } from '@edms/domain';

/**
 * Outbound notification.
 *
 * One port per capability, not per vendor: SMTP, a hosted mail API and the in-app writer are
 * three adapters of the same interface (`docs/architecture/18-notification-architecture.md`).
 * Rendering is the notification module's job; the adapter only delivers.
 */
export const NOTIFICATION_PORT = Symbol('NotificationPort');

export interface NotificationRecipient {
  /** Channel-specific address: an email address, a device token, a webhook URL. */
  readonly address: string;
  readonly displayName: string | null;
  readonly locale: string;
}

export interface NotificationMessage {
  /** Deterministic per (message, recipient, channel): delivery is at-least-once. */
  readonly idempotencyKey: string;
  readonly recipient: NotificationRecipient;
  readonly subject: string;
  readonly bodyText: string;
  readonly bodyHtml: string | null;
  /** Never carries document content or personal data beyond what the recipient may already see. */
  readonly metadata: Readonly<Record<string, string>>;
}

export interface DeliveryReceipt {
  readonly accepted: boolean;
  readonly providerMessageId: string | null;
  readonly failureReason: string | null;
  /** Set when the provider says a retry is pointless (hard bounce, suppression list). */
  readonly permanentFailure: boolean;
}

export interface NotificationPort {
  readonly channel: NotificationChannelKey;
  send(message: NotificationMessage): Promise<DeliveryReceipt>;
}
