'use client';

import type { ReactNode } from 'react';

import { useRouter } from 'next/navigation';

import { Button, ErrorState, ProductLogo } from '@munaxa/ui';

import { useTranslate } from '../app/providers';

/**
 * What the workspace renders when it could not ask the API who the caller is — RC validation, D-18.
 *
 * Not the sign-in screen, and not an error boundary. The session may be perfectly good: what failed
 * is the service that would confirm it, and sending somebody to sign in would neither work nor be
 * true. So the page says the service is unavailable, keeps the session, and ends there — it is a
 * complete response, not a step in a redirect.
 *
 * `router.refresh()` on the reader's say-so rather than an automatic retry, for the reason
 * `RateLimited` gives: retrying on somebody's behalf against a service that is down is load on the
 * service at the moment it can least take it, and a page that never settles is the defect this
 * replaced. Once the API answers again, the same button — or any navigation — is the whole recovery:
 * nothing was cleared, so nothing has to be re-entered.
 */
export function SessionUnavailable(): ReactNode {
  const translate = useTranslate();
  const router = useRouter();
  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <div className="flex w-full max-w-md flex-col gap-8">
        <div className="flex justify-center">
          <ProductLogo variant="stacked" height={76} priority />
        </div>
        <ErrorState
          title={translate('auth.serviceUnavailable')}
          description={translate('auth.serviceUnavailableHint')}
          action={
            <Button
              onClick={() => {
                router.refresh();
              }}
              variant="secondary"
            >
              {translate('state.retry')}
            </Button>
          }
        />
      </div>
    </main>
  );
}
