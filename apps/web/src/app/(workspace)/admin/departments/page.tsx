import type { ReactNode } from 'react';

import type { Branch, Department, Entity } from '@edms/contracts';
import { Permission } from '@edms/domain';

import {
  DEPARTMENT_FILTER_KEYS,
  DEPARTMENT_SORT_FIELDS,
  DepartmentsScreen,
} from '../../../../features/admin-organization/departments-screen';
import { AdminForbidden } from '../../../../features/admin-shared';
import { adminAccess, adminList, adminOptions } from '../../../../lib/admin/api';
import { type RawSearchParams, readListState } from '../../../../lib/admin/list-state';

/**
 * The departments list.
 *
 * Ordered by path unless the reader says otherwise, because that is the only order in which a
 * nesting tree reads as one. The parent picker draws from the same path-ordered page, so the names
 * in it appear in the shape of the tree they belong to.
 */
export default async function DepartmentsPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}): Promise<ReactNode> {
  const access = await adminAccess(Permission.ORG_MANAGE);
  if (!access.granted) {
    return <AdminForbidden />;
  }

  const requested = readListState(
    await searchParams,
    DEPARTMENT_SORT_FIELDS,
    DEPARTMENT_FILTER_KEYS,
  );
  const state =
    requested.sortBy === null
      ? { ...requested, sortBy: 'path', sortDirection: 'asc' as const }
      : requested;

  const [page, entities, branches, parents] = await Promise.all([
    adminList<Department>('/admin/departments', state),
    adminOptions<Entity>('/admin/entities', 'name'),
    adminOptions<Branch>('/admin/branches', 'name'),
    adminOptions<Department>('/admin/departments', 'path'),
  ]);

  return (
    <DepartmentsScreen
      rows={page.data}
      total={page.meta.total}
      state={state}
      entities={entities.data.map((entity) => ({
        value: entity.id,
        label: `${entity.name} (${entity.code})`,
      }))}
      branches={branches.data.map((branch) => ({
        value: branch.id,
        label: `${branch.name} (${branch.code})`,
      }))}
      parents={parents.data.map((department) => ({
        value: department.id,
        // Indented by depth, so the picker shows where a candidate parent sits rather than a flat
        // list of names that could each be anywhere in the tree.
        label: `${' '.repeat((department.depth - 1) * 3)}${department.name}`,
      }))}
    />
  );
}
