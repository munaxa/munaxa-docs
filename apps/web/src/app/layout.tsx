import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import { BrandProvider, brandIcons, brandOpenGraphImage, productBrands } from '@munaxa/ui';
import { TEXT_DIRECTION, en } from '@edms/i18n';

import { currentLocale } from '../lib/session';
import { Providers } from './providers';
import './globals.css';

const brand = productBrands.docs;

/**
 * What a browser shows for this product.
 *
 * Every value comes from the brand registry rather than from a path typed here. Three Munaxa
 * products in one window used to be three identical tabs; the tab icon is the only thing telling
 * them apart at that size, so it is the one that has to be product-specific.
 *
 * `title.template` puts the product last, where a truncated tab title still reads as the screen
 * you are on. `robots` stays as it was: this is an authenticated surface and is never indexable —
 * the share image is for the links people paste into a chat, not for a crawler.
 */
export const metadata: Metadata = {
  title: { default: brand.name, template: `%s · ${brand.name}` },
  description: en.app.description,
  applicationName: brand.name,
  icons: brandIcons(brand),
  openGraph: {
    type: 'website',
    siteName: brand.name,
    title: brand.name,
    description: en.app.description,
    images: [brandOpenGraphImage(brand)],
  },
  twitter: { card: 'summary_large_image', images: [brandOpenGraphImage(brand).url] },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  /*
   * The product colour, and the one place in this repository a raw hex legitimately appears: the
   * browser paints the address bar and the task-switcher card before any stylesheet is parsed, so
   * it cannot read `--primary`. It is read from the registry, which reads it from the theme, so
   * there is still exactly one source of truth for it.
   */
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: brand.color },
    { media: '(prefers-color-scheme: dark)', color: brand.color },
  ],
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
      {/*
        The page canvas — Phase 7.8, and the one place in this product that can own it.

        Phase 7.7B measured `html`, `body` and `main` all computing to `rgba(0, 0, 0, 0)` while the
        shell itself was dark, and confirmed the same on every authenticated route. Nothing was
        painting the document, so the browser's own canvas showed through: white, which is
        *coincidentally right* in light and plainly wrong behind a dark shell.

        It is not the platform's to fix. `AppShell` renders `<div class="flex min-h-screen">` and
        says so in its own docstring — "The shell owns *structure* and nothing else" — and no theme
        stylesheet carries a `body` rule, by design: a shared package that painted every host
        application's document would be deciding something the host may not want. `<body>` belongs
        to this repository.

        `bg-background` and `text-foreground` are the platform's **existing semantic tokens**
        (`--background` is `#ffffff` in the light Docs palette and `#0a0f1a` in the dark one). No
        colour is named here, nothing is hardcoded, and retuning the palette upstream still reaches
        this product with no change — which is the property `globals.css` exists to protect.
      */}
      <body className="bg-background text-foreground">
        {/*
          Which product this is, declared once.

          `ProductLogo` reads it from here rather than being handed a file, so every logo below —
          the rail, the drawer, the sign-in card — is the Docs lockup by construction rather than
          by each caller remembering. It pairs with the theme imported in `globals.css`: same id,
          colour on one side and artwork on the other.
        */}
        <BrandProvider product="docs">
          <Providers session={{ userId: null, tenantId: null, locale }}>{children}</Providers>
        </BrandProvider>
      </body>
    </html>
  );
}
