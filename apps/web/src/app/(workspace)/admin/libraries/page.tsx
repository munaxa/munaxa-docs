import type { ReactNode } from 'react';

import type { Company, Department, Entity, Library } from '@edms/contracts';
import { Permission, ScopeType } from '@edms/domain';

import {
  LIBRARY_FILTER_KEYS,
  LIBRARY_SORT_FIELDS,
  LibrariesScreen,
} from '../../../../features/admin-libraries/libraries-screen';
import { AdminForbidden } from '../../../../features/admin-shared';
import { adminAccess, adminList, adminOptions } from '../../../../lib/admin/api';
import { type RawSearchParams, readListState } from '../../../../lib/admin/list-state';

/**
 * Libraries, with the candidate owner nodes for each kind a library may belong to.
 *
 * Branches are absent by construction: `LIBRARY_OWNER_SCOPES` does not contain one, because permission
 * does not flow through a location.
 */
export default async function LibrariesPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}): Promise<ReactNode> {
  const access = await adminAccess(Permission.LIBRARY_MANAGE);
  if (!access.granted) {
    return <AdminForbidden />;
  }

  const state = readListState(await searchParams, LIBRARY_SORT_FIELDS, LIBRARY_FILTER_KEYS);
  const [page, companies, entities, departments] = await Promise.all([
    adminList<Library>('/admin/libraries', state),
    adminOptions<Company>('/admin/companies', 'name'),
    adminOptions<Entity>('/admin/entities', 'name'),
    adminOptions<Department>('/admin/departments', 'path'),
  ]);

  return (
    <LibrariesScreen
      rows={page.data}
      total={page.meta.total}
      state={state}
      owners={{
        [ScopeType.COMPANY]: companies.data.map((company) => ({
          value: company.id,
          label: `${company.name} (${company.code})`,
        })),
        [ScopeType.ENTITY]: entities.data.map((entity) => ({
          value: entity.id,
          label: `${entity.name} (${entity.code})`,
        })),
        [ScopeType.DEPARTMENT]: departments.data.map((department) => ({
          value: department.id,
          label: `${department.name} (${department.code})`,
        })),
      }}
    />
  );
}
