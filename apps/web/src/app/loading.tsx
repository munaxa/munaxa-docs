import type { ReactNode } from 'react';

import { Spinner } from '@munaxa/ui';

import { en } from '@edms/i18n';

/** The route-level loading state. Streaming means the shell paints first and this fills the
 *  content column, rather than the page being blank until the slowest query returns. */
export default function Loading(): ReactNode {
  return (
    <div
      className="flex min-h-64 items-center justify-center gap-3"
      role="status"
      aria-live="polite"
    >
      <Spinner />
      <span className="text-sm text-muted-foreground">{en.state.loading}</span>
    </div>
  );
}
