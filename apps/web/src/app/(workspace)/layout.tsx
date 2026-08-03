import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { AppShell } from '@munaxa/ui';

import { en } from '@edms/i18n';

import { currentSession } from '../../lib/session';

/**
 * The authenticated shell.
 *
 * The guard is here rather than in a client component because a client-side redirect renders
 * the workspace first and navigates away after — which means the markup existed, however
 * briefly. `middleware.ts` performs the same check at the edge; this is the layer that
 * cannot be skipped by a direct request to a nested route.
 *
 * The shell itself owns structure only. Navigation, the top bar and the command palette are
 * slots, filled by the phases that build them.
 */
export default async function WorkspaceLayout({
  children,
}: {
  children: ReactNode;
}): Promise<ReactNode> {
  const session = await currentSession();
  if (!session) {
    redirect('/login');
  }

  return <AppShell skipLinkLabel={en.app.name}>{children}</AppShell>;
}
