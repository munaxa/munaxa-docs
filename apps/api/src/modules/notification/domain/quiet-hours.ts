/**
 * Quiet hours — 18 §5's second sentence, as arithmetic.
 *
 * "Per type, a user chooses: immediate, digest, or off (where allowed); plus **quiet hours with
 * a timezone, during which non-urgent notifications are held and released afterwards**."
 *
 * Two decisions are encoded here and both are worth stating.
 *
 * **A window is minutes-of-day, not two timestamps.** "Do not write to me between 19:00 and
 * 07:00" is a rule about a clock face, and storing it as instants would make it expire. The
 * window wraps midnight when the start is after the end, which is the ordinary case — an
 * evening-to-morning quiet period — rather than a special one.
 *
 * **The timezone is the user's, resolved to an offset at the instant asked.** `Intl` is the only
 * correct way to do that in Node without a timezone database of our own, and it is asked freshly
 * every time rather than cached: a cached offset is wrong twice a year, in the direction that
 * wakes somebody at 06:00.
 *
 * The release instant is computed by adding the remaining minutes to *now*, which is correct to
 * within the length of a DST transition on the two days a year one falls inside a quiet window.
 * The alternative — constructing a local wall-clock time and converting back — has to pick an
 * answer for the hour that occurs twice, and there is no right one. An hour of imprecision on a
 * message that was already being held overnight is the cheaper error, and it is stated rather
 * than hidden.
 */

export const MINUTES_PER_DAY = 1_440;

export interface QuietHoursWindow {
  /** Minutes past local midnight when the window opens, 0–1439. */
  readonly startMinute: number;
  /** Minutes past local midnight when it closes. Equal to the start means "no quiet hours". */
  readonly endMinute: number;
  /** An IANA zone — `Asia/Amman`, `UTC`. Validated where it is stored, trusted here. */
  readonly timezone: string;
}

/**
 * The local wall clock, in minutes past midnight, for an instant in a zone.
 *
 * Returns null for a zone `Intl` does not know, so a stored value that has been renamed or
 * mistyped degrades to "no quiet hours" rather than throwing on a delivery path.
 */
export function localMinuteOfDay(at: Date, timezone: string): number | null {
  let parts: readonly Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(at);
  } catch {
    return null;
  }

  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return null;
  }
  return hour * 60 + minute;
}

/** Whether a minute-of-day falls inside a window, including one that wraps midnight. */
export function windowCovers(window: QuietHoursWindow, minute: number): boolean {
  if (window.startMinute === window.endMinute) {
    // Zero-length. A user who set the same value twice meant "none", not "all day": the
    // opposite reading would silence every non-urgent notification for ever.
    return false;
  }
  if (window.startMinute < window.endMinute) {
    return minute >= window.startMinute && minute < window.endMinute;
  }
  return minute >= window.startMinute || minute < window.endMinute;
}

/**
 * When a message caught by quiet hours may go out, or null when it is not caught at all.
 *
 * Null is the answer for "no window configured", "a zone we cannot resolve" and "it is not quiet
 * now" alike, because all three mean the same thing to the caller: send it.
 */
export function releaseAfterQuietHours(window: QuietHoursWindow | null, now: Date): Date | null {
  if (window === null) {
    return null;
  }
  const minute = localMinuteOfDay(now, window.timezone);
  if (minute === null || !windowCovers(window, minute)) {
    return null;
  }
  const remaining = (window.endMinute - minute + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  // Never zero: `windowCovers` excludes the closing minute, so the remainder is at least one.
  return new Date(now.getTime() + remaining * 60_000);
}
