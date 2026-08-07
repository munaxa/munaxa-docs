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
  /**
   * A TOTP code or a recovery code, when the account has an authenticator (Phase 14).
   *
   * Sent with the password rather than in a second call, because a two-call flow would have to
   * carry a token between the calls proving the password was right — a credential with a lifetime
   * and a revocation story, minted for one purpose, of exactly the kind that gets reused.
   */
  readonly mfaCode?: string;
}

export type SignInOutcome =
  | { readonly ok: true }
  /**
   * `REJECTED` is every credential failure; the API does not distinguish them and nor do we.
   * `MFA_REQUIRED` is the one exception, and it is not a leak: it is only ever returned after the
   * password has been verified, so it tells the caller nothing they could not learn by holding the
   * account.
   */
  | { readonly ok: false; readonly reason: 'REJECTED' | 'UNAVAILABLE' | 'MFA_REQUIRED' };

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
    if (error instanceof DomainError && error.code === ErrorCode.MFA_REQUIRED) {
      // The password was right and a code is owed. Distinguished from a rejection so the form can
      // ask for the code rather than telling somebody their correct password was wrong — which
      // would be untrue and would train people to retype it.
      return { ok: false, reason: 'MFA_REQUIRED' };
    }
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
  // Every environment but the two that genuinely run without TLS.
  //
  // `=== 'production'` was the test until Phase 5, and it was wrong for one deployment shape this
  // product actually has: `NODE_ENV=staging` is a value the API's own configuration enum accepts,
  // and a staging deployment served over HTTPS was writing session cookies without `Secure`. That
  // is a cookie a downgrade can strip off the wire, holding a live refresh token, in the
  // environment most likely to be reachable from the internet without being watched closely.
  const secure = process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test';

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
