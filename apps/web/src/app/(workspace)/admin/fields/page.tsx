import type { ReactNode } from 'react';

import type { MetadataField } from '@edms/contracts';
import { Permission } from '@edms/domain';

import { FieldsScreen } from '../../../../features/admin-configuration/fields-screen';
import { AdminForbidden } from '../../../../features/admin-shared';
import { adminAccess, adminList } from '../../../../lib/admin/api';
import { type RawSearchParams, readListState } from '../../../../lib/admin/list-state';
import { FIELD_FILTER_KEYS, FIELD_SORT_FIELDS } from '../../../../lib/admin/list-keys';

/** The tenant-defined metadata fields. */
export default async function FieldsPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}): Promise<ReactNode> {
  const access = await adminAccess(Permission.SETTINGS_MANAGE);
  if (!access.granted) {
    return <AdminForbidden />;
  }

  const state = readListState(await searchParams, FIELD_SORT_FIELDS, FIELD_FILTER_KEYS);
  const page = await adminList<MetadataField>('/admin/fields', state);

  return <FieldsScreen rows={page.data} total={page.meta.total} state={state} />;
}
