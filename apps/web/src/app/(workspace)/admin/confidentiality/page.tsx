import type { ReactNode } from 'react';

import type { ConfidentialityLevel } from '@edms/contracts';
import { Permission } from '@edms/domain';

import {
  CONFIDENTIALITY_SORT_FIELDS,
  ConfidentialityScreen,
} from '../../../../features/admin-configuration/confidentiality-screen';
import { AdminForbidden } from '../../../../features/admin-shared';
import { adminAccess, adminList } from '../../../../lib/admin/api';
import { type RawSearchParams, readListState } from '../../../../lib/admin/list-state';

/** Confidentiality levels, ordered by rank unless the reader asks otherwise. */
export default async function ConfidentialityPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}): Promise<ReactNode> {
  const access = await adminAccess(Permission.SETTINGS_MANAGE);
  if (!access.granted) {
    return <AdminForbidden />;
  }

  const requested = readListState(await searchParams, CONFIDENTIALITY_SORT_FIELDS);
  const state =
    requested.sortBy === null
      ? { ...requested, sortBy: 'rank', sortDirection: 'asc' as const }
      : requested;
  const page = await adminList<ConfidentialityLevel>('/admin/confidentiality-levels', state);

  return <ConfidentialityScreen rows={page.data} total={page.meta.total} state={state} />;
}
