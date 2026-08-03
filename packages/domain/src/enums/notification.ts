/** Notification vocabulary (`docs/architecture/18-notification-architecture.md`). */
export const NotificationChannel = {
  EMAIL: 'EMAIL',
  IN_APP: 'IN_APP',
  SMS: 'SMS',
  PUSH: 'PUSH',
  WEBHOOK: 'WEBHOOK',
} as const;

export type NotificationChannelKey = (typeof NotificationChannel)[keyof typeof NotificationChannel];

/** Channels a Phase 1 tenant can actually select. The rest are declared so the port,
 *  the preference model and the message table do not change when they are implemented. */
export const AVAILABLE_NOTIFICATION_CHANNELS: readonly NotificationChannelKey[] = Object.freeze([
  NotificationChannel.EMAIL,
  NotificationChannel.IN_APP,
]);

export const DeliveryState = {
  QUEUED: 'QUEUED',
  SENT: 'SENT',
  DELIVERED: 'DELIVERED',
  FAILED: 'FAILED',
  SUPPRESSED: 'SUPPRESSED',
} as const;

export type DeliveryStateKey = (typeof DeliveryState)[keyof typeof DeliveryState];

export const DigestFrequency = {
  IMMEDIATE: 'IMMEDIATE',
  HOURLY: 'HOURLY',
  DAILY: 'DAILY',
  WEEKLY: 'WEEKLY',
} as const;

export type DigestFrequencyKey = (typeof DigestFrequency)[keyof typeof DigestFrequency];
