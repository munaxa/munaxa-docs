import type { ReactNode } from 'react';

import type { Category } from '@edms/contracts';
import { Permission } from '@edms/domain';

import { CategoriesScreen } from '../../../../features/admin-configuration/categories-screen';
import { AdminForbidden } from '../../../../features/admin-shared';
import { adminAccess, adminList, adminOptions } from '../../../../lib/admin/api';
import { type RawSearchParams, readListState } from '../../../../lib/admin/list-state';
import { CATEGORY_SORT_FIELDS } from '../../../../lib/admin/list-keys';

/** Categories, ordered by path so the nesting reads as a tree. */
export default async function CategoriesPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}): Promise<ReactNode> {
  const access = await adminAccess(Permission.SETTINGS_MANAGE);
  if (!access.granted) {
    return <AdminForbidden />;
  }

  const requested = readListState(await searchParams, CATEGORY_SORT_FIELDS);
  const state =
    requested.sortBy === null
      ? { ...requested, sortBy: 'path', sortDirection: 'asc' as const }
      : requested;

  const [page, parents] = await Promise.all([
    adminList<Category>('/admin/categories', state),
    adminOptions<Category>('/admin/categories', 'path'),
  ]);

  return (
    <CategoriesScreen
      rows={page.data}
      total={page.meta.total}
      state={state}
      parents={parents.data.map((category) => ({
        value: category.id,
        label: `${' '.repeat((category.depth - 1) * 3)}${category.name}`,
      }))}
    />
  );
}
