import type { ReactNode } from 'react';

import type { NumberingRule } from '@edms/contracts';
import { Permission } from '@edms/domain';

import {
  NUMBERING_SORT_FIELDS,
  NumberingScreen,
} from '../../../../features/admin-configuration/numbering-screen';
import { AdminForbidden } from '../../../../features/admin-shared';
import { adminAccess, adminList } from '../../../../lib/admin/api';
import { type RawSearchParams, readListState } from '../../../../lib/admin/list-state';

/** Numbering rules. */
export default async function NumberingPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}): Promise<ReactNode> {
  const access = await adminAccess(Permission.NUMBERING_MANAGE);
  if (!access.granted) {
    return <AdminForbidden />;
  }

  const state = readListState(await searchParams, NUMBERING_SORT_FIELDS);
  const page = await adminList<NumberingRule>('/admin/numbering-rules', state);

  return <NumberingScreen rows={page.data} total={page.meta.total} state={state} />;
}
