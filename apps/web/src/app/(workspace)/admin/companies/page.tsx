import type { ReactNode } from 'react';

import type { Company } from '@edms/contracts';
import { Permission } from '@edms/domain';

import { AdminForbidden } from '../../../../features/admin-shared';
import { CompaniesScreen } from '../../../../features/admin-organization/companies-screen';
import { adminAccess, adminList } from '../../../../lib/admin/api';
import { readListState } from '../../../../lib/admin/list-state';
import type { RawSearchParams } from '../../../../lib/admin/list-state';
import { COMPANY_SORT_FIELDS } from '../../../../lib/admin/list-keys';

/**
 * The companies list.
 *
 * The page fetches; the screen renders. That split is what makes the URL the source of truth for
 * which rows are shown: the first paint is already the right page, rather than an empty grid that
 * fills in once a browser-side query resolves.
 */
export default async function CompaniesPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}): Promise<ReactNode> {
  const access = await adminAccess(Permission.ORG_MANAGE);
  if (!access.granted) {
    return <AdminForbidden />;
  }

  const state = readListState(await searchParams, COMPANY_SORT_FIELDS);
  const page = await adminList<Company>('/admin/companies', state);

  return <CompaniesScreen rows={page.data} total={page.meta.total} state={state} />;
}
