import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import { TEXT_DIRECTION, en } from '@edms/i18n';

import { currentLocale } from '../lib/session';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: en.app.name,
  description: en.app.description,
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

/**
 * The document shell.
 *
 * `lang` and `dir` are set from the session's locale on the **server**, so an Arabic user
 * never sees a left-to-right frame repaint into a right-to-left one. Everything below is
 * laid out with logical properties, which is what makes that a one-attribute change rather
 * than a second stylesheet (`docs/architecture/16-frontend-architecture.md` §8).
 */
export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}): Promise<ReactNode> {
  const locale = await currentLocale();

  return (
    <html lang={locale} dir={TEXT_DIRECTION[locale]} suppressHydrationWarning>
      <body>
        <Providers session={{ userId: null, tenantId: null, locale }}>{children}</Providers>
      </body>
    </html>
  );
}
