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

/**
 * Where one message has got to.
 *
 * Phase 1 shipped five values and Phase 12 adds two, because holding a message back turned out
 * to be a *state* rather than a query. The alternative considered was a window on the delivery
 * query alone — `QUEUED` rows with a `release_at` in the future, invisible to the claim — and it
 * was rejected for one reason: an operator asking "what is waiting to go out" would get one
 * number covering both a mail outage and a quiet-hours hold, which are the two conditions that
 * most need telling apart. `release_at` still exists and still gates the claim; the state says
 * *why* a row is not moving.
 *
 * Both new values are truthful terminal-or-waiting positions, never a synonym for an existing
 * one. In particular a digested message is not `SUPPRESSED`: suppression means an address that
 * must not be written to, and overloading it would make "how many addresses are we refusing to
 * send to" a question the table answers wrongly.
 */
export const DeliveryState = {
  QUEUED: 'QUEUED',
  SENT: 'SENT',
  DELIVERED: 'DELIVERED',
  FAILED: 'FAILED',
  SUPPRESSED: 'SUPPRESSED',
  /** Waiting for a window to open — quiet hours, or the digest it will be rolled into. */
  HELD: 'HELD',
  /** Went out inside a summary rather than on its own. Never delivered individually. */
  DIGESTED: 'DIGESTED',
} as const;

export type DeliveryStateKey = (typeof DeliveryState)[keyof typeof DeliveryState];

export const DigestFrequency = {
  IMMEDIATE: 'IMMEDIATE',
  HOURLY: 'HOURLY',
  DAILY: 'DAILY',
  WEEKLY: 'WEEKLY',
} as const;

export type DigestFrequencyKey = (typeof DigestFrequency)[keyof typeof DigestFrequency];

/**
 * How much attention a notification is entitled to demand.
 *
 * 18 §4's last column, made a value. It exists because quiet hours hold *non-urgent* messages
 * (§5) and nothing else in the model could answer "is this urgent": `mandatory` says a
 * preference may not silence a type, and `digestible` says a rollup may hold it back, and
 * neither is the same question. A password-reset notice is mandatory and urgent; an approval
 * assignment is urgent and not mandatory; a publication notice is neither.
 */
export const NotificationUrgency = {
  HIGH: 'HIGH',
  NORMAL: 'NORMAL',
  LOW: 'LOW',
} as const;

export type NotificationUrgencyKey = (typeof NotificationUrgency)[keyof typeof NotificationUrgency];
