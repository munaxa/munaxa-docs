import type { ReactNode } from 'react';

import type { ApiClient, User } from '@edms/contracts';
import { Permission } from '@edms/domain';

import { AdminForbidden } from '../../../../features/admin-shared';
import {
  API_CLIENT_SORT_FIELDS,
  ApiClientsScreen,
} from '../../../../features/admin-integration/api-clients-screen';
import { adminAccess, adminList } from '../../../../lib/admin/api';
import { type RawSearchParams, readListState } from '../../../../lib/admin/list-state';

/**
 * API clients, with the people a key may be bound to.
 *
 * The directory is fetched here rather than looked up per row, because a key's *subject* is the
 * whole of what it can reach and a list showing raw identifiers would make the most important
 * column the least readable one.
 */
export default async function ApiClientsPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}): Promise<ReactNode> {
  const access = await adminAccess(Permission.INTEGRATION_MANAGE);
  if (!access.granted) {
    return <AdminForbidden />;
  }

  const state = readListState(await searchParams, API_CLIENT_SORT_FIELDS);
  const [page, people] = await Promise.all([
    adminList<ApiClient>('/admin/api-clients', state),
    // The directory, unfiltered by whatever the key list is filtered by: the picker offers people
    // to bind a key to, and narrowing it by the search somebody typed into the *key* list would
    // silently hide half the organisation.
    adminList<User>('/admin/users', {
      ...state,
      page: 1,
      pageSize: 100,
      search: '',
      deleted: 'live',
      filters: {},
    }),
  ]);

  return (
    <ApiClientsScreen rows={page.data} total={page.meta.total} state={state} people={people.data} />
  );
}
