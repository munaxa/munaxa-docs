import {
  type DigestFrequencyKey,
  type NotificationChannelKey,
  type NotificationUrgencyKey,
  DigestFrequency,
  NotificationChannel,
  NotificationUrgency,
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
  /**
   * 18 §4's urgency column, made a value — and the only thing that answers "may quiet hours
   * hold this?" (§5). It is a separate question from both of the flags above: `mandatory` is
   * about whether a preference may silence a type, `digestible` about whether a rollup may
   * delay it, and neither says whether waking somebody at 03:00 is warranted.
   */
  readonly urgency: NotificationUrgencyKey;
  /** The placeholders the templates for this type may use, and must all be given. */
  readonly variables: readonly string[];
}

function define(definition: NotificationTypeDefinition): NotificationTypeDefinition {
  return Object.freeze(definition);
}

const EMAIL = NotificationChannel.EMAIL;
const IN_APP = NotificationChannel.IN_APP;
const BOTH: readonly NotificationChannelKey[] = Object.freeze([EMAIL, IN_APP]);

/**
 * Every placeholder a document-shaped notification names.
 *
 * Declared once because eight types share it and a per-type list that drifted would make a
 * template that renders under one type fail under its neighbour. `documentLink` is a URL and
 * nothing more: it resolves through ordinary authorisation like every other route, which is
 * 18 §8's third prohibition — a notification never grants access by virtue of a link.
 */
const DOCUMENT_VARIABLES: readonly string[] = Object.freeze([
  'documentTitle',
  'documentNumber',
  'documentLink',
]);

/**
 * Phase 1 shipped the three security types, because those were the events Phase 1 produced,
 * with the note that "document, workflow and retention types arrive with the phases that raise
 * them — a catalogue entry for a notification nothing sends is an entry nobody can test".
 *
 * Those phases have now all happened, and Phase 12 adds one entry per row of 18 §4 that has a
 * producer. Two of §4's rows deliberately gain nothing:
 *
 * - **`RevisionPublished` to "everyone who acknowledged the previous revision"** needs an
 *   acknowledgement model, and there is none. A type keyed to a table that does not exist is
 *   the entry Phase 1's rule forbids.
 * - **`LockExpiring`** needs a timer on the check-out lock, and Phase 6 built expiry as a
 *   predicate a later operation sweeps against rather than as a scheduled event. Nothing fires,
 *   so nothing can notify.
 *
 * `ImportCompleted` / `ExportReady` is half-present: `audit.export-ready` is a real event, and
 * it is not here because its recipient is the caller who asked for the bundle and is already
 * shown it — a notification whose whole content is "the thing you are looking at is ready".
 */
export const NotificationType = {
  SECURITY_SIGN_IN_FROM_NEW_DEVICE: define({
    key: 'security.sign-in.new-device',
    defaultChannels: [EMAIL],
    mandatory: true,
    digestible: false,
    urgency: NotificationUrgency.HIGH,
    variables: ['displayName', 'occurredAt', 'ipAddress'],
  }),
  SECURITY_PASSWORD_CHANGED: define({
    key: 'security.password.changed',
    defaultChannels: [EMAIL],
    mandatory: true,
    digestible: false,
    urgency: NotificationUrgency.HIGH,
    variables: ['displayName', 'occurredAt'],
  }),
  SECURITY_SESSION_REVOKED: define({
    key: 'security.session.revoked',
    defaultChannels: BOTH,
    mandatory: true,
    digestible: false,
    urgency: NotificationUrgency.HIGH,
    variables: ['displayName', 'occurredAt', 'reason'],
  }),

  // --- Workflow (18 §4 rows 1–3) ------------------------------------------------------------

  /** §4: "Assignee (and delegate, if active) · In-app + email · High — never digested by default". */
  APPROVAL_TASK_ASSIGNED: define({
    key: 'workflow.task-assigned',
    defaultChannels: BOTH,
    mandatory: false,
    digestible: false,
    urgency: NotificationUrgency.HIGH,
    variables: [...DOCUMENT_VARIABLES, 'stageName', 'dueAt'],
  }),
  APPROVAL_DEADLINE_APPROACHING: define({
    key: 'workflow.deadline-approaching',
    defaultChannels: BOTH,
    mandatory: false,
    digestible: false,
    urgency: NotificationUrgency.HIGH,
    variables: [...DOCUMENT_VARIABLES, 'stageName', 'dueAt'],
  }),
  APPROVAL_OVERDUE: define({
    key: 'workflow.overdue',
    defaultChannels: BOTH,
    mandatory: false,
    digestible: false,
    urgency: NotificationUrgency.HIGH,
    variables: [...DOCUMENT_VARIABLES, 'stageName', 'dueAt'],
  }),

  // --- Document (18 §4 rows 4–7) ------------------------------------------------------------

  DOCUMENT_APPROVED: define({
    key: 'document.approved',
    defaultChannels: BOTH,
    mandatory: false,
    digestible: true,
    urgency: NotificationUrgency.NORMAL,
    variables: DOCUMENT_VARIABLES,
  }),
  DOCUMENT_REJECTED: define({
    key: 'document.rejected',
    defaultChannels: BOTH,
    mandatory: false,
    digestible: true,
    urgency: NotificationUrgency.NORMAL,
    variables: [...DOCUMENT_VARIABLES, 'comment'],
  }),
  DOCUMENT_PUBLISHED: define({
    key: 'document.published',
    defaultChannels: BOTH,
    mandatory: false,
    digestible: true,
    urgency: NotificationUrgency.NORMAL,
    variables: DOCUMENT_VARIABLES,
  }),
  /** §4: "`CheckedOutByOther` · Lock holder · In-app · Low" — no email, by the table's own choice. */
  DOCUMENT_CHECKED_OUT: define({
    key: 'document.checked-out',
    defaultChannels: [IN_APP],
    mandatory: false,
    digestible: true,
    urgency: NotificationUrgency.LOW,
    variables: [...DOCUMENT_VARIABLES, 'expiresAt'],
  }),
  DOCUMENT_CHECKED_IN: define({
    key: 'document.checked-in',
    defaultChannels: [IN_APP],
    mandatory: false,
    digestible: true,
    urgency: NotificationUrgency.LOW,
    variables: [...DOCUMENT_VARIABLES, 'revisionLabel'],
  }),

  // --- Delegation (18 §4 row 8) -------------------------------------------------------------

  DELEGATION_REQUESTED: define({
    key: 'delegation.requested',
    defaultChannels: BOTH,
    mandatory: false,
    digestible: true,
    urgency: NotificationUrgency.NORMAL,
    variables: ['delegatorName', 'delegateName', 'startsAt', 'endsAt', 'delegationLink'],
  }),
  DELEGATION_APPROVED: define({
    key: 'delegation.approved',
    defaultChannels: BOTH,
    mandatory: false,
    digestible: true,
    urgency: NotificationUrgency.NORMAL,
    variables: ['delegatorName', 'delegateName', 'startsAt', 'endsAt', 'delegationLink'],
  }),
  DELEGATION_REVOKED: define({
    key: 'delegation.revoked',
    defaultChannels: BOTH,
    mandatory: false,
    digestible: true,
    urgency: NotificationUrgency.NORMAL,
    variables: ['delegatorName', 'delegateName', 'reason', 'delegationLink'],
  }),
  DELEGATION_EXPIRED: define({
    key: 'delegation.expired',
    defaultChannels: BOTH,
    mandatory: false,
    digestible: true,
    urgency: NotificationUrgency.NORMAL,
    variables: ['delegatorName', 'delegateName', 'endsAt', 'useCount', 'delegationLink'],
  }),

  // --- Retention (18 §4 rows 9–10) ----------------------------------------------------------

  /**
   * Phase 10's "no disposition-review reminder" row, discharged.
   *
   * Coalesced rather than sent per document: a nightly sweep settling five hundred schedules
   * would otherwise put five hundred messages in one controller's inbox, which is exactly what
   * 18 §7's last row forbids.
   */
  RETENTION_REVIEW_DUE: define({
    key: 'retention.review-due',
    defaultChannels: BOTH,
    mandatory: false,
    digestible: true,
    urgency: NotificationUrgency.NORMAL,
    variables: ['documentCount', 'reviewLink'],
  }),
  LEGAL_HOLD_PLACED: define({
    key: 'retention.hold-placed',
    defaultChannels: BOTH,
    mandatory: false,
    digestible: false,
    urgency: NotificationUrgency.HIGH,
    variables: [...DOCUMENT_VARIABLES, 'reason'],
  }),
  LEGAL_HOLD_RELEASED: define({
    key: 'retention.hold-released',
    defaultChannels: BOTH,
    mandatory: false,
    digestible: false,
    urgency: NotificationUrgency.HIGH,
    variables: DOCUMENT_VARIABLES,
  }),

  // --- Security and operations (18 §4 row 11, §7 row 5) -------------------------------------

  /** §4's "infected upload". Mandatory: a person whose file was quarantined must be told. */
  SECURITY_FILE_QUARANTINED: define({
    key: 'security.file-quarantined',
    defaultChannels: BOTH,
    mandatory: true,
    digestible: false,
    urgency: NotificationUrgency.HIGH,
    variables: ['filename', 'occurredAt', 'verdict'],
  }),
  /**
   * §7: "repeated hard bounces suppress the address and alert an administrator".
   *
   * Mandatory, because the person it is addressed to is the one who can fix it, and a
   * suppression nobody is told about is an account quietly cut off from every other
   * notification in this catalogue.
   */
  SECURITY_ADDRESS_SUPPRESSED: define({
    key: 'security.address-suppressed',
    defaultChannels: BOTH,
    mandatory: true,
    digestible: false,
    urgency: NotificationUrgency.HIGH,
    variables: ['maskedAddress', 'bounceCount', 'occurredAt'],
  }),
  /**
   * Phase 9's "the chain-broken alert is not delivered" row, discharged.
   *
   * Its recipient is an operator rather than an ordinary tenant user, and the delivery path is
   * the same one: an operator is a person with an account in the tenant holding `audit:view`.
   * The alternative — a cross-tenant operator channel — is ADR-0013's console, and routing this
   * there would make the highest-severity alert in the product depend on a surface that does
   * not exist yet.
   */
  AUDIT_CHAIN_BROKEN: define({
    key: 'audit.chain-broken',
    defaultChannels: [EMAIL],
    mandatory: true,
    digestible: false,
    urgency: NotificationUrgency.HIGH,
    variables: ['occurredAt', 'reason', 'auditLink'],
  }),

  /**
   * The digest envelope itself — a message whose subject is a count and whose body is the list
   * of what it collected.
   *
   * It is in the catalogue rather than special-cased because everything else about it is
   * ordinary: it is rendered from a template a tenant may override, in the recipient's locale,
   * and recorded as a message like any other. It is **not digestible** — a digest of digests is
   * a loop — and **not mandatory**, because a user who wants no digest simply does not choose
   * one.
   */
  DIGEST_SUMMARY: define({
    key: 'digest.summary',
    defaultChannels: [EMAIL],
    mandatory: false,
    digestible: false,
    urgency: NotificationUrgency.LOW,
    variables: ['displayName', 'itemCount', 'items', 'periodLabel'],
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

/**
 * What a recipient has asked for. Absent fields mean "no opinion", not "off".
 *
 * `channels` being an empty array is a real answer and means "off" — which
 * `channelsFor` honours for everything except a mandatory type.
 */
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
  // A *stored* preference is an opinion, including an empty one: choosing no channels is how §5's
  // "off (where allowed)" is expressed, and it is the only way to express it. The absence of a
  // row is what means "no opinion" — which is why this reads `preference === null` rather than
  // `channels.length`, as Phase 1 did when nothing could yet turn a type off.
  const chosen = preference === null ? definition.defaultChannels : preference.channels;
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

/**
 * Whether quiet hours may hold this notification back.
 *
 * §5: "quiet hours with a timezone, during which **non-urgent** notifications are held and
 * released afterwards". Urgency is the whole of the test — a mandatory type may still be
 * quiet-hour-able if it is not urgent, and none in this catalogue is, which is the catalogue
 * being consistent rather than the rule being redundant.
 */
export function mayBeHeldForQuietHours(definition: NotificationTypeDefinition): boolean {
  return definition.urgency !== NotificationUrgency.HIGH;
}
