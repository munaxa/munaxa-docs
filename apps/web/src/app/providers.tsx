'use client';

import { QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, createContext, useContext, useState } from 'react';

import { LocaleProvider, ToastProvider } from '@munaxa/ui';

import { DEFAULT_LOCALE, type LocaleKey, type MessageKey, translatorFor } from '@edms/i18n';

import { createQueryClient } from '../lib/query-client';

/**
 * The client-side providers, in the order they must nest.
 *
 * Session state — user, tenant, locale — is resolved on the server and passed down as a
 * value, not fetched again in the browser: fetching it twice produces a flash of the wrong
 * shell and a second source of truth for who is signed in
 * (`docs/architecture/16-frontend-architecture.md` §4).
 */
export interface SessionValue {
  readonly userId: string | null;
  readonly tenantId: string | null;
  readonly locale: LocaleKey;
}

const SessionContext = createContext<SessionValue>({
  userId: null,
  tenantId: null,
  locale: DEFAULT_LOCALE,
});

export function useSession(): SessionValue {
  return useContext(SessionContext);
}

/**
 * Every user-visible string comes from the catalogues, never from a literal in a component.
 *
 * The `values` argument is part of the signature rather than a second hook, because the strings
 * that need it are the ones a component must not assemble itself: "Delete {name}?" is one sentence
 * in English and a different word order in Arabic, and concatenating a name onto a translated
 * fragment produces a sentence no translator ever saw.
 */
export function useTranslate(): (
  key: MessageKey,
  values?: Readonly<Record<string, string | number>>,
) => string {
  return translatorFor(useSession().locale);
}

export function Providers({
  session,
  children,
}: {
  session: SessionValue;
  children: ReactNode;
}): ReactNode {
  // Created once per browser session: a client rebuilt on every render throws the cache away
  // on each state change, which looks exactly like a slow API.
  const [queryClient] = useState(createQueryClient);

  return (
    <SessionContext.Provider value={session}>
      <LocaleProvider locale={session.locale}>
        <QueryClientProvider client={queryClient}>
          {/*
            Outside the shell, so a message survives a navigation. A failed save is reported after the
            list has already moved on, and a notice mounted inside the page it came from would be
            unmounted before it was read.
          */}
          <ToastProvider>{children}</ToastProvider>
        </QueryClientProvider>
      </LocaleProvider>
    </SessionContext.Provider>
  );
}
