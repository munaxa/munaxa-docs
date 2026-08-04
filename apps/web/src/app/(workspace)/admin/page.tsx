import type { ReactNode } from 'react';

import { AdminOverview } from '../../../features/admin-shared/overview';
import { currentPermissions } from '../../../lib/admin/api';
import { sectionsFor } from '../../../lib/admin/sections';

/** Administration's landing page: the areas this caller can reach, in setup order. */
export default async function AdminIndexPage(): Promise<ReactNode> {
  return <AdminOverview sections={sectionsFor(await currentPermissions())} />;
}
