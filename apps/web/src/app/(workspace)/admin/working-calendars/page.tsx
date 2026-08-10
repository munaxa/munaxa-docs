import type { ReactNode } from 'react';

import type { Entity, WorkingCalendar } from '@edms/contracts';
import { Permission } from '@edms/domain';

import { AdminForbidden } from '../../../../features/admin-shared';
import { WorkingCalendarsScreen } from '../../../../features/admin-approval-routing/working-calendars-screen';
import { adminAccess, adminList, adminOptions } from '../../../../lib/admin/api';
import { type RawSearchParams, readListState } from '../../../../lib/admin/list-state';
import { CALENDAR_FILTER_KEYS, CALENDAR_SORT_FIELDS } from '../../../../lib/admin/list-keys';

/**
 * Working calendars.
 *
 * The entities are fetched so a calendar can be attached to one. A group with offices in two
 * countries genuinely has two working weeks, and the calendar an entity has no calendar of its own
 * falls back to is the tenant's default — which is why exactly one is marked as such.
 */
export default async function WorkingCalendarsPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}): Promise<ReactNode> {
  const access = await adminAccess(Permission.WORKFLOW_MANAGE);
  if (!access.granted) {
    return <AdminForbidden />;
  }

  const state = readListState(await searchParams, CALENDAR_SORT_FIELDS, CALENDAR_FILTER_KEYS);
  const [page, entities] = await Promise.all([
    adminList<WorkingCalendar>('/admin/working-calendars', state),
    adminOptions<Entity>('/admin/entities', 'name'),
  ]);

  return (
    <WorkingCalendarsScreen
      rows={page.data}
      total={page.meta.total}
      state={state}
      entities={entities.data.map((entity) => ({ value: entity.id, label: entity.name }))}
    />
  );
}
