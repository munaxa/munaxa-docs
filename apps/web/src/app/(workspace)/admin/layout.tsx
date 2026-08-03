import type { ReactNode } from 'react';

import { SidebarLayout } from '@munaxa/ui';

import { AdminForbidden } from '../../../features/admin-shared';
import { AdminSectionNav } from '../../../features/admin-shared/section-nav';
import { currentPermissions } from '../../../lib/admin/api';
import { sectionsFor } from '../../../lib/admin/sections';

/**
 * Administration's own frame.
 *
 * The section list is resolved here rather than on each page so that it is computed once per request
 * and is the same list on every screen inside it. A caller holding no administrative permission at
 * all is shown the refusal instead of an empty sidebar — an empty sidebar looks like a product that
 * failed to load, and this one is working exactly as intended.
 */
export default async function AdminLayout({
  children,
}: {
  children: ReactNode;
}): Promise<ReactNode> {
  const sections = sectionsFor(await currentPermissions());

  if (sections.length === 0) {
    return <AdminForbidden />;
  }

  return (
    <SidebarLayout width="md" collapseBelow="lg" sidebar={<AdminSectionNav sections={sections} />}>
      {children}
    </SidebarLayout>
  );
}
