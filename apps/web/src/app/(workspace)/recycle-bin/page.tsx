import type { ReactNode } from 'react';

import type { RecycleBinItem } from '@edms/contracts';
import { Permission } from '@edms/domain';

import { AdminForbidden } from '../../../features/admin-shared';
import { RecycleBinScreen } from '../../../features/recycle-bin/recycle-bin-screen';
import { adminAccess, adminGet } from '../../../lib/admin/api';

type RawSearchParams = Readonly<Record<string, string | readonly string[] | undefined>>;

/**
 * The recycle bin (`16-frontend-architecture.md` §2), gated on `document:restore`.
 *
 * ADR-0010 §2's own words: "deleted objects are visible in a recycle bin to holders of
 * `document:restore`". Narrower than the library's `document:view` on purpose — being able to read
 * what exists is not being able to see what somebody removed, and the second is the question a
 * document controller asks.
 */
export default async function RecycleBinPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}): Promise<ReactNode> {
  const access = await adminAccess(Permission.DOCUMENT_RESTORE);
  if (!access.granted) {
    return <AdminForbidden />;
  }

  const params = await searchParams;
  const raw = params['kind'];
  const kind = typeof raw === 'string' ? raw : raw?.[0];

  const query = new URLSearchParams({ page: '1', pageSize: '50' });
  if (kind === 'DOCUMENT' || kind === 'FOLDER') {
    query.set('kind', kind);
  }

  const page = await adminGet<{
    data: RecycleBinItem[];
    meta: { total: number };
  }>(`/recycle-bin?${query.toString()}`);

  return <RecycleBinScreen items={page.data} total={page.meta.total} />;
}
