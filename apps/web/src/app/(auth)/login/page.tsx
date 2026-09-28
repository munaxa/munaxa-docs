import { redirect } from 'next/navigation';
import type { Metadata, Route } from 'next';
import type { ReactNode } from 'react';

import { en } from '@edms/i18n';

import { currentSession } from '../../../lib/session';
import { checkSession } from '../../../lib/session-check';
import { LoginForm, type LoginNotice } from './login-form';

export const metadata: Metadata = {
  title: `${en.auth.signIn} · ${en.app.name}`,
};

/**
 * The sign-in screen.
 *
 * Both the edge middleware and the workspace layout redirect here, and until now it did not
 * exist — an unauthenticated visitor was sent to a 404 (risk R6 in the Phase 0.5 report).
 *
 * Someone who already has a session is sent on rather than shown the form again: a signed-in
 * user landing on a login page has no useful action to take there.
 *
 * "Has a session" means the API said so — RC validation, D-18. This used to redirect on the cookie
 * alone, while the workspace redirected here whenever the API refused that cookie or did not answer,
 * and the two sent the browser back and forth without end. Now a cookie is checked once:
 *
 * - valid: sent on, as before;
 * - refused by the API: the form, and the stale cookie ignored — the next sign-in overwrites it, and
 *   the workspace's route to `/login/session-ended` clears it if somebody navigates away instead;
 * - not checkable because the API did not answer: the form, with a sentence saying so. Not a
 *   redirect: the workspace would not be able to check it either.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const params = await searchParams;
  const next: Route = destinationFrom(params.next);
  let notice: LoginNotice | null = params.ended === '1' ? 'SESSION_ENDED' : null;

  const session = await currentSession();
  if (session) {
    const check = await checkSession(session.accessToken);
    if (check.state === 'VALID') {
      redirect(next);
    }
    if (check.state === 'UNAVAILABLE') {
      notice = 'SESSION_UNVERIFIED';
    }
  }

  return <LoginForm next={next} notice={notice} />;
}

/**
 * Only a path within this application is honoured.
 *
 * An absolute URL here would make the login screen an open redirect: a phishing link that
 * genuinely starts with our own domain and lands somewhere else. The same check runs again in
 * the action, because this one only sees what the page was rendered with.
 */
function destinationFrom(value: string | string[] | undefined): Route {
  const requested = Array.isArray(value) ? value[0] : value;
  const safe = requested?.startsWith('/') && !requested.startsWith('//') ? requested : '/';
  return safe as Route;
}
