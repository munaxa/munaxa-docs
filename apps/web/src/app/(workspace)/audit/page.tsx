import type { ReactNode } from 'react';

import type { AuditActions, AuditExport, AuditPage } from '@edms/contracts';
import { Permission } from '@edms/domain';

import { AdminForbidden } from '../../../features/admin-shared';
import { AuditScreen } from '../../../features/audit/audit-screen';
import { adminAccess, adminGet } from '../../../lib/admin/api';

type RawSearchParams = Readonly<Record<string, string | readonly string[] | undefined>>;

/**
 * The audit search (`13-audit-architecture.md` §6), gated on `audit:view`.
 *
 * The URL is the whole query, so a compliance question is a link. An *empty* URL runs nothing and
 * shows the person their filters instead — "every event ever recorded, newest first" is a page of
 * whatever happened this morning, which is not an answer to any question somebody came here with.
 *
 * The exports list is fetched only for callers holding `audit:export`. The two permissions are
 * separate in 08 §6 and separate here: reading the trail and taking a copy of it out of the system
 * are different acts, and the second is the one an auditor is granted and a library manager is not.
 */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}): Promise<ReactNode> {
  const access = await adminAccess(Permission.AUDIT_VIEW);
  if (!access.granted) {
    return <AdminForbidden />;
  }

  const params = await searchParams;
  const single = (key: string): string | undefined => {
    const value = params[key];
    const resolved = typeof value === 'string' ? value : value?.[0];
    return typeof resolved === 'string' && resolved.trim() !== '' ? resolved.trim() : undefined;
  };

  const query = new URLSearchParams({ page: '1', pageSize: '50' });
  for (const key of ['action', 'actorId', 'outcome', 'correlationId'] as const) {
    const value = single(key);
    if (value !== undefined) {
      query.set(key, value);
    }
  }
  // The date inputs are calendar days; the API's range is instants. A day given as "to" means the
  // end of that day, not its first millisecond — otherwise a filter for today returns nothing.
  const from = single('from');
  const to = single('to');
  if (from !== undefined) {
    query.set('from', new Date(`${from}T00:00:00.000Z`).toISOString());
  }
  if (to !== undefined) {
    query.set('to', new Date(`${to}T23:59:59.999Z`).toISOString());
  }

  const filtered = ['action', 'actorId', 'outcome', 'correlationId', 'from', 'to'].some(
    (key) => single(key) !== undefined,
  );
  const canExport = access.permissions.includes(Permission.AUDIT_EXPORT);

  const [page, actions, exports] = await Promise.all([
    filtered ? adminGet<AuditPage>(`/audit/events?${query.toString()}`) : Promise.resolve(null),
    adminGet<AuditActions>('/audit/actions'),
    canExport
      ? adminGet<{ data: AuditExport[] }>('/audit/exports?page=1&pageSize=10')
      : Promise.resolve({ data: [] as AuditExport[] }),
  ]);

  return (
    <AuditScreen page={page} actions={actions.data} exports={exports.data} canExport={canExport} />
  );
}
