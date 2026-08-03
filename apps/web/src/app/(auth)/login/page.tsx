import { redirect } from 'next/navigation';
import type { Metadata, Route } from 'next';
import type { ReactNode } from 'react';

import { en } from '@edms/i18n';

import { currentSession } from '../../../lib/session';
import { LoginForm } from './login-form';

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
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const next: Route = destinationFrom((await searchParams).next);

  if (await currentSession()) {
    redirect(next);
  }

  return <LoginForm next={next} />;
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
