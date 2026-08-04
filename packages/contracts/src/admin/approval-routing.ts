import { z } from 'zod';

import { isoDateTimeSchema, uuidSchema } from '../common/identifiers';
import { adminListQuerySchema } from '../common/query';
import {
  administered,
  codeSchema,
  configurationKeySchema,
  descriptionSchema,
  nameSchema,
} from './record';

/**
 * The two pieces of configuration the engine cannot run without, and which Administration did not
 * have.
 *
 * Both were named by `07-workflow-architecture.md` and neither existed. `GROUP` is one of the seven
 * participant resolver kinds (§2) and there was no surface for an approval group; deadlines are
 * counted against "a working-day calendar owned by Administration" (§6) and there was no calendar,
 * while `WORKING_DAYS` is the *default* every stage deadline is authored with.
 *
 * Phase 4 built both rather than deferring them, and the reasoning is the same in each case: a
 * resolver that cannot resolve fails a submission loudly, and a calendar that does not exist makes
 * every deadline silently count Saturdays. A seam is the right answer when the missing thing would
 * be *absent*; these would have been *wrong*.
 *
 * They are administration contracts rather than workflow ones because they are tenant configuration
 * with their own lifetime: a group outlives the definitions that name it, and a calendar is read by
 * anything with a deadline, which by Phase 9 is more than approvals.
 */

// --- Approval groups --------------------------------------------------------------------------

export const approvalGroupMemberSchema = z.object({
  userId: uuidSchema,
  displayName: z.string(),
  email: z.string(),
});

export const approvalGroupSchema = administered({
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  isActive: z.boolean(),
  members: z.array(approvalGroupMemberSchema),
  /** Published definitions naming this group. Non-zero is what makes a delete a deactivation. */
  usedByWorkflowCount: z.number().int().min(0),
});

export const createApprovalGroupSchema = z.object({
  key: configurationKeySchema,
  name: nameSchema,
  description: descriptionSchema.optional(),
  /**
   * The members, as a whole set.
   *
   * Replaced rather than patched, for the reason every membership in this product is: a diff
   * computed client-side is a second place uniqueness is decided, and two administrators editing
   * the same group would each apply their own diff to a list neither of them saw.
   */
  memberIds: z.array(uuidSchema).max(200).default([]),
});

export const updateApprovalGroupSchema = z
  .object({
    name: nameSchema,
    description: descriptionSchema.nullable(),
    isActive: z.boolean(),
    memberIds: z.array(uuidSchema).max(200),
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, 'Name at least one field to change.');

export const approvalGroupListQuerySchema = adminListQuerySchema([
  'createdAt',
  'updatedAt',
  'name',
  'key',
]).extend({
  isActive: z.enum(['true', 'false']).optional(),
});

// --- Working calendars ------------------------------------------------------------------------

/**
 * A day nobody works, as a calendar date.
 *
 * `YYYY-MM-DD` rather than a timestamp, because a public holiday is a day where the office is and
 * not an interval of UTC. Storing an instant would put Christmas on the 24th for half the world.
 */
export const calendarDaySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'A holiday is a calendar date, as YYYY-MM-DD.')
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), 'That is not a real date.');

export const workingCalendarHolidaySchema = z.object({
  day: calendarDaySchema,
  name: nameSchema,
});

/**
 * The days of the week that are not worked, as ISO-8601 weekday numbers.
 *
 * A list rather than a pair of booleans, because a Friday–Saturday weekend is as ordinary as a
 * Saturday–Sunday one and a four-day week is a real arrangement. Bounded at six, because a week
 * with no working day is a deadline that can never be reached — the database refuses it too.
 */
export const weekendDaysSchema = z
  .array(z.number().int().min(1).max(7))
  .max(6)
  .transform((days) => [...new Set(days)].sort((left, right) => left - right));

export const workingCalendarSchema = administered({
  code: z.string(),
  name: z.string(),
  /** Null for the tenant-wide calendar; set for one belonging to a single legal entity. */
  entityId: uuidSchema.nullable(),
  entityName: z.string().nullable(),
  weekendDays: z.array(z.number().int().min(1).max(7)),
  isDefault: z.boolean(),
  isActive: z.boolean(),
  holidays: z.array(workingCalendarHolidaySchema.extend({ id: uuidSchema })),
  /** The zone its days are bounded by. The tenant's, from settings — not a per-calendar field. */
  timeZone: z.string(),
});

export const createWorkingCalendarSchema = z.object({
  code: codeSchema,
  name: nameSchema,
  entityId: uuidSchema.nullable().default(null),
  weekendDays: weekendDaysSchema.default([6, 7]),
  /** The tenant's fallback. Setting a second one moves it; a tenant with two has none. */
  isDefault: z.boolean().default(false),
  holidays: z.array(workingCalendarHolidaySchema).max(400).default([]),
});

export const updateWorkingCalendarSchema = z
  .object({
    name: nameSchema,
    entityId: uuidSchema.nullable(),
    weekendDays: weekendDaysSchema,
    isDefault: z.boolean(),
    isActive: z.boolean(),
    holidays: z.array(workingCalendarHolidaySchema).max(400),
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, 'Name at least one field to change.');

export const workingCalendarListQuerySchema = adminListQuerySchema([
  'createdAt',
  'updatedAt',
  'name',
  'code',
]).extend({
  entityId: uuidSchema.optional(),
  isActive: z.enum(['true', 'false']).optional(),
});

/**
 * What a deadline would be, asked before anybody commits to one.
 *
 * Its own read because the arithmetic is not obvious to a person authoring a workflow: "P3D on a
 * Thursday" is the following Tuesday, and a screen that cannot say so leaves an administrator to
 * work it out from a weekend pattern and a holiday list.
 */
export const deadlinePreviewQuerySchema = z.object({
  duration: z.string().min(2).max(16),
  from: isoDateTimeSchema.optional(),
  calendarId: uuidSchema.optional(),
});

export const deadlinePreviewSchema = z.object({
  from: isoDateTimeSchema,
  dueAt: isoDateTimeSchema,
  calendarCode: z.string(),
  /** How many days the walk stepped over. What makes the answer explicable rather than magic. */
  skippedDays: z.number().int().min(0),
});

export type ApprovalGroup = z.infer<typeof approvalGroupSchema>;
export type CreateApprovalGroupBody = z.infer<typeof createApprovalGroupSchema>;
export type UpdateApprovalGroupBody = z.infer<typeof updateApprovalGroupSchema>;
export type ApprovalGroupListQuery = z.infer<typeof approvalGroupListQuerySchema>;
export type WorkingCalendar = z.infer<typeof workingCalendarSchema>;
export type WorkingCalendarHoliday = z.infer<typeof workingCalendarHolidaySchema>;
export type CreateWorkingCalendarBody = z.infer<typeof createWorkingCalendarSchema>;
export type UpdateWorkingCalendarBody = z.infer<typeof updateWorkingCalendarSchema>;
export type WorkingCalendarListQuery = z.infer<typeof workingCalendarListQuerySchema>;
export type DeadlinePreviewQuery = z.infer<typeof deadlinePreviewQuerySchema>;
export type DeadlinePreview = z.infer<typeof deadlinePreviewSchema>;
