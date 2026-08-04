import type { DeletedFilter, SortDirection } from '@edms/contracts';
import type { Page, PageRequest } from '@edms/utils';

/**
 * Approval groups and working calendars — the two pieces of configuration the engine reads.
 *
 * Both were named by `07-workflow-architecture.md` and neither existed before Phase 4. `GROUP` is
 * one of the seven participant resolver kinds (§2) and there was no surface for a group; deadlines
 * are counted against "a working-day calendar owned by Administration" (§6) and there was no
 * calendar — while `WORKING_DAYS` is the *default* every stage deadline is authored with.
 *
 * They are Administration's rather than Workflow's for the reason everything else in this module is:
 * they are tenant configuration with their own lifetime. A group outlives the definitions that name
 * it, and a calendar is read by anything that has a deadline — which by Phase 9 is more than
 * approvals.
 *
 * A separate repository from `CONFIGURATION_REPOSITORY` rather than more methods on it, because
 * nothing joins them: a document type references four configuration aggregates and every delete has
 * to ask the same question of the same tables, which is what made those six worth one interface.
 * These two share no reference with any of them.
 */

export const APPROVAL_ROUTING_SERVICE = Symbol('ApprovalRoutingService');
export const APPROVAL_ROUTING_REPOSITORY = Symbol('ApprovalRoutingRepository');

interface Stamped {
  readonly id: string;
  readonly createdAt: Date;
  readonly createdBy: string | null;
  readonly updatedAt: Date;
  readonly updatedBy: string | null;
  readonly deletedAt: Date | null;
  readonly deletedBy: string | null;
  readonly version: number;
}

export interface ApprovalGroupMemberRow {
  readonly userId: string;
  readonly displayName: string;
  readonly email: string;
}

export interface ApprovalGroupRow extends Stamped {
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  readonly isActive: boolean;
  readonly members: readonly ApprovalGroupMemberRow[];
  /** Published versions naming this group. Non-zero is what makes a delete a deactivation. */
  readonly usedByWorkflowCount: number;
}

export interface WorkingCalendarHolidayRow {
  readonly id: string;
  readonly day: string;
  readonly name: string;
}

export interface WorkingCalendarRow extends Stamped {
  readonly code: string;
  readonly name: string;
  readonly entityId: string | null;
  readonly entityName: string | null;
  readonly weekendDays: readonly number[];
  readonly isDefault: boolean;
  readonly isActive: boolean;
  readonly holidays: readonly WorkingCalendarHolidayRow[];
}

export interface RoutingListRequest extends PageRequest {
  readonly search?: string | undefined;
  readonly sortBy?: string | undefined;
  readonly sortDirection: SortDirection;
  readonly deleted: DeletedFilter;
  readonly isActive?: boolean | undefined;
}

export interface CalendarListRequest extends RoutingListRequest {
  readonly entityId?: string | undefined;
}

export interface ApprovalRoutingRepository {
  // --- Groups ---
  listGroups(request: RoutingListRequest): Promise<Page<ApprovalGroupRow>>;
  findGroup(id: string, includeDeleted: boolean): Promise<ApprovalGroupRow | null>;
  /** Live rows only: a key freed by a soft delete is available again. */
  groupKeyTaken(key: string, exceptId: string | null): Promise<boolean>;
  insertGroup(input: {
    readonly id: string;
    readonly key: string;
    readonly name: string;
    readonly description: string | null;
  }): Promise<void>;
  updateGroup(
    id: string,
    version: number,
    patch: {
      readonly name?: string;
      readonly description?: string | null;
      readonly isActive?: boolean;
    },
  ): Promise<void>;
  /** Replaces the whole set — a diff computed elsewhere is a second place membership is decided. */
  replaceGroupMembers(groupId: string, userIds: readonly string[]): Promise<void>;
  setGroupDeleted(id: string, version: number, deleted: boolean): Promise<void>;
  /** The engine's only read: who is in this group, by key, right now. */
  activeGroupMembers(key: string): Promise<readonly string[]>;

  // --- Calendars ---
  listCalendars(request: CalendarListRequest): Promise<Page<WorkingCalendarRow>>;
  findCalendar(id: string, includeDeleted: boolean): Promise<WorkingCalendarRow | null>;
  calendarCodeTaken(code: string, exceptId: string | null): Promise<boolean>;
  /**
   * The calendar an entity's deadlines are counted against.
   *
   * The entity's own if it has one, otherwise the tenant's default, otherwise none — at which point
   * the engine falls back to the product's own week rather than failing a submission over a
   * calendar nobody has configured.
   */
  calendarForEntity(entityId: string | null): Promise<WorkingCalendarRow | null>;
  insertCalendar(input: {
    readonly id: string;
    readonly code: string;
    readonly name: string;
    readonly entityId: string | null;
    readonly weekendDays: readonly number[];
    readonly isDefault: boolean;
  }): Promise<void>;
  updateCalendar(
    id: string,
    version: number,
    patch: {
      readonly name?: string;
      readonly entityId?: string | null;
      readonly weekendDays?: readonly number[];
      readonly isDefault?: boolean;
      readonly isActive?: boolean;
    },
  ): Promise<void>;
  /** Clears every other default in the tenant. One default, or the arithmetic has no answer. */
  clearDefaultExcept(id: string): Promise<void>;
  replaceHolidays(
    calendarId: string,
    holidays: readonly { readonly id: string; readonly day: string; readonly name: string }[],
  ): Promise<void>;
  setCalendarDeleted(id: string, version: number, deleted: boolean): Promise<void>;
  entityExists(id: string): Promise<boolean>;
  liveUserIds(ids: readonly string[]): Promise<readonly string[]>;
}
