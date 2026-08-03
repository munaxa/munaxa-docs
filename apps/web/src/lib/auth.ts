import 'server-only';

import { cookies } from 'next/headers';

import { DomainError, ErrorCode } from '@edms/domain';

import { apiFetch } from './api-client';
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from './session';

/**
 * Sign-in, from the server's side of the application.
 *
 * This module is the back-end-for-front-end: the browser posts to a server action, the server
 * calls the API, and the tokens are written into `httpOnly` cookies here. Neither token is
 * ever serialised into a page or handed to client JavaScript, which is what makes a script
 * injected into the page unable to read them
 * (`docs/architecture/17-security-architecture.md` §2).
 */

export interface AuthenticatedUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
  readonly mfaEnrolled: boolean;
}

interface AuthenticationResponse {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: string;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: string;
  readonly user: AuthenticatedUser;
}

export interface SignInInput {
  readonly email: string;
  readonly password: string;
  readonly tenant?: string;
}

export type SignInOutcome =
  | { readonly ok: true }
  /** `REJECTED` is every credential failure; the API does not distinguish them and nor do we. */
  | { readonly ok: false; readonly reason: 'REJECTED' | 'UNAVAILABLE' };

export async function signIn(input: SignInInput): Promise<SignInOutcome> {
  try {
    const result = await apiFetch<AuthenticationResponse>({
      path: '/auth/login',
      method: 'POST',
      body: input,
    });
    await storeSession(result);
    return { ok: true };
  } catch (error) {
    if (error instanceof DomainError && error.code === ErrorCode.UNAUTHENTICATED) {
      return { ok: false, reason: 'REJECTED' };
    }
    // Anything else is our problem, not the caller's: an unreachable API must not be reported
    // as a bad password, which would send someone to reset a password that works.
    return { ok: false, reason: 'UNAVAILABLE' };
  }
}

/**
 * Ends the session at the API and locally.
 *
 * The cookies are cleared whatever the API says. The caller's intent was to sign out, and
 * leaving a token in the browser because the server was slow is the wrong way to fail.
 */
export async function signOut(): Promise<void> {
  const store = await cookies();
  const refreshToken = store.get(REFRESH_TOKEN_COOKIE)?.value;

  if (refreshToken) {
    try {
      await apiFetch<void>({ path: '/auth/logout', method: 'POST', body: { refreshToken } });
    } catch {
      // Already expired, already revoked, or unreachable. None of them change what happens next.
    }
  }

  store.delete(ACCESS_TOKEN_COOKIE);
  store.delete(REFRESH_TOKEN_COOKIE);
}

async function storeSession(result: AuthenticationResponse): Promise<void> {
  const store = await cookies();
  const secure = process.env.NODE_ENV === 'production';

  // `Lax` rather than `Strict`: someone following a link into the workspace from an email
  // should not arrive signed out. The tokens are useless to another origin regardless, because
  // no script can read them.
  const shared = { httpOnly: true, secure, sameSite: 'lax', path: '/' } as const;

  store.set(ACCESS_TOKEN_COOKIE, result.accessToken, {
    ...shared,
    expires: new Date(result.accessTokenExpiresAt),
  });
  store.set(REFRESH_TOKEN_COOKIE, result.refreshToken, {
    ...shared,
    expires: new Date(result.refreshTokenExpiresAt),
  });
}
