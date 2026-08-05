import { type DigestFrequencyKey, DigestFrequency } from '@edms/domain';

import { MINUTES_PER_DAY, localMinuteOfDay } from './quiet-hours';

/**
 * Digests — 18 §5's "immediate, digest, or off", and §3's "hourly or daily rollup per user,
 * replacing individual sends for types the user has digested".
 *
 * `DigestFrequency` has had four values since Phase 1 and nothing read one. This is what reads
 * them, and the shape of the answer is deliberately small: a frequency plus an instant gives the
 * end of the window that instant falls in, and that end is written on the held message as its
 * `release_at`. Nothing accumulates in memory, nothing is keyed on a "current digest" row, and a
 * process that dies mid-window loses nothing — the held rows are the accumulator.
 *
 * ## The window boundary is the tenant's morning, not midnight
 *
 * A daily digest delivered at 00:05 competes with everything that arrived overnight and is read
 * by nobody. The boundary is therefore an hour of the tenant's own working day, resolved through
 * its timezone, and the weekly one is the same hour on a Monday. Both are computed here rather
 * than expressed as a cron, because a cron fires in one zone and a tenant lives in its own.
 *
 * ## A digest is a list, and the renderer does not do lists
 *
 * `template.ts` substitutes and does nothing else, deliberately and for a stated security
 * reason. So the list is not built by the template: it is built *here*, from the subjects of the
 * messages the window collected, and passed to the renderer as a single `items` value like any
 * other. The renderer escapes it for an HTML body exactly as it escapes a document title. The
 * template language gains no loop, no conditional and no property access, and the digest gains a
 * list — which is the whole point of keeping composition and substitution apart.
 */

/** ISO weekday a weekly digest lands on — Monday, the day a week's work is planned. */
const WEEKLY_DELIVERY_WEEKDAY = 1;

/**
 * When the window containing `now` closes, for a frequency.
 *
 * `IMMEDIATE` has no window: it is the absence of a digest, and a caller asking for its end has
 * asked the wrong question — so it returns null rather than a nonsense instant.
 */
export function digestWindowEnd(
  frequency: DigestFrequencyKey,
  now: Date,
  timezone: string,
  deliveryHour: number,
): Date | null {
  switch (frequency) {
    case DigestFrequency.HOURLY: {
      // The next hour boundary, in real time. An hour is an hour in every zone, so this one
      // needs no local clock — and using one would make it wrong across a half-hour offset.
      const next = new Date(now.getTime());
      next.setUTCMinutes(0, 0, 0);
      next.setUTCHours(next.getUTCHours() + 1);
      return next;
    }
    case DigestFrequency.DAILY:
      return nextLocalDeliveryTime(now, timezone, deliveryHour, null);
    case DigestFrequency.WEEKLY:
      return nextLocalDeliveryTime(now, timezone, deliveryHour, WEEKLY_DELIVERY_WEEKDAY);
    default:
      return null;
  }
}

/**
 * The next time the local clock reads `deliveryHour`:00, optionally on a given ISO weekday.
 *
 * Computed as an offset from now in minutes for the reason `quiet-hours.ts` states: constructing
 * a local wall-clock time and converting back has to answer for the hour that occurs twice a
 * year, and there is no right answer. A digest an hour early or late on those two days is the
 * cheaper error.
 */
function nextLocalDeliveryTime(
  now: Date,
  timezone: string,
  deliveryHour: number,
  isoWeekday: number | null,
): Date {
  const minuteOfDay =
    localMinuteOfDay(now, timezone) ?? now.getUTCHours() * 60 + now.getUTCMinutes();
  const target = deliveryHour * 60;

  let minutesAhead = (target - minuteOfDay + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  if (minutesAhead === 0) {
    // Exactly on the boundary. The window that is closing has already been collected, so this
    // message belongs to the next one — never to a window in the past.
    minutesAhead = MINUTES_PER_DAY;
  }

  if (isoWeekday !== null) {
    const landsOn = localIsoWeekday(new Date(now.getTime() + minutesAhead * 60_000), timezone);
    const daysAhead = (isoWeekday - landsOn + 7) % 7;
    minutesAhead += daysAhead * MINUTES_PER_DAY;
  }
  return new Date(now.getTime() + minutesAhead * 60_000);
}

/** ISO weekday (Monday = 1 … Sunday = 7) of an instant in a zone. */
function localIsoWeekday(at: Date, timezone: string): number {
  let name: string;
  try {
    name = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'short' }).format(at);
  } catch {
    name = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short' }).format(at);
  }
  const index = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(name);
  return index === -1 ? 1 : index + 1;
}

/** One line of a digest: what a collected message said it was about. */
export interface DigestItem {
  readonly subject: string;
  readonly occurredAt: Date;
}

/**
 * The `items` value a digest template is rendered with.
 *
 * Plain text, one line per collected message, oldest first — because a digest is read as a
 * narrative of what happened and the newest-first ordering an inbox uses reads backwards in
 * prose. The bullet is a character rather than markup for the reason the whole file exists: this
 * is a *value*, and a value that carried markup would be a value that could carry a script tag.
 */
export function composeDigestItems(items: readonly DigestItem[]): string {
  return [...items]
    .sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime())
    .map((item) => `• ${item.subject}`)
    .join('\n');
}

/** How a digest names its own window, in the recipient's language. */
export function periodLabelFor(frequency: DigestFrequencyKey, locale: string): string {
  const labels: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    en: {
      [DigestFrequency.HOURLY]: 'in the last hour',
      [DigestFrequency.DAILY]: 'since yesterday',
      [DigestFrequency.WEEKLY]: 'in the last week',
    },
    ar: {
      [DigestFrequency.HOURLY]: 'في الساعة الماضية',
      [DigestFrequency.DAILY]: 'منذ الأمس',
      [DigestFrequency.WEEKLY]: 'في الأسبوع الماضي',
    },
  };
  return labels[locale]?.[frequency] ?? labels['en']?.[frequency] ?? '';
}
