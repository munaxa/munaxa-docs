import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { UserStatus, WorkflowVersionState } from '@edms/domain';
import { type Page, toPage } from '@edms/utils';

import { VersionConflictError } from '../../../core/errors/application-errors';
import {
  RecordStamps,
  deletedCondition,
  orderByFor,
  pageArgs,
  searchConditions,
} from '../../../core/persistence';
import { requireTransaction } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';
import type {
  ApprovalGroupRow,
  ApprovalRoutingRepository,
  CalendarListRequest,
  RoutingListRequest,
  WorkingCalendarRow,
} from '../application/approval-routing.ports';

/**
 * Approval groups and working calendars, in the database.
 *
 * Two things here are worth reading rather than skimming.
 *
 * **"Which workflows route to this group" is a `jsonb` containment query.** A workflow version's
 * stages are stored as validated `jsonb` rather than normalised into rows — [07 §7] says the future
 * graphical designer is a UI over the same JSON, and a stage table would make that a migration
 * rather than a screen. So the count that stops a group in use from being deleted asks PostgreSQL
 * whether any published version's document contains a participant naming this key. It is a
 * `jsonb_path_exists` rather than a `LIKE` over the serialised text: a key that happens to appear
 * inside a stage *name* is not a stage that routes to it.
 *
 * **A holiday is a `date`, and it is read back as one.** Prisma maps `@db.Date` to a `Date` at UTC
 * midnight, so rendering it with anything that applies a local offset moves half of them to the
 * previous day. Every read here formats from the UTC parts.
 */
@Injectable()
export class PrismaApprovalRoutingRepository implements ApprovalRoutingRepository {
  constructor(private readonly stamps: RecordStamps) {}

  // --- Groups -------------------------------------------------------------------------------

  async listGroups(request: RoutingListRequest): Promise<Page<ApprovalGroupRow>> {
    const tx = requireTransaction();
    const where: Prisma.ApprovalGroupWhereInput = {
      tenantId: this.tenantId(),
      deletedAt: deletedCondition(request.deleted),
      ...(request.isActive !== undefined && { isActive: request.isActive }),
      OR: searchConditions(request.search, ['name', 'key', 'description']),
    };
    const [rows, total] = await Promise.all([
      tx.approvalGroup.findMany({
        where,
        include: GROUP_INCLUDE,
        orderBy: orderByFor(request.sortBy as never, request.sortDirection, 'name' as never),
        ...pageArgs(request),
      }),
      tx.approvalGroup.count({ where }),
    ]);
    const usage = await this.groupUsage(rows.map((row) => row.key));
    return toPage(
      rows.map((row) => toGroup(row, usage.get(row.key) ?? 0)),
      total,
      request,
    );
  }

  async findGroup(id: string, includeDeleted: boolean): Promise<ApprovalGroupRow | null> {
    const row = await requireTransaction().approvalGroup.findFirst({
      where: { id, tenantId: this.tenantId(), ...(includeDeleted ? {} : { deletedAt: null }) },
      include: GROUP_INCLUDE,
    });
    if (row === null) {
      return null;
    }
    const usage = await this.groupUsage([row.key]);
    return toGroup(row, usage.get(row.key) ?? 0);
  }

  async groupKeyTaken(key: string, exceptId: string | null): Promise<boolean> {
    const found = await requireTransaction().approvalGroup.findFirst({
      where: {
        tenantId: this.tenantId(),
        deletedAt: null,
        key: { equals: key, mode: 'insensitive' },
        ...(exceptId === null ? {} : { id: { not: exceptId } }),
      },
      select: { id: true },
    });
    return found !== null;
  }

  async insertGroup(input: {
    readonly id: string;
    readonly key: string;
    readonly name: string;
    readonly description: string | null;
  }): Promise<void> {
    await requireTransaction().approvalGroup.create({
      data: { ...input, tenantId: this.tenantId(), ...this.stamps.creation() },
    });
  }

  async updateGroup(
    id: string,
    version: number,
    patch: { name?: string; description?: string | null; isActive?: boolean },
  ): Promise<void> {
    const { count } = await requireTransaction().approvalGroup.updateMany({
      where: { id, tenantId: this.tenantId(), version },
      data: { ...patch, ...this.stamps.update(), version: version + 1 },
    });
    if (count === 0) {
      throw new VersionConflictError(version, version);
    }
  }

  async replaceGroupMembers(groupId: string, userIds: readonly string[]): Promise<void> {
    const tx = requireTransaction();
    const tenantId = this.tenantId();
    await tx.approvalGroupMember.deleteMany({ where: { tenantId, groupId } });
    if (userIds.length === 0) {
      return;
    }
    await tx.approvalGroupMember.createMany({
      data: userIds.map((userId) => ({
        tenantId,
        groupId,
        userId,
        assignedAt: this.stamps.now(),
        assignedBy: requireContext().userId,
      })),
    });
  }

  async setGroupDeleted(id: string, version: number, deleted: boolean): Promise<void> {
    const { count } = await requireTransaction().approvalGroup.updateMany({
      where: { id, tenantId: this.tenantId(), version },
      data: {
        ...(deleted ? this.stamps.deletion() : this.stamps.restoration()),
        version: version + 1,
      },
    });
    if (count === 0) {
      throw new VersionConflictError(version, version);
    }
  }

  /**
   * Who is in a group, right now, filtered to people who can actually sign in.
   *
   * Read by the engine at stage activation and never cached. An inactive group resolves to nobody
   * rather than to its members: deactivating a group is how an administrator stops it routing, and
   * a resolver that ignored the flag would make that switch do nothing.
   */
  async activeGroupMembers(key: string): Promise<readonly string[]> {
    const rows = await requireTransaction().approvalGroupMember.findMany({
      where: {
        tenantId: this.tenantId(),
        group: {
          key: { equals: key, mode: 'insensitive' },
          isActive: true,
          deletedAt: null,
          tenantId: this.tenantId(),
        },
        user: { deletedAt: null, status: UserStatus.ACTIVE },
      },
      select: { userId: true },
      orderBy: { user: { displayName: 'asc' } },
    });
    return rows.map((row) => row.userId);
  }

  // --- Calendars ----------------------------------------------------------------------------

  async listCalendars(request: CalendarListRequest): Promise<Page<WorkingCalendarRow>> {
    const tx = requireTransaction();
    const where: Prisma.WorkingCalendarWhereInput = {
      tenantId: this.tenantId(),
      deletedAt: deletedCondition(request.deleted),
      ...(request.isActive !== undefined && { isActive: request.isActive }),
      ...(request.entityId !== undefined && { entityId: request.entityId }),
      OR: searchConditions(request.search, ['name', 'code']),
    };
    const [rows, total] = await Promise.all([
      tx.workingCalendar.findMany({
        where,
        include: CALENDAR_INCLUDE,
        orderBy: orderByFor(request.sortBy as never, request.sortDirection, 'name' as never),
        ...pageArgs(request),
      }),
      tx.workingCalendar.count({ where }),
    ]);
    return toPage(rows.map(toCalendar), total, request);
  }

  async findCalendar(id: string, includeDeleted: boolean): Promise<WorkingCalendarRow | null> {
    const row = await requireTransaction().workingCalendar.findFirst({
      where: { id, tenantId: this.tenantId(), ...(includeDeleted ? {} : { deletedAt: null }) },
      include: CALENDAR_INCLUDE,
    });
    return row === null ? null : toCalendar(row);
  }

  async calendarCodeTaken(code: string, exceptId: string | null): Promise<boolean> {
    const found = await requireTransaction().workingCalendar.findFirst({
      where: {
        tenantId: this.tenantId(),
        deletedAt: null,
        code: { equals: code, mode: 'insensitive' },
        ...(exceptId === null ? {} : { id: { not: exceptId } }),
      },
      select: { id: true },
    });
    return found !== null;
  }

  /**
   * The calendar an entity counts deadlines against: its own, or the tenant's default.
   *
   * Two queries rather than one `OR` ordered by a computed preference, because the fallback is the
   * interesting half: an entity with no calendar of its own has to get the default, and an `OR`
   * would return whichever row the planner reached first.
   */
  async calendarForEntity(entityId: string | null): Promise<WorkingCalendarRow | null> {
    const tx = requireTransaction();
    if (entityId !== null) {
      const own = await tx.workingCalendar.findFirst({
        where: { tenantId: this.tenantId(), entityId, deletedAt: null, isActive: true },
        include: CALENDAR_INCLUDE,
      });
      if (own !== null) {
        return toCalendar(own);
      }
    }
    const fallback = await tx.workingCalendar.findFirst({
      where: { tenantId: this.tenantId(), isDefault: true, deletedAt: null, isActive: true },
      include: CALENDAR_INCLUDE,
    });
    return fallback === null ? null : toCalendar(fallback);
  }

  async insertCalendar(input: {
    readonly id: string;
    readonly code: string;
    readonly name: string;
    readonly entityId: string | null;
    readonly weekendDays: readonly number[];
    readonly isDefault: boolean;
  }): Promise<void> {
    await requireTransaction().workingCalendar.create({
      data: {
        id: input.id,
        tenantId: this.tenantId(),
        code: input.code,
        name: input.name,
        entityId: input.entityId,
        weekendDays: [...input.weekendDays],
        isDefault: input.isDefault,
        ...this.stamps.creation(),
      },
    });
  }

  async updateCalendar(
    id: string,
    version: number,
    patch: {
      name?: string;
      entityId?: string | null;
      weekendDays?: readonly number[];
      isDefault?: boolean;
      isActive?: boolean;
    },
  ): Promise<void> {
    const { count } = await requireTransaction().workingCalendar.updateMany({
      where: { id, tenantId: this.tenantId(), version },
      data: {
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.entityId !== undefined && { entityId: patch.entityId }),
        ...(patch.weekendDays !== undefined && { weekendDays: [...patch.weekendDays] }),
        ...(patch.isDefault !== undefined && { isDefault: patch.isDefault }),
        ...(patch.isActive !== undefined && { isActive: patch.isActive }),
        ...this.stamps.update(),
        version: version + 1,
      },
    });
    if (count === 0) {
      throw new VersionConflictError(version, version);
    }
  }

  async clearDefaultExcept(id: string): Promise<void> {
    await requireTransaction().workingCalendar.updateMany({
      where: { tenantId: this.tenantId(), isDefault: true, id: { not: id }, deletedAt: null },
      data: { isDefault: false, ...this.stamps.update() },
    });
  }

  async replaceHolidays(
    calendarId: string,
    holidays: readonly { readonly id: string; readonly day: string; readonly name: string }[],
  ): Promise<void> {
    const tx = requireTransaction();
    await tx.workingCalendarHoliday.deleteMany({
      where: { calendarId, tenantId: this.tenantId() },
    });
    if (holidays.length === 0) {
      return;
    }
    await tx.workingCalendarHoliday.createMany({
      data: holidays.map((holiday) => ({
        id: holiday.id,
        tenantId: this.tenantId(),
        calendarId,
        // Parsed as UTC midnight, which is what a `date` column stores and what every read here
        // formats back from. A local parse would move half the year's holidays by a day.
        day: new Date(`${holiday.day}T00:00:00.000Z`),
        name: holiday.name,
      })),
    });
  }

  async setCalendarDeleted(id: string, version: number, deleted: boolean): Promise<void> {
    const { count } = await requireTransaction().workingCalendar.updateMany({
      where: { id, tenantId: this.tenantId(), version },
      data: {
        ...(deleted ? this.stamps.deletion() : this.stamps.restoration()),
        version: version + 1,
      },
    });
    if (count === 0) {
      throw new VersionConflictError(version, version);
    }
  }

  async entityExists(id: string): Promise<boolean> {
    const found = await requireTransaction().entity.findFirst({
      where: { id, tenantId: this.tenantId(), deletedAt: null },
      select: { id: true },
    });
    return found !== null;
  }

  async liveUserIds(ids: readonly string[]): Promise<readonly string[]> {
    if (ids.length === 0) {
      return [];
    }
    const rows = await requireTransaction().user.findMany({
      where: { id: { in: [...ids] }, tenantId: this.tenantId(), deletedAt: null },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  /**
   * How many published workflow versions route to each of these group keys.
   *
   * `jsonb_path_exists` rather than a text match, because a group key appearing inside a stage
   * *name* is not a stage that routes to it — and the delete this count guards is the one thing
   * standing between a published, immutable definition and a resolver pointing at nothing.
   */
  private async groupUsage(keys: readonly string[]): Promise<ReadonlyMap<string, number>> {
    if (keys.length === 0) {
      return new Map();
    }
    const rows = await requireTransaction().$queryRaw<{ key: string; uses: bigint }[]>`
      SELECT k.key AS key, count(v.id) AS uses
      FROM unnest(${[...keys]}::text[]) AS k(key)
      LEFT JOIN workflow_version v
        ON v.tenant_id = ${this.tenantId()}::uuid
       AND v.state <> ${WorkflowVersionState.DRAFT}::workflow_version_state
       AND jsonb_path_exists(
             v.definition,
             '$.stages[*].participants[*] ? (@.kind == "GROUP" && @.groupKey == $wanted)',
             jsonb_build_object('wanted', k.key)
           )
      GROUP BY k.key`;
    return new Map(rows.map((row) => [row.key, Number(row.uses)]));
  }

  private tenantId(): string {
    return requireContext().tenantId;
  }
}

const GROUP_INCLUDE = {
  members: {
    select: { userId: true, user: { select: { displayName: true, email: true } } },
    orderBy: { user: { displayName: 'asc' } },
  },
} as const satisfies Prisma.ApprovalGroupInclude;

const CALENDAR_INCLUDE = {
  entity: { select: { name: true } },
  holidays: { orderBy: { day: 'asc' } },
} as const satisfies Prisma.WorkingCalendarInclude;

function toGroup(
  row: Prisma.ApprovalGroupGetPayload<{ include: typeof GROUP_INCLUDE }>,
  usedByWorkflowCount: number,
): ApprovalGroupRow {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    isActive: row.isActive,
    members: row.members.map((member) => ({
      userId: member.userId,
      displayName: member.user.displayName,
      email: member.user.email,
    })),
    usedByWorkflowCount,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
    deletedAt: row.deletedAt,
    deletedBy: row.deletedBy,
    version: row.version,
  };
}

function toCalendar(
  row: Prisma.WorkingCalendarGetPayload<{ include: typeof CALENDAR_INCLUDE }>,
): WorkingCalendarRow {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    entityId: row.entityId,
    entityName: row.entity?.name ?? null,
    weekendDays: row.weekendDays,
    isDefault: row.isDefault,
    isActive: row.isActive,
    holidays: row.holidays.map((holiday) => ({
      id: holiday.id,
      day: holiday.day.toISOString().slice(0, 10),
      name: holiday.name,
    })),
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
    deletedAt: row.deletedAt,
    deletedBy: row.deletedBy,
    version: row.version,
  };
}
