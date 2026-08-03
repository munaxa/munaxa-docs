'use client';

import { useEffect } from 'react';
import type { ReactNode } from 'react';

import { Button, ErrorState } from '@munaxa/ui';

import { en } from '@edms/i18n';

/**
 * The route error boundary.
 *
 * It shows the correlation id — the one thing that makes a support conversation short — and
 * nothing else. No message from the exception, no stack: an error body may contain a
 * document title or a path, and neither belongs on a screen a user might share
 * (`docs/architecture/15-api-architecture.md` §4).
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): ReactNode {
  useEffect(() => {
    console.error('Route error', { digest: error.digest });
  }, [error]);

  return (
    <ErrorState
      title={en.state.error}
      description={en.state.errorHint}
      // Present only when Next generated a digest for the failure; the id is the whole point
      // of this screen, so it is passed when it exists and omitted when it does not.
      {...(error.digest ? { referenceId: error.digest } : {})}
      action={
        <Button onClick={reset} variant="secondary">
          {en.state.retry}
        </Button>
      }
    />
  );
}
