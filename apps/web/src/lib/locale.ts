'use server';

import { cookies } from 'next/headers';

import { isLocale } from '@edms/i18n';

import { LOCALE_COOKIE } from './session';

/** A year. The choice is a preference, and a preference that expires is one somebody re-makes. */
const LOCALE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/**
 * Switch the interface language — the top bar's language control, Docs v2.
 *
 * `currentLocale()` has read `edms_locale` since Phase 0.5 and nothing wrote it, so an Arabic
 * reader had no way into the Arabic product short of editing a cookie. This is the writer.
 *
 * A cookie rather than a path segment because `lang` and `dir` are set on `<html>` by the root
 * layout on the **server** — the whole point of that arrangement is that a right-to-left frame is
 * never painted left-to-right first. Changing the cookie and refreshing the route re-renders that
 * layout with the new direction in one response.
 *
 * `httpOnly` like every other cookie this application sets: only the server reads it. The value is
 * checked against the supported locales, because a server action is a public endpoint and an
 * arbitrary string here would be written into `lang` on every page.
 */
export async function switchLocale(next: string): Promise<void> {
  if (!isLocale(next)) {
    return;
  }
  (await cookies()).set(LOCALE_COOKIE, next, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: LOCALE_MAX_AGE_SECONDS,
  });
}
