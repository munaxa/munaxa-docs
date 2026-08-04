import type { ReactNode } from 'react';

import type { Branch, Entity } from '@edms/contracts';
import { Permission } from '@edms/domain';

import {
  BRANCH_FILTER_KEYS,
  BRANCH_SORT_FIELDS,
  BranchesScreen,
} from '../../../../features/admin-organization/branches-screen';
import { AdminForbidden } from '../../../../features/admin-shared';
import { adminAccess, adminList, adminOptions } from '../../../../lib/admin/api';
import { type RawSearchParams, readListState } from '../../../../lib/admin/list-state';

/** The branches list, with the entities its form and its filter need. */
export default async function BranchesPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}): Promise<ReactNode> {
  const access = await adminAccess(Permission.ORG_MANAGE);
  if (!access.granted) {
    return <AdminForbidden />;
  }

  const state = readListState(await searchParams, BRANCH_SORT_FIELDS, BRANCH_FILTER_KEYS);
  const [page, entities] = await Promise.all([
    adminList<Branch>('/admin/branches', state),
    adminOptions<Entity>('/admin/entities', 'name'),
  ]);

  return (
    <BranchesScreen
      rows={page.data}
      total={page.meta.total}
      state={state}
      entities={entities.data.map((entity) => ({
        value: entity.id,
        label: `${entity.name} (${entity.code})`,
      }))}
    />
  );
}
