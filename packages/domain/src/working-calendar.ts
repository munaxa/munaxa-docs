import { HOUR_MS, type Duration, durationMs } from './duration';
import { DeadlineCalendar, type DeadlineCalendarKey } from './enums/workflow';

/**
 * Turning a duration into an instant, against a tenant's working week.
 *
 * `07-workflow-architecture.md` §6 says deadlines are ISO-8601 durations evaluated against a
 * working-day calendar owned by Administration — a weekend pattern plus a holiday list, per entity.
 * Phase 4 built that calendar rather than deferring it, because `WORKING_DAYS` is the *default*
 * every stage deadline is authored with: a seam here would have meant every deadline in the product
 * silently counting Saturdays, and nothing would have said so.
 *
 * This file is the arithmetic and nothing else. It takes the calendar as a value, so it is pure,
 * exhaustively testable, and cannot be the reason a deadline computation touches the database in
 * the middle of a transaction. It lives in the shared package rather than inside the workflow module
 * because it has two callers that have to agree: the engine computes the deadline it will enforce,
 * and Administration's preview endpoint tells a workflow author what that deadline is going to be. A
 * second implementation of "three working days" is a screen that promises Tuesday and an engine that
 * escalates on Monday.
 *
 * ### The rule, stated once
 *
 * 1. **The clock starts on a working day.** A submission at the weekend starts counting at the
 *    beginning of the next working day. Otherwise a document submitted at 18:00 on Friday and one
 *    submitted at 09:00 on Monday would carry different deadlines despite nobody having worked in
 *    between.
 * 2. **A day advances the wall clock, not the instant.** "Three working days from Monday at 09:00"
 *    is Thursday at 09:00 — in the calendar's own timezone. Adding 72 hours would be an hour out
 *    twice a year in every tenant that observes daylight saving, in opposite directions.
 * 3. **An hour is an hour, and none of them elapse on a day nobody works.** Hours are added in real
 *    time; an hour that would land on a weekend or a holiday resumes at the start of the next
 *    working day instead. Without that rule `PT8H` on a Friday afternoon is due on Saturday
 *    morning, which is a deadline nobody could have met.
 *
 * The calendar knows which *days* are worked and not which hours of them are. A working-hours
 * calendar — 09:00 to 17:00, per entity, with half-days — is a genuinely bigger model, and the
 * phase report says plainly that it is not here.
 */

/** A calendar, as the arithmetic needs to see it. Administration owns the rows behind this. */
export interface WorkingCalendarView {
  /** ISO-8601 weekday numbers not worked: 1 is Monday, 7 is Sunday. */
  readonly weekendDays: readonly number[];
  /** `YYYY-MM-DD` in the calendar's own timezone. A set, because this is asked once per day walked. */
  readonly holidays: ReadonlySet<string>;
  /**
   * The IANA zone the calendar's days are bounded by.
   *
   * A holiday is a calendar day where the office is, not an interval of UTC. Without this, a tenant
   * in Auckland and one in São Paulo would disagree with the product about which day the 25th of
   * December is, in opposite directions.
   */
  readonly timeZone: string;
}

/** The most days a walk will step through before giving up. */
const MAX_WALK_DAYS = 3_650;

/** A wall-clock reading in some zone. Not an instant — the whole point is that it is not one. */
interface WallTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
}

/**
 * The deadline for a duration started at `from`.
 *
 * `CALENDAR_DAYS` is plain arithmetic — the calendar a tenant chooses when the control is a
 * contractual clock rather than somebody's working week — and `WORKING_DAYS` walks.
 */
export function deadlineFor(
  from: Date,
  duration: Duration,
  calendar: DeadlineCalendarKey,
  working: WorkingCalendarView,
): Date {
  if (calendar === DeadlineCalendar.CALENDAR_DAYS) {
    return new Date(from.getTime() + durationMs(duration));
  }

  let cursor = isWorkingDay(from, working) ? from : startOfNextWorkingDay(from, working);
  cursor = addWorkingDays(cursor, duration.days, working);
  return addWorkingHours(cursor, duration.hours, working);
}

/**
 * Advances `days` working days, keeping the time of day the calendar's own clock reads.
 *
 * Wall clock rather than elapsed time, per rule 2. A deadline is something a person is told —
 * "by Thursday morning" — and it stays Thursday morning across a clock change.
 */
export function addWorkingDays(from: Date, days: number, calendar: WorkingCalendarView): Date {
  let cursor = from;
  for (let counted = 0; counted < days; counted += 1) {
    cursor = nextWorkingDayAtSameTime(cursor, calendar);
  }
  return cursor;
}

/**
 * Adds `hours` of real time, skipping any that would elapse on a day nobody works.
 *
 * The remainder resumes at the *start* of the next working day rather than at the same time on it:
 * an hour spent on a Sunday is an hour nobody worked, so it is given back at the beginning of
 * Monday. Keeping the clock time instead would turn "eight working hours from Friday at 17:00"
 * into Monday at 17:00 — a working day, not a working hour.
 */
export function addWorkingHours(from: Date, hours: number, calendar: WorkingCalendarView): Date {
  let cursor = from;
  for (let counted = 0; counted < hours; counted += 1) {
    cursor = new Date(cursor.getTime() + HOUR_MS);
    if (!isWorkingDay(cursor, calendar)) {
      cursor = startOfNextWorkingDay(cursor, calendar);
    }
  }
  return cursor;
}

export function isWorkingDay(at: Date, calendar: WorkingCalendarView): boolean {
  if (calendar.weekendDays.includes(isoWeekday(at, calendar.timeZone))) {
    return false;
  }
  return !calendar.holidays.has(calendarDay(at, calendar.timeZone));
}

/** Midnight, local, at the beginning of the first working day strictly after `at`'s day. */
export function startOfNextWorkingDay(at: Date, calendar: WorkingCalendarView): Date {
  let wall = { ...wallTime(at, calendar.timeZone), hour: 0, minute: 0, second: 0, millisecond: 0 };
  for (let step = 0; step < MAX_WALK_DAYS; step += 1) {
    wall = addCalendarDays(wall, 1);
    const candidate = fromWallTime(wall, calendar.timeZone);
    if (isWorkingDay(candidate, calendar)) {
      return candidate;
    }
  }
  throw noWorkingDay();
}

/** The same time of day on the first working day strictly after `at`'s day. */
function nextWorkingDayAtSameTime(at: Date, calendar: WorkingCalendarView): Date {
  let wall = wallTime(at, calendar.timeZone);
  for (let step = 0; step < MAX_WALK_DAYS; step += 1) {
    wall = addCalendarDays(wall, 1);
    const candidate = fromWallTime(wall, calendar.timeZone);
    if (isWorkingDay(candidate, calendar)) {
      return candidate;
    }
  }
  throw noWorkingDay();
}

/**
 * The ISO weekday — 1 for Monday through 7 for Sunday — in a named zone.
 *
 * Derived from the zone's calendar date rather than from `getUTCDay()`, because the day of the week
 * is a fact about the zone the office is in. At 23:00 UTC on a Sunday it is already Monday in
 * Sydney, and an engine answering "Sunday" would refuse to start a clock that has already started.
 */
export function isoWeekday(at: Date, timeZone: string): number {
  const { year, month, day } = wallTime(at, timeZone);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

/** The calendar date at an instant, in a named zone, as `YYYY-MM-DD`. */
export function calendarDay(at: Date, timeZone: string): string {
  const { year, month, day } = wallTime(at, timeZone);
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/** What a clock in `timeZone` reads at this instant. */
function wallTime(at: Date, timeZone: string): WallTime {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);

  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');

  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
    millisecond: at.getMilliseconds(),
  };
}

/**
 * The instant at which a clock in `timeZone` reads this wall time.
 *
 * The inverse of `wallTime`, and there is no standard function for it. The offset is found by
 * measuring: read the wall time back at a guessed instant, and the difference between what was read
 * and what was wanted *is* the offset. Twice, because the first correction can itself cross a clock
 * change — the second pass settles it.
 *
 * A wall time that a clock change skipped (02:30 on a spring-forward morning) resolves to the
 * instant the clock jumped to, which is the only sensible answer and the one every date library
 * gives. A repeated wall time resolves to its first occurrence.
 */
function fromWallTime(wall: WallTime, timeZone: string): Date {
  const wanted = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
    wall.millisecond,
  );
  let instant = wanted - offsetAt(new Date(wanted), timeZone);
  instant = wanted - offsetAt(new Date(instant), timeZone);
  return new Date(instant);
}

/** The zone's offset from UTC, in milliseconds, at a given instant. */
function offsetAt(at: Date, timeZone: string): number {
  const wall = wallTime(at, timeZone);
  const asUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
    wall.millisecond,
  );
  return asUtc - at.getTime();
}

/** Calendar-date arithmetic on a wall time, with no zone involved. `Date.UTC` normalises overflow. */
function addCalendarDays(wall: WallTime, days: number): WallTime {
  const shifted = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + days));
  return {
    ...wall,
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/**
 * Unreachable against any calendar the database accepts.
 *
 * `ck_working_calendar_weekend` refuses a week with no working day, and a holiday list ten years
 * long with no gap in it is not a calendar. A throw rather than a silent return, so that a calendar
 * which somehow got past both is a failure somebody sees rather than a deadline in the wrong decade.
 */
function noWorkingDay(): Error {
  return new Error('This calendar has no working day within ten years of the deadline.');
}

/**
 * The calendar every tenant has before it configures one.
 *
 * Saturday and Sunday, no holidays, UTC. A default rather than a placeholder: a tenant that
 * configures nothing gets a correct and defensible working week, which is the same standard the
 * settings catalogue holds itself to.
 */
export const DEFAULT_WORKING_CALENDAR: WorkingCalendarView = Object.freeze({
  weekendDays: Object.freeze([6, 7]),
  holidays: new Set<string>(),
  timeZone: 'UTC',
});
