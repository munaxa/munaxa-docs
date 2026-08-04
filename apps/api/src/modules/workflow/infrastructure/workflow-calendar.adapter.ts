import { Inject, Injectable } from '@nestjs/common';

import { DEFAULT_WORKING_CALENDAR, Settings, type WorkingCalendarView } from '@edms/domain';

import { SETTINGS_READER, type SettingsReader } from '../../../core/settings/settings.port';
import { APPROVAL_ROUTING_SERVICE } from '../../administration/application/approval-routing.ports';
import type { ApprovalRoutingService } from '../../administration/application/approval-routing.service';
import type { WorkflowCalendarReader } from '../application/ports';

/**
 * The working week a deadline is counted against.
 *
 * The entity's own calendar if it has one, the tenant's default if not, and the product's own week
 * if the tenant has configured neither — Saturday and Sunday off, no holidays, the tenant's
 * timezone. That last fallback is a stated default rather than a gap: a missing calendar never
 * means "count every day", because `WORKING_DAYS` is what every stage deadline is authored with and
 * silently counting weekends would make every deadline in the product wrong by two days a week.
 *
 * The timezone comes from `locale.timezone` rather than from the calendar row, and that is
 * deliberate. A holiday is a calendar day where the office is, and the setting's own description
 * says it is "the timezone dates are rendered in, and the one retention and reporting boundaries are
 * computed against". A per-calendar zone would be a second answer to the same question, and the two
 * would disagree on the day a report and a deadline landed either side of midnight.
 */
@Injectable()
export class WorkflowCalendarAdapter implements WorkflowCalendarReader {
  constructor(
    @Inject(APPROVAL_ROUTING_SERVICE) private readonly routing: ApprovalRoutingService,
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
  ) {}

  async forEntity(entityId: string | null): Promise<WorkingCalendarView> {
    const [calendar, timeZone] = await Promise.all([
      this.routing.calendarForEntity(entityId),
      this.settings.get(Settings.TIMEZONE),
    ]);
    if (calendar === null) {
      return { ...DEFAULT_WORKING_CALENDAR, timeZone };
    }
    return {
      weekendDays: calendar.weekendDays,
      // A set, because the walk asks "is this day a holiday" once per day it steps over, and a
      // linear scan of a year's holidays per step is the one part of this arithmetic that would
      // show up in a profile.
      holidays: new Set(calendar.holidays.map((holiday) => holiday.day)),
      timeZone,
    };
  }
}
