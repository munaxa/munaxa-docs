import type { ReactNode } from 'react';

import type { WebhookEndpoint } from '@edms/contracts';
import { Permission } from '@edms/domain';

import { AdminForbidden } from '../../../../features/admin-shared';
import { WebhooksScreen } from '../../../../features/admin-integration/webhooks-screen';
import { adminAccess, adminList } from '../../../../lib/admin/api';
import { type RawSearchParams, readListState } from '../../../../lib/admin/list-state';
import { WEBHOOK_SORT_FIELDS } from '../../../../lib/admin/list-keys';

/** Outbound webhook endpoints, and why each one is or is not delivering. */
export default async function WebhooksPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}): Promise<ReactNode> {
  const access = await adminAccess(Permission.INTEGRATION_MANAGE);
  if (!access.granted) {
    return <AdminForbidden />;
  }

  const state = readListState(await searchParams, WEBHOOK_SORT_FIELDS);
  const page = await adminList<WebhookEndpoint>('/admin/webhooks', state);

  return <WebhooksScreen rows={page.data} total={page.meta.total} state={state} />;
}
