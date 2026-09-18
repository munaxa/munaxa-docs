import type { ReactNode } from 'react';

import type { Collection, NumberReservation, NumberingRule } from '@edms/contracts';
import {
  ALL_NUMBER_RESERVATION_STATES,
  type NumberReservationStateKey,
  Permission,
} from '@edms/domain';

import { NumberingReservationsScreen } from '../../../../../../features/admin-configuration/numbering-reservations-screen';
import { AdminForbidden } from '../../../../../../features/admin-shared';
import { adminAccess, adminGet } from '../../../../../../lib/admin/api';

/** Derived, so a state added to the domain is one this route already accepts — Slice 105A. */
const STATES: readonly NumberReservationStateKey[] = ALL_NUMBER_RESERVATION_STATES;

/** One rule's reservations — where a gap in the series is explained, and held blocks live. */
export default async function NumberingReservationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ ruleId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const access = await adminAccess(Permission.NUMBERING_MANAGE);
  if (!access.granted) {
    return <AdminForbidden />;
  }

  const { ruleId } = await params;
  const raw = await searchParams;
  const page = Math.max(1, Number(typeof raw['page'] === 'string' ? raw['page'] : '1') || 1);
  const stateParam = typeof raw['state'] === 'string' ? raw['state'] : '';
  const state = STATES.includes(stateParam as NumberReservationStateKey)
    ? (stateParam as NumberReservationStateKey)
    : '';

  const query = new URLSearchParams({ page: String(page), pageSize: '25' });
  if (state !== '') {
    query.set('state', state);
  }
  const [rule, reservations] = await Promise.all([
    adminGet<NumberingRule>(`/admin/numbering-rules/${ruleId}`),
    adminGet<Collection<NumberReservation>>(
      `/admin/numbering-rules/${ruleId}/reservations?${query.toString()}`,
    ),
  ]);

  return (
    <NumberingReservationsScreen
      rule={rule}
      rows={reservations.data}
      total={reservations.meta.total}
      page={page}
      state={state}
    />
  );
}
