import type { ReactNode } from 'react';

import { EmptyState } from '@munaxa/ui';

import { en } from '@edms/i18n';

/**
 * The workspace root.
 *
 * Phase 0.5 ships the shell, not the screens: the dashboard's widgets read from other
 * modules' read models, and those modules have contracts but no data yet. This renders the
 * empty state rather than a mock, because a mocked dashboard is indistinguishable from a
 * broken one the day the real data arrives.
 */
export default function WorkspaceHome(): ReactNode {
  return <EmptyState title={en.state.empty} description={en.state.emptyHint} />;
}
