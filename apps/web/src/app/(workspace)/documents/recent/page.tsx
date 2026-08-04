import type { ReactNode } from 'react';

import type { RecentDocument } from '@edms/contracts';
import { Permission } from '@edms/domain';

import { AdminForbidden } from '../../../../features/admin-shared';
import { RecentScreen } from '../../../../features/documents/recent-screen';
import { adminList } from '../../../../lib/admin/api';
import { adminAccess } from '../../../../lib/admin/api';
import { readListState } from '../../../../lib/admin/list-state';

/**
 * The caller's own recently opened documents.
 *
 * There is no `userId` parameter and there will not be one: "recent" is inherently the caller's own
 * list, and an endpoint that took a user would be an endpoint for reading somebody else's reading
 * history — a surveillance feature rather than a navigation one.
 */
export default async function RecentDocumentsPage(): Promise<ReactNode> {
  const access = await adminAccess(Permission.DOCUMENT_VIEW);
  if (!access.granted) {
    return <AdminForbidden />;
  }

  const page = await adminList<RecentDocument>(
    '/documents/recent',
    readListState({}, ['updatedAt'], []),
  );

  return <RecentScreen rows={page.data} />;
}
