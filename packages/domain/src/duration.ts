/**
 * ISO-8601 durations, as the engine counts them.
 *
 * Bounded to days and hours by `durationSchema` in `@edms/contracts`, and that bound is what makes
 * this file short and correct rather than long and approximately right. Months and years in a
 * duration are ambiguous — "P1M" from 31 January is a date the standard does not settle and no two
 * libraries agree on — and a deadline the engine cannot compute the same way twice is not a
 * deadline. Days and hours have one meaning each.
 *
 * Pure, and separate from the calendar arithmetic that uses it: parsing a duration is a question
 * about a string, and turning one into an instant is a question about a tenant's working week.
 */

/** A duration, reduced to what a deadline needs: whole working days, then a remainder in hours. */
export interface Duration {
  readonly days: number;
  readonly hours: number;
}

const DURATION = /^P(?:(\d{1,3})D)?(?:T(?:(\d{1,3})H)?)?$/;

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/**
 * Parses a duration, or returns null.
 *
 * Null rather than a throw, because both callers already have a better failure than an exception:
 * the version validator collects every rejection so an author fixes them in one pass, and the
 * engine has already had the string validated at publish, so a null here means the stored version
 * was written by something other than the product.
 */
export function parseDuration(raw: string): Duration | null {
  const match = DURATION.exec(raw);
  if (match === null) {
    return null;
  }
  const days = match[1] === undefined ? 0 : Number(match[1]);
  const hours = match[2] === undefined ? 0 : Number(match[2]);
  if (days === 0 && hours === 0) {
    // `P`, `PT` and `P0D` all describe no time at all. A deadline of zero is a deadline that has
    // already passed at the instant it is set, which is a definition mistake rather than an urgent
    // stage — and the version validator is where it should be caught.
    return null;
  }
  return { days, hours };
}

/** The duration as milliseconds, for a calendar that does not skip days. */
export function durationMs(duration: Duration): number {
  return duration.days * DAY_MS + duration.hours * HOUR_MS;
}

/**
 * Renders a duration back to ISO-8601.
 *
 * Used where a stored offset is echoed to a client or recorded on a timer, so that what the API
 * says and what the definition said are the same string rather than two renderings of one value.
 */
export function formatDuration(duration: Duration): string {
  const days = duration.days > 0 ? `${String(duration.days)}D` : '';
  const hours = duration.hours > 0 ? `T${String(duration.hours)}H` : '';
  return `P${days}${hours}`;
}
