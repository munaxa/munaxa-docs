import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';

import {
  type ApprovalGroup,
  type Collection,
  type CreateApprovalGroupBody,
  type CreateWorkingCalendarBody,
  type DeadlinePreview,
  type UpdateApprovalGroupBody,
  type UpdateWorkingCalendarBody,
  type WorkingCalendar,
  approvalGroupListQuerySchema,
  createApprovalGroupSchema,
  createWorkingCalendarSchema,
  deadlinePreviewQuerySchema,
  updateApprovalGroupSchema,
  updateWorkingCalendarSchema,
  workingCalendarListQuerySchema,
} from '@edms/contracts';
import {
  DEFAULT_WORKING_CALENDAR,
  DeadlineCalendar,
  Permission,
  Settings,
  deadlineFor,
  parseDuration,
} from '@edms/domain';

import { RequirePermission } from '../../../core/authorization/permission.decorator';
import { IfMatch } from '../../../core/http/admin-request';
import { ZodValidationPipe } from '../../../core/http/zod-validation.pipe';
import { ValidationError } from '../../../core/errors/application-errors';
import { SETTINGS_READER, type SettingsReader } from '../../../core/settings/settings.port';
import { CLOCK_PORT, type ClockPort } from '../../../ports/clock.port';
import {
  APPROVAL_ROUTING_SERVICE,
  type ApprovalGroupRow,
  type WorkingCalendarRow,
} from '../application/approval-routing.ports';
import type { ApprovalRoutingService } from '../application/approval-routing.service';
import { toCollection } from './administration.view';

/**
 * Approval groups and working calendars.
 *
 * Its own controller rather than more routes on `ConfigurationController`, for the reason that one
 * is split four ways already: these are gated on `workflow:manage` rather than `settings:manage`.
 * The person who authors approval workflows is the person who maintains the groups they route to
 * and the calendar their deadlines are counted against, and that is a narrower key than "can
 * configure the tenant" in the matrix.
 */
@Controller({ path: 'admin', version: '1' })
@RequirePermission(Permission.WORKFLOW_MANAGE)
export class ApprovalRoutingController {
  constructor(
    @Inject(APPROVAL_ROUTING_SERVICE) private readonly routing: ApprovalRoutingService,
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
    @Inject(CLOCK_PORT) private readonly clock: ClockPort,
  ) {}

  // --- Approval groups ----------------------------------------------------------------------

  @Get('approval-groups')
  async listGroups(
    @Query(new ZodValidationPipe(approvalGroupListQuerySchema))
    query: ReturnType<typeof approvalGroupListQuerySchema.parse>,
  ): Promise<Collection<ApprovalGroup>> {
    return toCollection(
      await this.routing.listGroups({ ...query, isActive: flag(query.isActive) }),
      toApprovalGroup,
    );
  }

  @Get('approval-groups/:id')
  async getGroup(@Param('id') id: string): Promise<ApprovalGroup> {
    return toApprovalGroup(await this.routing.getGroup(id));
  }

  @Post('approval-groups')
  @HttpCode(HttpStatus.CREATED)
  async createGroup(
    @Body(new ZodValidationPipe(createApprovalGroupSchema)) body: CreateApprovalGroupBody,
  ): Promise<ApprovalGroup> {
    return toApprovalGroup(await this.routing.createGroup(body));
  }

  @Patch('approval-groups/:id')
  async updateGroup(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateApprovalGroupSchema)) body: UpdateApprovalGroupBody,
    @IfMatch() version: number | undefined,
  ): Promise<ApprovalGroup> {
    return toApprovalGroup(await this.routing.updateGroup(id, body, version));
  }

  @Delete('approval-groups/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteGroup(
    @Param('id') id: string,
    @IfMatch() version: number | undefined,
  ): Promise<void> {
    await this.routing.deleteGroup(id, version);
  }

  @Post('approval-groups/:id/restore')
  @HttpCode(HttpStatus.NO_CONTENT)
  async restoreGroup(
    @Param('id') id: string,
    @IfMatch() version: number | undefined,
  ): Promise<void> {
    await this.routing.restoreGroup(id, version);
  }

  // --- Working calendars --------------------------------------------------------------------

  @Get('working-calendars')
  async listCalendars(
    @Query(new ZodValidationPipe(workingCalendarListQuerySchema))
    query: ReturnType<typeof workingCalendarListQuerySchema.parse>,
  ): Promise<Collection<WorkingCalendar>> {
    const zone = await this.timeZone();
    const page = await this.routing.listCalendars({ ...query, isActive: flag(query.isActive) });
    return toCollection(page, (row) => toWorkingCalendar(row, zone));
  }

  @Get('working-calendars/:id')
  async getCalendar(@Param('id') id: string): Promise<WorkingCalendar> {
    return toWorkingCalendar(await this.routing.getCalendar(id), await this.timeZone());
  }

  @Post('working-calendars')
  @HttpCode(HttpStatus.CREATED)
  async createCalendar(
    @Body(new ZodValidationPipe(createWorkingCalendarSchema)) body: CreateWorkingCalendarBody,
  ): Promise<WorkingCalendar> {
    return toWorkingCalendar(await this.routing.createCalendar(body), await this.timeZone());
  }

  @Patch('working-calendars/:id')
  async updateCalendar(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateWorkingCalendarSchema)) body: UpdateWorkingCalendarBody,
    @IfMatch() version: number | undefined,
  ): Promise<WorkingCalendar> {
    return toWorkingCalendar(
      await this.routing.updateCalendar(id, body, version),
      await this.timeZone(),
    );
  }

  @Delete('working-calendars/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteCalendar(
    @Param('id') id: string,
    @IfMatch() version: number | undefined,
  ): Promise<void> {
    await this.routing.deleteCalendar(id, version);
  }

  @Post('working-calendars/:id/restore')
  @HttpCode(HttpStatus.NO_CONTENT)
  async restoreCalendar(
    @Param('id') id: string,
    @IfMatch() version: number | undefined,
  ): Promise<void> {
    await this.routing.restoreCalendar(id, version);
  }

  /**
   * What a duration works out to against a calendar.
   *
   * Its own endpoint because the arithmetic is not obvious to the person authoring a workflow:
   * "P3D" started on a Thursday is the following Tuesday, and a screen that cannot say so leaves an
   * administrator to derive it from a weekend pattern and a holiday list. It is the *same* function
   * the engine uses, so what the preview promises is what the deadline will be.
   */
  @Get('working-calendars/preview/deadline')
  async previewDeadline(
    @Query(new ZodValidationPipe(deadlinePreviewQuerySchema))
    query: ReturnType<typeof deadlinePreviewQuerySchema.parse>,
  ): Promise<DeadlinePreview> {
    const duration = parseDuration(query.duration);
    if (duration === null) {
      throw new ValidationError('A duration is days and hours, e.g. P3D or PT8H.', [
        { field: 'duration', message: 'invalid' },
      ]);
    }
    const calendar =
      query.calendarId === undefined
        ? await this.routing.calendarForEntity(null)
        : await this.routing.getCalendar(query.calendarId);
    const zone = await this.timeZone();
    const view = calendarViewOf(calendar, zone);

    const from = query.from === undefined ? this.clock.now() : new Date(query.from);
    const dueAt = deadlineFor(from, duration, DeadlineCalendar.WORKING_DAYS, view);
    const elapsedDays = Math.round((dueAt.getTime() - from.getTime()) / 86_400_000);

    return {
      from: from.toISOString(),
      dueAt: dueAt.toISOString(),
      calendarCode: calendar?.code ?? 'DEFAULT',
      // What the walk stepped over, so the answer is explicable rather than magic.
      skippedDays: Math.max(0, elapsedDays - duration.days),
    };
  }

  /**
   * The tenant's timezone, which is what a calendar's days are bounded by.
   *
   * Read from settings rather than stored per calendar. A holiday is a calendar day where the
   * office is, and a tenant that spans two zones has one *business* clock — the same one retention
   * and reporting boundaries are computed against, which is exactly what `locale.timezone` says it
   * is for. A per-calendar zone would be a second answer to the same question.
   */
  private async timeZone(): Promise<string> {
    return this.settings.get(Settings.TIMEZONE);
  }
}

/** `'true'`/`'false'` from a query string, or absent. The schema has already bounded it. */
function flag(value: 'true' | 'false' | undefined): boolean | undefined {
  return value === undefined ? undefined : value === 'true';
}

function toApprovalGroup(row: ApprovalGroupRow): ApprovalGroup {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    isActive: row.isActive,
    members: row.members.map((member) => ({
      userId: member.userId,
      displayName: member.displayName,
      email: member.email,
    })),
    usedByWorkflowCount: row.usedByWorkflowCount,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
    deletedAt: row.deletedAt === null ? null : row.deletedAt.toISOString(),
    deletedBy: row.deletedBy,
  };
}

function toWorkingCalendar(row: WorkingCalendarRow, timeZone: string): WorkingCalendar {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    entityId: row.entityId,
    entityName: row.entityName,
    weekendDays: [...row.weekendDays],
    isDefault: row.isDefault,
    isActive: row.isActive,
    holidays: row.holidays.map((holiday) => ({
      id: holiday.id,
      day: holiday.day,
      name: holiday.name,
    })),
    timeZone,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
    deletedAt: row.deletedAt === null ? null : row.deletedAt.toISOString(),
    deletedBy: row.deletedBy,
  };
}

/**
 * A stored calendar as the arithmetic wants it, or the product's own week.
 *
 * A tenant that has configured nothing gets Saturday and Sunday off and no holidays, which is a
 * defensible default rather than a placeholder — and, more to the point, it is a *stated* one: a
 * missing calendar never means "count every day".
 */
export function calendarViewOf(
  row: WorkingCalendarRow | null,
  timeZone: string,
): typeof DEFAULT_WORKING_CALENDAR {
  if (row === null) {
    return { ...DEFAULT_WORKING_CALENDAR, timeZone };
  }
  return {
    weekendDays: row.weekendDays,
    holidays: new Set(row.holidays.map((holiday) => holiday.day)),
    timeZone,
  };
}
