import type { ReactNode } from 'react';

import type { Company, Entity } from '@edms/contracts';
import { Permission } from '@edms/domain';

import {
  ENTITY_FILTER_KEYS,
  ENTITY_SORT_FIELDS,
  EntitiesScreen,
} from '../../../../features/admin-organization/entities-screen';
import { AdminForbidden } from '../../../../features/admin-shared';
import { adminList, adminOptions, adminAccess } from '../../../../lib/admin/api';
import { type RawSearchParams, readListState } from '../../../../lib/admin/list-state';

/**
 * The entities list, with the companies its form needs.
 *
 * Both requests are issued together rather than in sequence: the picker's options do not depend on
 * the page of entities, and awaiting them one after the other would make every navigation two round
 * trips instead of one.
 */
export default async function EntitiesPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}): Promise<ReactNode> {
  const access = await adminAccess(Permission.ORG_MANAGE);
  if (!access.granted) {
    return <AdminForbidden />;
  }

  const state = readListState(await searchParams, ENTITY_SORT_FIELDS, ENTITY_FILTER_KEYS);
  const [page, companies] = await Promise.all([
    adminList<Entity>('/admin/entities', state),
    adminOptions<Company>('/admin/companies', 'name'),
  ]);

  return (
    <EntitiesScreen
      rows={page.data}
      total={page.meta.total}
      state={state}
      companies={companies.data.map((company) => ({
        value: company.id,
        label: `${company.name} (${company.code})`,
      }))}
    />
  );
}
