import { Inject, Injectable } from '@nestjs/common';

import { type AnyId, AuditSubjectType, asId, isUsableCode } from '@edms/domain';
import { type Page, squish } from '@edms/utils';

import {
  DuplicateError,
  NotFoundError,
  ValidationError,
} from '../../../core/errors/application-errors';
import {
  AdministeredWriter,
  AdministrativeOperation,
  type AdministrativeOperationKey,
  checkVersion,
} from '../../../core/persistence';
import { AdministrationAudit } from '../domain/audit-actions';
import {
  APPROVAL_ROUTING_REPOSITORY,
  type ApprovalGroupRow,
  type ApprovalRoutingRepository,
  type CalendarListRequest,
  type RoutingListRequest,
  type WorkingCalendarRow,
} from './approval-routing.ports';

/**
 * Approval groups and working calendars.
 *
 * Two small aggregates, and the rules that matter about both are rules about *change over time* —
 * the same thing that makes the rest of this module more than CRUD.
 *
 * **A group is a routing list, never a permission.** Adding somebody to "safety reviewers" makes
 * them a candidate for a stage that names the group; it grants nothing. That is why it is a
 * separate table from `role` rather than a role with no permissions: a role is resolved on every
 * request and a group is read once, at stage activation, and conflating them would make "add Sam to
 * the reviewers" an access change nobody reviewed.
 *
 * **A group in use is deactivated, never removed.** A published workflow version naming a group is
 * immutable, so deleting the group would leave a definition pointing at nothing — and the failure
 * would surface at somebody's submission rather than here.
 *
 * **Exactly one calendar per tenant is the default.** Setting a second moves the flag rather than
 * adding one, because a tenant with two defaults has none and the deadline arithmetic would depend
 * on which row a query returned first. The database holds the same rule as a partial unique index.
 *
 * **A calendar's holidays are replaced as a set.** A year of public holidays is loaded at once and
 * corrected at once, and a per-holiday endpoint would make "the 2027 list" forty requests that can
 * half-succeed.
 */
@Injectable()
export class ApprovalRoutingService {
  constructor(
    @Inject(APPROVAL_ROUTING_REPOSITORY) private readonly routing: ApprovalRoutingRepository,
    private readonly writer: AdministeredWriter,
  ) {}

  // --- Approval groups ----------------------------------------------------------------------

  listGroups(request: RoutingListRequest): Promise<Page<ApprovalGroupRow>> {
    return this.writer.read(() => this.routing.listGroups(request));
  }

  getGroup(id: string): Promise<ApprovalGroupRow> {
    return this.writer.read(() => this.requireGroup(id, true));
  }

  async createGroup(input: {
    key: string;
    name: string;
    description?: string | undefined;
    memberIds: readonly string[];
  }): Promise<ApprovalGroupRow> {
    const key = input.key.trim().toLowerCase();
    const name = this.requireName(input.name);

    return this.writer.write(async () => {
      if (await this.routing.groupKeyTaken(key, null)) {
        throw new DuplicateError('approval group', 'key');
      }
      const members = await this.requireLiveUsers(input.memberIds);

      const id = this.writer.clock.nextId();
      await this.routing.insertGroup({
        id,
        key,
        name,
        description: input.description === undefined ? null : squish(input.description),
      });
      await this.routing.replaceGroupMembers(id, members);

      return {
        result: await this.requireGroup(id, false),
        change: this.changed(id, AdministrativeOperation.CREATED, undefined, {
          key,
          name,
          memberCount: members.length,
        }),
      };
    });
  }

  async updateGroup(
    id: string,
    patch: {
      name?: string;
      description?: string | null;
      isActive?: boolean;
      memberIds?: readonly string[];
    },
    expectedVersion: number | undefined,
  ): Promise<ApprovalGroupRow> {
    return this.writer.write(async () => {
      const current = await this.requireGroup(id, false);
      checkVersion(expectedVersion, current.version);

      const members =
        patch.memberIds === undefined ? undefined : await this.requireLiveUsers(patch.memberIds);

      await this.routing.updateGroup(id, current.version, {
        ...(patch.name !== undefined && { name: this.requireName(patch.name) }),
        ...(patch.description !== undefined && {
          description: patch.description === null ? null : squish(patch.description),
        }),
        ...(patch.isActive !== undefined && { isActive: patch.isActive }),
      });
      if (members !== undefined) {
        await this.routing.replaceGroupMembers(id, members);
      }

      return {
        result: await this.requireGroup(id, false),
        change: this.changed(
          id,
          AdministrativeOperation.UPDATED,
          { name: current.name, isActive: current.isActive, memberCount: current.members.length },
          {
            ...(patch.name !== undefined && { name: patch.name }),
            ...(patch.isActive !== undefined && { isActive: patch.isActive }),
            ...(members !== undefined && { memberCount: members.length }),
          },
        ),
      };
    });
  }

  async deleteGroup(id: string, expectedVersion: number | undefined): Promise<void> {
    await this.writer.write(async () => {
      const current = await this.requireGroup(id, false);
      checkVersion(expectedVersion, current.version);
      if (current.usedByWorkflowCount > 0) {
        // A published version naming this group is immutable, so removing the group would leave a
        // definition pointing at nothing — and the failure would surface at somebody's submission.
        throw new ValidationError('A workflow still routes to this group.', [
          { field: 'workflows', message: String(current.usedByWorkflowCount) },
        ]);
      }
      await this.routing.setGroupDeleted(id, current.version, true);
      return {
        result: undefined,
        change: this.changed(id, AdministrativeOperation.DELETED, { key: current.key }, undefined),
      };
    });
  }

  async restoreGroup(id: string, expectedVersion: number | undefined): Promise<void> {
    await this.writer.write(async () => {
      const current = await this.requireGroup(id, true);
      checkVersion(expectedVersion, current.version);
      if (current.deletedAt !== null && (await this.routing.groupKeyTaken(current.key, id))) {
        throw new DuplicateError('approval group', 'key');
      }
      await this.routing.setGroupDeleted(id, current.version, false);
      return {
        result: undefined,
        change: this.changed(id, AdministrativeOperation.RESTORED, undefined, { key: current.key }),
      };
    });
  }

  /** The engine's read: who is in this group, right now. Never cached — people move. */
  membersOfGroup(key: string): Promise<readonly string[]> {
    return this.writer.read(() => this.routing.activeGroupMembers(key.trim().toLowerCase()));
  }

  // --- Working calendars --------------------------------------------------------------------

  listCalendars(request: CalendarListRequest): Promise<Page<WorkingCalendarRow>> {
    return this.writer.read(() => this.routing.listCalendars(request));
  }

  getCalendar(id: string): Promise<WorkingCalendarRow> {
    return this.writer.read(() => this.requireCalendar(id, true));
  }

  /** What the engine asks: the calendar this document's entity counts deadlines against. */
  calendarForEntity(entityId: string | null): Promise<WorkingCalendarRow | null> {
    return this.writer.read(() => this.routing.calendarForEntity(entityId));
  }

  async createCalendar(input: {
    code: string;
    name: string;
    entityId: string | null;
    weekendDays: readonly number[];
    isDefault: boolean;
    holidays: readonly { day: string; name: string }[];
  }): Promise<WorkingCalendarRow> {
    const code = this.requireCode(input.code);
    const name = this.requireName(input.name);

    return this.writer.write(async () => {
      if (await this.routing.calendarCodeTaken(code, null)) {
        throw new DuplicateError('working calendar', 'code');
      }
      await this.requireEntity(input.entityId);
      this.requireWorkingWeek(input.weekendDays);

      const id = this.writer.clock.nextId();
      if (input.isDefault) {
        // Cleared *before* the insert, not after: the partial unique index refuses a second default
        // the moment the row lands, so clearing afterwards is a statement that never runs. The row
        // does not exist yet, so `except` matches nothing and every existing default is moved.
        await this.routing.clearDefaultExcept(id);
      }
      await this.routing.insertCalendar({
        id,
        code,
        name,
        entityId: input.entityId,
        weekendDays: input.weekendDays,
        isDefault: input.isDefault,
      });
      await this.routing.replaceHolidays(id, this.holidaysOf(input.holidays));

      return {
        result: await this.requireCalendar(id, false),
        change: this.calendarChanged(id, AdministrativeOperation.CREATED, undefined, {
          code,
          name,
          weekendDays: input.weekendDays,
          isDefault: input.isDefault,
          holidayCount: input.holidays.length,
        }),
      };
    });
  }

  async updateCalendar(
    id: string,
    patch: {
      name?: string;
      entityId?: string | null;
      weekendDays?: readonly number[];
      isDefault?: boolean;
      isActive?: boolean;
      holidays?: readonly { day: string; name: string }[];
    },
    expectedVersion: number | undefined,
  ): Promise<WorkingCalendarRow> {
    return this.writer.write(async () => {
      const current = await this.requireCalendar(id, false);
      checkVersion(expectedVersion, current.version);

      if (patch.entityId !== undefined) {
        await this.requireEntity(patch.entityId);
      }
      if (patch.weekendDays !== undefined) {
        this.requireWorkingWeek(patch.weekendDays);
      }

      if (patch.isDefault === true) {
        // Before the update, for the same reason the create clears before inserting: the index
        // refuses the second default at the instant it is written.
        await this.routing.clearDefaultExcept(id);
      }
      await this.routing.updateCalendar(id, current.version, {
        ...(patch.name !== undefined && { name: this.requireName(patch.name) }),
        ...(patch.entityId !== undefined && { entityId: patch.entityId }),
        ...(patch.weekendDays !== undefined && { weekendDays: patch.weekendDays }),
        ...(patch.isDefault !== undefined && { isDefault: patch.isDefault }),
        ...(patch.isActive !== undefined && { isActive: patch.isActive }),
      });
      if (patch.holidays !== undefined) {
        await this.routing.replaceHolidays(id, this.holidaysOf(patch.holidays));
      }

      return {
        result: await this.requireCalendar(id, false),
        change: this.calendarChanged(
          id,
          AdministrativeOperation.UPDATED,
          {
            name: current.name,
            weekendDays: current.weekendDays,
            isDefault: current.isDefault,
            holidayCount: current.holidays.length,
          },
          {
            ...(patch.name !== undefined && { name: patch.name }),
            ...(patch.weekendDays !== undefined && { weekendDays: patch.weekendDays }),
            ...(patch.isDefault !== undefined && { isDefault: patch.isDefault }),
            ...(patch.holidays !== undefined && { holidayCount: patch.holidays.length }),
          },
        ),
      };
    });
  }

  async deleteCalendar(id: string, expectedVersion: number | undefined): Promise<void> {
    await this.writer.write(async () => {
      const current = await this.requireCalendar(id, false);
      checkVersion(expectedVersion, current.version);
      if (current.isDefault) {
        // Removing the fallback would leave every entity without one counting deadlines against the
        // product's own week without anybody having decided that. Name another default first.
        throw new ValidationError('Make another calendar the default before removing this one.', [
          { field: 'isDefault', message: 'default' },
        ]);
      }
      await this.routing.setCalendarDeleted(id, current.version, true);
      return {
        result: undefined,
        change: this.calendarChanged(
          id,
          AdministrativeOperation.DELETED,
          { code: current.code },
          undefined,
        ),
      };
    });
  }

  async restoreCalendar(id: string, expectedVersion: number | undefined): Promise<void> {
    await this.writer.write(async () => {
      const current = await this.requireCalendar(id, true);
      checkVersion(expectedVersion, current.version);
      if (current.deletedAt !== null && (await this.routing.calendarCodeTaken(current.code, id))) {
        throw new DuplicateError('working calendar', 'code');
      }
      await this.routing.setCalendarDeleted(id, current.version, false);
      return {
        result: undefined,
        change: this.calendarChanged(id, AdministrativeOperation.RESTORED, undefined, {
          code: current.code,
        }),
      };
    });
  }

  // --- Internals ----------------------------------------------------------------------------

  private async requireGroup(id: string, includeDeleted: boolean): Promise<ApprovalGroupRow> {
    const row = await this.routing.findGroup(id, includeDeleted);
    if (row === null) {
      throw new NotFoundError('The requested resource');
    }
    return row;
  }

  private async requireCalendar(id: string, includeDeleted: boolean): Promise<WorkingCalendarRow> {
    const row = await this.routing.findCalendar(id, includeDeleted);
    if (row === null) {
      throw new NotFoundError('The requested resource');
    }
    return row;
  }

  private async requireLiveUsers(ids: readonly string[]): Promise<readonly string[]> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) {
      return [];
    }
    const live = await this.routing.liveUserIds(unique);
    const missing = unique.filter((id) => !live.includes(id));
    if (missing.length > 0) {
      // Named rather than silently dropped: a group that quietly lost a member is a group that
      // routes an approval to fewer people than the administrator believes it does.
      throw new ValidationError('One of those people does not work here.', [
        { field: 'memberIds', message: missing.join(', ') },
      ]);
    }
    return unique;
  }

  private async requireEntity(entityId: string | null): Promise<void> {
    if (entityId !== null && !(await this.routing.entityExists(entityId))) {
      throw new ValidationError('That entity does not exist.', [
        { field: 'entityId', message: 'unknown' },
      ]);
    }
  }

  /**
   * A week with at least one working day in it.
   *
   * A calendar whose weekend is every day is a deadline that can never be reached, and the walk
   * that computes one would step through ten years looking for a day to count. Refused here with a
   * sentence, and by a check constraint underneath.
   */
  private requireWorkingWeek(weekendDays: readonly number[]): void {
    if (new Set(weekendDays).size >= 7) {
      throw new ValidationError('A calendar needs at least one working day.', [
        { field: 'weekendDays', message: 'no working day' },
      ]);
    }
  }

  private holidaysOf(
    holidays: readonly { day: string; name: string }[],
  ): readonly { id: string; day: string; name: string }[] {
    const seen = new Set<string>();
    const rows: { id: string; day: string; name: string }[] = [];
    for (const holiday of holidays) {
      if (seen.has(holiday.day)) {
        // One day, one holiday. The database refuses the pair too; catching it here means the
        // message names the date rather than reporting a constraint.
        throw new ValidationError(`That day is listed twice: ${holiday.day}.`, [
          { field: 'holidays', message: holiday.day },
        ]);
      }
      seen.add(holiday.day);
      rows.push({
        id: this.writer.clock.nextId(),
        day: holiday.day,
        name: this.requireName(holiday.name),
      });
    }
    return rows;
  }

  private requireName(raw: string): string {
    const name = squish(raw);
    if (name.length === 0) {
      throw new ValidationError('A name is required.', [{ field: 'name', message: 'required' }]);
    }
    return name;
  }

  private requireCode(raw: string): string {
    const code = raw.trim();
    if (!isUsableCode(code)) {
      throw new ValidationError('That code cannot be used.', [
        { field: 'code', message: 'invalid' },
      ]);
    }
    return code;
  }

  private changed(
    id: string,
    operation: AdministrativeOperationKey,
    before: Readonly<Record<string, unknown>> | undefined,
    after: Readonly<Record<string, unknown>> | undefined,
  ) {
    return {
      action: AdministrationAudit.ROUTING_CHANGED,
      subjectType: AuditSubjectType.CONFIGURATION,
      subjectId: asId<AnyId>(id),
      operation,
      ...(before && { before: { ...before, resource: 'approvalGroup' } }),
      ...(after && { after: { ...after, resource: 'approvalGroup' } }),
    };
  }

  private calendarChanged(
    id: string,
    operation: AdministrativeOperationKey,
    before: Readonly<Record<string, unknown>> | undefined,
    after: Readonly<Record<string, unknown>> | undefined,
  ) {
    return {
      action: AdministrationAudit.ROUTING_CHANGED,
      subjectType: AuditSubjectType.CONFIGURATION,
      subjectId: asId<AnyId>(id),
      operation,
      ...(before && { before: { ...before, resource: 'workingCalendar' } }),
      ...(after && { after: { ...after, resource: 'workingCalendar' } }),
    };
  }
}
