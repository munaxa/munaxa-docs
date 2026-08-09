import type { ReactNode } from 'react';

import type { RetentionPolicy } from '@edms/contracts';
import { Permission } from '@edms/domain';

import { RetentionScreen } from '../../../../features/admin-configuration/retention-screen';
import { AdminForbidden } from '../../../../features/admin-shared';
import { adminAccess, adminList } from '../../../../lib/admin/api';
import { type RawSearchParams, readListState } from '../../../../lib/admin/list-state';
import { RETENTION_FILTER_KEYS, RETENTION_SORT_FIELDS } from '../../../../lib/admin/list-keys';

/** Retention policies. */
export default async function RetentionPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}): Promise<ReactNode> {
  const access = await adminAccess(Permission.RETENTION_MANAGE);
  if (!access.granted) {
    return <AdminForbidden />;
  }

  const state = readListState(await searchParams, RETENTION_SORT_FIELDS, RETENTION_FILTER_KEYS);
  const page = await adminList<RetentionPolicy>('/admin/retention-policies', state);

  return <RetentionScreen rows={page.data} total={page.meta.total} state={state} />;
}
