import { z } from 'zod';

import { DigestFrequency, NotificationChannel } from '@edms/domain';

import { pageQuerySchema } from '../common/pagination';

/**
 * Phase 12 — notifications (`docs/architecture/18-notification-architecture.md`).
 *
 * Four shapes, and what each one deliberately is not.
 *
 * **The inbox is in-app only, and it carries rendered text rather than a payload.** What was sent
 * is a fact, and re-rendering a stored message against today's template would let an administrator
 * change what a person was told last month by editing a template this month. The client therefore
 * receives a subject and a body, not a type key and a bag of values.
 *
 * **A preference names a type, channels and a digest — never an address.** Where a notification
 * goes is the account's email, and a client that could set a delivery address could redirect
 * somebody else's notifications, which is 18 §8's fourth prohibition ("sent to an address not
 * verified for that user") expressed as an absent field.
 *
 * **Quiet hours are minutes past local midnight and an IANA zone.** Not two timestamps, which
 * expire, and not an offset, which is wrong twice a year.
 *
 * **A template override carries no `enabled` flag.** An override exists or it does not; a
 * disabled override is a row that says nothing, and deleting it is what returning to the shipped
 * template means.
 */

export const notificationChannelSchema = z.nativeEnum(NotificationChannel);
export const digestFrequencySchema = z.nativeEnum(DigestFrequency);

/** One notification in somebody's in-app inbox. */
export interface InboxNotification {
  readonly id: string;
  readonly typeKey: string;
  readonly subject: string;
  readonly body: string;
  readonly createdAt: string;
  readonly readAt: string | null;
}

export const inboxQuerySchema = pageQuerySchema.extend({
  /** `'true'` narrows to what has not been read. Absent means everything. */
  unread: z.enum(['true', 'false']).optional(),
});

export type InboxQueryParams = z.infer<typeof inboxQuerySchema>;

/** What a person has chosen for one notification type. */
export interface NotificationPreference {
  readonly typeKey: string;
  /** Empty means "off", where the type allows it. Absent from the list means "no opinion". */
  readonly channels: readonly string[];
  readonly digest: z.infer<typeof digestFrequencySchema>;
}

/**
 * A notification type, as the preference screen renders it.
 *
 * `mandatory` is what greys out the "off" choice, and `urgency` is what explains why a type is
 * never held by quiet hours. Both are computed server-side from the catalogue, because a client
 * that decided which types were silenceable would be deciding whether it could silence a security
 * warning.
 */
export interface NotificationTypeDescriptor {
  readonly key: string;
  readonly mandatory: boolean;
  readonly digestible: boolean;
  readonly urgency: string;
  readonly defaultChannels: readonly string[];
  /** The channels this type actually has a template for — the rest cannot be chosen. */
  readonly availableChannels: readonly string[];
}

export const savePreferenceSchema = z.object({
  channels: z.array(notificationChannelSchema).max(5),
  digest: digestFrequencySchema,
});

export type SavePreferenceBody = z.infer<typeof savePreferenceSchema>;

/** Minutes past local midnight, and the zone they are read in. */
export interface QuietHours {
  readonly startMinute: number;
  readonly endMinute: number;
  readonly timezone: string;
}

export const saveQuietHoursSchema = z.object({
  startMinute: z.number().int().min(0).max(1_439),
  endMinute: z.number().int().min(0).max(1_439),
  /**
   * Validated against `Intl` on the server rather than against a list here.
   *
   * A zone list in a schema is a list that goes stale: the IANA database is updated several times
   * a year, and a client compiled against last year's copy would refuse a zone the server
   * accepts. The length bound is only to keep an unbounded string out of the database.
   */
  timezone: z.string().min(1).max(64),
});

export type SaveQuietHoursBody = z.infer<typeof saveQuietHoursSchema>;

/** A tenant's override of a shipped template. */
export interface NotificationTemplateOverride {
  readonly typeKey: string;
  readonly channel: string;
  readonly locale: string;
  readonly subject: string;
  readonly bodyText: string;
  readonly bodyHtml: string | null;
  readonly updatedAt: string;
}

/**
 * What the editor sends, and what it may not.
 *
 * There is no field here by which a template names a variable outside its type's declared list —
 * the placeholders are text inside the body, and the server reports an undeclared one rather than
 * rendering it blank. That is the same check `render` makes at send time, made at save time so an
 * administrator learns about it while they are editing rather than when somebody is not told
 * something.
 */
export const saveTemplateSchema = z.object({
  subject: z.string().min(1).max(500),
  bodyText: z.string().min(1).max(20_000),
  bodyHtml: z.string().max(50_000).nullable(),
});

export type SaveTemplateBody = z.infer<typeof saveTemplateSchema>;

/** An address the tenant has stopped writing to (18 §7). */
export interface SuppressedAddress {
  /** Masked. 13 §3 minimises personal data, and an administrator needs to recognise it, not copy it. */
  readonly address: string;
  readonly bounceCount: number;
  readonly suppressedAt: string | null;
  readonly lastReason: string | null;
}
