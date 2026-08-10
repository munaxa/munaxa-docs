import 'server-only';

import { cache } from 'react';

import { type Translator, translatorFor } from '@edms/i18n';

import { currentLocale } from './session';

/**
 * The catalogue, bound to this request's locale, on the server.
 *
 * `useTranslate` is a hook and therefore client-only, and until Phase 9 every server component
 * that needed a string got one by passing it down from a client component or by not having one.
 * The audit timeline is the first server component that renders text of its own — it fetches
 * inside itself so the record page's shell can paint without it (`16 §7`) — so it needs the
 * catalogue where it is, not where its parent is.
 *
 * Memoised per request: the locale is a cookie read, and a page rendering three server components
 * should read it once.
 */
export const getTranslator = cache(async (): Promise<Translator> =>
  translatorFor(await currentLocale()),
);
