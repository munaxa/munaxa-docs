'use server';

import type { Route } from 'next';
import { redirect } from 'next/navigation';

import { signIn } from '../../../lib/auth';

/** Why the last attempt failed, or null before the first attempt and after a successful one. */
export type SignInRejection = 'REJECTED' | 'UNAVAILABLE';

export interface SignInFormState {
  readonly reason: SignInRejection | null;
}

export const EMPTY_FORM_STATE: SignInFormState = { reason: null };

/**
 * The sign-in form's action.
 *
 * A server action rather than a client `fetch`, so the credentials go straight from the form
 * post to the server and the tokens are written into `httpOnly` cookies without ever passing
 * through client JavaScript. A client-side sign-in would have to receive the tokens in a
 * response body first, which is the thing this design exists to avoid.
 */
export async function signInAction(
  _previous: SignInFormState,
  formData: FormData,
): Promise<SignInFormState> {
  const email = textField(formData, 'email').trim();
  const password = textField(formData, 'password');
  const tenant = textField(formData, 'tenant').trim().toLowerCase();

  if (email.length === 0 || password.length === 0) {
    return { reason: 'REJECTED' };
  }

  const outcome = await signIn({ email, password, ...(tenant ? { tenant } : {}) });
  if (!outcome.ok) {
    return { reason: outcome.reason };
  }

  // Outside the try/catch above and after the cookies are written: `redirect` works by
  // throwing, and a redirect swallowed by an error handler is a form that silently does
  // nothing.
  redirect(nextDestination(formData));
}

/**
 * Where to go after signing in.
 *
 * Only a path within this application is honoured. An absolute URL, or anything starting
 * `//`, would make the login page an open redirect — somewhere to land a phishing link that
 * genuinely begins with our own domain.
 */
function nextDestination(formData: FormData): Route {
  const requested = textField(formData, 'next');
  const safe = requested.startsWith('/') && !requested.startsWith('//') ? requested : '/';
  // Typed routes cannot check a value that only exists at runtime. The assertion is confined
  // to this one line, immediately after the check that makes it safe, rather than spread
  // across the callers.
  return safe as Route;
}

/**
 * Reads a text field, treating anything that is not a string as absent.
 *
 * `FormData.get` returns `string | File | null`, and a multipart post can put a `File` in any
 * field it likes. Coercing one with `String()` yields `[object Object]` — which would sail
 * through a length check and be sent to the API as somebody's email address.
 */
function textField(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}
