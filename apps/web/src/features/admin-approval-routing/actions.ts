'use server';

import {
  type ApprovalGroup,
  type WorkingCalendar,
  createApprovalGroupSchema,
  createWorkingCalendarSchema,
  updateApprovalGroupSchema,
  updateWorkingCalendarSchema,
} from '@edms/contracts';

import type { ActionResult } from '../../lib/admin/action-result';
import { adminWrite } from '../../lib/admin/api';
import { validated } from '../../lib/admin/validated';

/**
 * Writes to the two things the workflow engine reads and Administration had neither of.
 *
 * `GROUP` is one of the seven participant resolver kinds and there was no surface for a group;
 * deadlines are counted against a working-day calendar and there was no calendar — while
 * `WORKING_DAYS` is the default every stage deadline is authored with.
 *
 * Both are behind `workflow:manage` rather than `settings:manage`: the person who authors approval
 * workflows is the person who maintains the groups they route to and the calendar their deadlines
 * are counted against, and that is a narrower key than "can configure the tenant".
 */

export async function createApprovalGroup(input: unknown): Promise<ActionResult<ApprovalGroup>> {
  return validated(createApprovalGroupSchema, input, (body) =>
    adminWrite<ApprovalGroup>({ path: '/admin/approval-groups', method: 'POST', body }),
  );
}

export async function updateApprovalGroup(
  id: string,
  version: number,
  input: unknown,
): Promise<ActionResult<ApprovalGroup>> {
  return validated(updateApprovalGroupSchema, input, (body) =>
    adminWrite<ApprovalGroup>({
      path: `/admin/approval-groups/${id}`,
      method: 'PATCH',
      body,
      version,
    }),
  );
}

export async function deleteApprovalGroup(id: string, version: number): Promise<ActionResult> {
  return adminWrite({ path: `/admin/approval-groups/${id}`, method: 'DELETE', version });
}

export async function restoreApprovalGroup(id: string, version: number): Promise<ActionResult> {
  return adminWrite({ path: `/admin/approval-groups/${id}/restore`, method: 'POST', version });
}

export async function createWorkingCalendar(
  input: unknown,
): Promise<ActionResult<WorkingCalendar>> {
  return validated(createWorkingCalendarSchema, input, (body) =>
    adminWrite<WorkingCalendar>({ path: '/admin/working-calendars', method: 'POST', body }),
  );
}

export async function updateWorkingCalendar(
  id: string,
  version: number,
  input: unknown,
): Promise<ActionResult<WorkingCalendar>> {
  return validated(updateWorkingCalendarSchema, input, (body) =>
    adminWrite<WorkingCalendar>({
      path: `/admin/working-calendars/${id}`,
      method: 'PATCH',
      body,
      version,
    }),
  );
}

export async function deleteWorkingCalendar(id: string, version: number): Promise<ActionResult> {
  return adminWrite({ path: `/admin/working-calendars/${id}`, method: 'DELETE', version });
}

export async function restoreWorkingCalendar(id: string, version: number): Promise<ActionResult> {
  return adminWrite({ path: `/admin/working-calendars/${id}/restore`, method: 'POST', version });
}
