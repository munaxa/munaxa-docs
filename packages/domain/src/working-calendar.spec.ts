import { describe, expect, it } from 'vitest';

import { parseDuration } from './duration';
import { DeadlineCalendar } from './enums/workflow';
import {
  DEFAULT_WORKING_CALENDAR,
  type WorkingCalendarView,
  calendarDay,
  deadlineFor,
  isWorkingDay,
  isoWeekday,
} from './working-calendar';

/**
 * Deadline arithmetic, which is the phase's named risk in its smallest form.
 *
 * A deadline that is wrong by a day is not a rounding error: it is a reminder sent after the fact,
 * an escalation to somebody's manager over work that was never late, and — under `AUTO_APPROVE` —
 * an approval nobody made. Every assertion here is a date somebody could check by looking at a wall
 * calendar, which is the only way to test this kind of arithmetic honestly.
 */

const MONDAY_9AM = new Date('2026-03-02T09:00:00Z');

function calendar(overrides: Partial<WorkingCalendarView> = {}): WorkingCalendarView {
  return { ...DEFAULT_WORKING_CALENDAR, ...overrides };
}

function due(from: Date, iso: string, working = calendar()): string {
  const duration = parseDuration(iso);
  expect(duration).not.toBeNull();
  return deadlineFor(from, duration!, DeadlineCalendar.WORKING_DAYS, working).toISOString();
}

describe('parseDuration', () => {
  it('reads days and hours', () => {
    expect(parseDuration('P3D')).toEqual({ days: 3, hours: 0 });
    expect(parseDuration('PT8H')).toEqual({ days: 0, hours: 8 });
    expect(parseDuration('P2DT4H')).toEqual({ days: 2, hours: 4 });
  });

  it('refuses a duration of no time at all', () => {
    // A deadline of zero has already passed at the instant it is set. Better refused at publish
    // than discovered by the first person it escalates on.
    expect(parseDuration('P')).toBeNull();
    expect(parseDuration('PT')).toBeNull();
    expect(parseDuration('P0D')).toBeNull();
  });

  it('refuses months and years, which have no single meaning', () => {
    expect(parseDuration('P1M')).toBeNull();
    expect(parseDuration('P1Y')).toBeNull();
    expect(parseDuration('PT30M')).toBeNull();
  });
});

describe('working days', () => {
  it('counts a weekday duration as ordinary days', () => {
    // Monday + 3 working days is Thursday.
    expect(due(MONDAY_9AM, 'P3D')).toBe('2026-03-05T09:00:00.000Z');
  });

  it('steps over the weekend', () => {
    // Thursday + 3 working days is Tuesday: Friday, then Saturday and Sunday do not count.
    expect(due(new Date('2026-03-05T09:00:00Z'), 'P3D')).toBe('2026-03-10T09:00:00.000Z');
  });

  it('starts the clock on the next working day when the submission was not on one', () => {
    // Submitted Saturday. The clock starts Monday at midnight rather than at Saturday's time of
    // day, so the person who submits at the weekend and the person who submits first thing Monday
    // get the same deadline — nobody worked in between.
    expect(due(new Date('2026-03-07T14:00:00Z'), 'P1D')).toBe('2026-03-10T00:00:00.000Z');
  });

  it('rolls an hourly deadline that lands on a weekend to the next working day', () => {
    // Friday 17:00 + 8 working hours. Seven of them fit before midnight; the eighth would fall on
    // Saturday, so it is given back at the start of Monday. Naively the answer is Saturday 01:00,
    // which is a deadline nobody could have met.
    expect(due(new Date('2026-03-06T17:00:00Z'), 'PT8H')).toBe('2026-03-09T01:00:00.000Z');
  });

  it('steps over a holiday', () => {
    const withHoliday = calendar({ holidays: new Set(['2026-03-03']) });
    // Monday + 2 working days would be Wednesday; Tuesday is a holiday, so it is Thursday.
    expect(due(MONDAY_9AM, 'P2D', withHoliday)).toBe('2026-03-05T09:00:00.000Z');
  });

  it('honours a Friday–Saturday weekend', () => {
    // The reason `weekendDays` is a list rather than a boolean. Sunday is a working day here and
    // Friday is not, so Thursday + 2 working days is Sunday, then Monday.
    const gulf = calendar({ weekendDays: [5, 6] });
    expect(due(new Date('2026-03-05T09:00:00Z'), 'P2D', gulf)).toBe('2026-03-09T09:00:00.000Z');
  });

  it('counts calendar days without walking, when the definition asks for them', () => {
    const duration = parseDuration('P3D')!;
    const result = deadlineFor(
      new Date('2026-03-05T09:00:00Z'),
      duration,
      DeadlineCalendar.CALENDAR_DAYS,
      calendar(),
    );
    // Thursday + 3 calendar days is Sunday. That is the point of the other calendar: a contractual
    // clock does not stop at the weekend.
    expect(result.toISOString()).toBe('2026-03-08T09:00:00.000Z');
  });
});

describe('time zones', () => {
  it('reads the weekday where the office is, not in UTC', () => {
    // 23:00 UTC on Sunday is already Monday in Auckland. An engine answering "Sunday" would refuse
    // to start a clock that has already started for the people who have to meet it.
    const sundayEvening = new Date('2026-03-01T23:00:00Z');
    expect(isoWeekday(sundayEvening, 'UTC')).toBe(7);
    expect(isoWeekday(sundayEvening, 'Pacific/Auckland')).toBe(1);
  });

  it('reads a holiday as the calendar day it is where the office is', () => {
    const auckland = calendar({ timeZone: 'Pacific/Auckland', holidays: new Set(['2026-03-02']) });
    // Still Sunday in UTC, already the Monday holiday in Auckland.
    expect(calendarDay(new Date('2026-03-01T23:00:00Z'), 'Pacific/Auckland')).toBe('2026-03-02');
    expect(isWorkingDay(new Date('2026-03-01T23:00:00Z'), auckland)).toBe(false);
  });

  it('keeps the wall clock across a daylight-saving change', () => {
    // Sunday 29 March 2026 is when Europe springs forward. Friday 08:00 UTC is 09:00 in Berlin;
    // one working day later is Monday 09:00 in Berlin, which is 07:00 UTC because the offset moved.
    // Adding a flat 24 hours would have said 08:00 UTC — an hour late, twice a year, everywhere
    // that observes a clock change.
    const berlin = calendar({ timeZone: 'Europe/Berlin' });
    const fridayBefore = new Date('2026-03-27T08:00:00Z');
    expect(due(fridayBefore, 'P1D', berlin)).toBe('2026-03-30T07:00:00.000Z');
  });
});
