import {
  type DigestFrequencyKey,
  type NotificationChannelKey,
  DigestFrequency,
  NotificationChannel,
} from '@edms/domain';

/**
 * The notification catalogue — every kind of notification the product sends.
 *
 * A type that is not here does not exist, for the same reason a permission that is not in its
 * catalogue does not: a notification identified only by a string is one nobody can enumerate,
 * translate, or let a user turn off.
 *
 * Each entry carries the *defaults*. What actually reaches a person is resolved per recipient
 * — tenant policy, then their preference, then these
 * (`docs/architecture/18-notification-architecture.md` §5).
 */
export interface NotificationTypeDefinition {
  readonly key: string;
  /** Channels used when nobody has expressed a preference. */
  readonly defaultChannels: readonly NotificationChannelKey[];
  /**
   * A type the recipient may not silence.
   *
   * Security notifications are mandatory deliberately: a person must be told their account
   * changed, and an attacker who can suppress the warning has already won
   * (§4). A user may still choose *which* channel.
   */
  readonly mandatory: boolean;
  /** Whether a digest may hold this back. Urgent types are never rolled up. */
  readonly digestible: boolean;
  /** The placeholders the templates for this type may use, and must all be given. */
  readonly variables: readonly string[];
}

function define(definition: NotificationTypeDefinition): NotificationTypeDefinition {
  return Object.freeze(definition);
}

/**
 * Phase 1 ships the security types, because those are the events Phase 1 produces. Document,
 * workflow and retention types arrive with the phases that raise them — a catalogue entry for
 * a notification nothing sends is an entry nobody can test.
 */
export const NotificationType = {
  SECURITY_SIGN_IN_FROM_NEW_DEVICE: define({
    key: 'security.sign-in.new-device',
    defaultChannels: [NotificationChannel.EMAIL],
    mandatory: true,
    digestible: false,
    variables: ['displayName', 'occurredAt', 'ipAddress'],
  }),
  SECURITY_PASSWORD_CHANGED: define({
    key: 'security.password.changed',
    defaultChannels: [NotificationChannel.EMAIL],
    mandatory: true,
    digestible: false,
    variables: ['displayName', 'occurredAt'],
  }),
  SECURITY_SESSION_REVOKED: define({
    key: 'security.session.revoked',
    defaultChannels: [NotificationChannel.EMAIL, NotificationChannel.IN_APP],
    mandatory: true,
    digestible: false,
    variables: ['displayName', 'occurredAt', 'reason'],
  }),
} as const;

export type NotificationTypeKey = (typeof NotificationType)[keyof typeof NotificationType]['key'];

export const ALL_NOTIFICATION_TYPES: readonly NotificationTypeDefinition[] = Object.freeze(
  Object.values(NotificationType),
);

const BY_KEY: ReadonlyMap<string, NotificationTypeDefinition> = new Map(
  ALL_NOTIFICATION_TYPES.map((definition) => [definition.key, definition]),
);

export function notificationTypeFor(key: string): NotificationTypeDefinition | null {
  return BY_KEY.get(key) ?? null;
}

/** What a recipient has asked for. Absent fields mean "no opinion", not "off". */
export interface RecipientPreference {
  readonly channels: readonly NotificationChannelKey[];
  readonly digest: DigestFrequencyKey;
}

/**
 * Which channels a notification actually goes out on.
 *
 * Resolution order is tenant policy → user preference → type default (§5), and a mandatory
 * type cannot end up with none: silencing it is exactly what it exists to prevent. If the
 * preference would leave a mandatory type with nothing, the defaults are used instead.
 *
 * Channels the deployment cannot yet deliver on are dropped here rather than queued and left
 * to fail — a message queued for a channel with no adapter is an outage nobody sees.
 */
export function channelsFor(
  definition: NotificationTypeDefinition,
  preference: RecipientPreference | null,
  available: readonly NotificationChannelKey[],
): readonly NotificationChannelKey[] {
  const chosen = preference?.channels.length ? preference.channels : definition.defaultChannels;
  const deliverable = chosen.filter((channel) => available.includes(channel));

  if (deliverable.length > 0) {
    return deliverable;
  }
  if (!definition.mandatory) {
    return [];
  }
  // Mandatory, and the preference silenced it. Fall back to the defaults the product chose.
  return definition.defaultChannels.filter((channel) => available.includes(channel));
}

/**
 * Whether a digest may hold this notification back.
 *
 * Mandatory and non-digestible types go immediately whatever the window says. Everything else
 * honours it.
 */
export function shouldSendImmediately(
  definition: NotificationTypeDefinition,
  preference: RecipientPreference | null,
): boolean {
  if (!definition.digestible || definition.mandatory) {
    return true;
  }
  return (preference?.digest ?? DigestFrequency.IMMEDIATE) === DigestFrequency.IMMEDIATE;
}
