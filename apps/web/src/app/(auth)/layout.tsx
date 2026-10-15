import type { ReactNode } from 'react';

import { ProductLogo } from '@munaxa/ui';

import { LanguageSwitch, ThemeToggle } from '../../components/workspace-shell';
import { getTranslator } from '../../lib/server-i18n';

/**
 * The unauthenticated shell: no navigation, no tenant chrome, nothing that implies a session.
 *
 * It carries the product's identity, which is the branding phase's point rather than decoration:
 * somebody who followed a link from an email is being asked for a password, and the page has to say
 * whose. The logo's own accessible name says "Munaxa Docs"; the heading below states the task.
 *
 * ## Docs v2
 *
 * The form sits on a card on the muted page, with the horizontal lockup at the card's head — the
 * approved design — and the two controls a reader may need *before* signing in at the top of the
 * page: the colour scheme and the language. An Arabic reader should not have to sign in in English
 * to find the Arabic product. They are the shell's own controls, not copies.
 *
 * The line under the card says what is true: every sign-in attempt, refused ones included, is an
 * audited event. Saying so is the honest version of a "secure login" badge.
 */
export default async function AuthLayout({
  children,
}: {
  children: ReactNode;
}): Promise<ReactNode> {
  const translate = await getTranslator();
  return (
    <div className="bg-secondary flex min-h-dvh flex-col">
      <div className="flex justify-end gap-1.5 px-5 py-4">
        <ThemeToggle />
        <LanguageSwitch />
      </div>
      <main className="flex flex-1 items-center justify-center p-6">
        <div className="border-border bg-card shadow-card flex w-full max-w-[380px] flex-col gap-6 rounded-[14px] border p-8">
          <ProductLogo variant="horizontal" height={30} priority />
          {children}
        </div>
      </main>
      <p className="text-muted-foreground mb-5 text-center text-xs">
        {translate('auth.accessLogged')}
      </p>
    </div>
  );
}
