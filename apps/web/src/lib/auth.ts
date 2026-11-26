import 'server-only';

import { cookies } from 'next/headers';

import { DomainError, ErrorCode } from '@edms/domain';

import { apiFetch } from './api-client';
import { clientAddress } from './client-address';
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE, TENANT_COOKIE } from './session';

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
  | {
      readonly ok: false;
      readonly reason: 'REJECTED' | 'UNAVAILABLE' | 'MFA_REQUIRED' | 'FEDERATED_SIGN_IN_REQUIRED';
    };

export async function signIn(input: SignInInput): Promise<SignInOutcome> {
  try {
    const forwardedFor = await clientAddress();
    const result = await apiFetch<AuthenticationResponse>({
      path: '/auth/login',
      method: 'POST',
      body: input,
      // The sign-in limit is per address, and without this every browser is this server.
      ...(forwardedFor !== undefined && { forwardedFor }),
    });
    await storeSession(result, input.tenant);
    return { ok: true };
  } catch (error) {
    if (error instanceof DomainError && error.code === ErrorCode.MFA_REQUIRED) {
      // The password was right and a code is owed. Distinguished from a rejection so the form can
      // ask for the code rather than telling somebody their correct password was wrong — which
      // would be untrue and would train people to retype it.
      return { ok: false, reason: 'MFA_REQUIRED' };
    }
    if (error instanceof DomainError && error.code === ErrorCode.FEDERATED_SIGN_IN_REQUIRED) {
      // The password was right, and this organisation signs in with Munaxa: the form says so and
      // points at Sign in with Munaxa rather than calling a correct password wrong.
      return { ok: false, reason: 'FEDERATED_SIGN_IN_REQUIRED' };
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
 * The refresh token goes to the API **with the tenant it belongs to** (WEB-1). The API reads no
 * tenant from the host, so a sign-out that named none was refused, the refusal was swallowed below,
 * and the refresh family stayed live: a copy of the token taken before sign-out could still be
 * exchanged, and rotated, for a month at a time.
 *
 * The cookies are cleared whatever the API says. The caller's intent was to sign out, and
 * leaving a token in the browser because the server was slow is the wrong way to fail.
 */
export async function signOut(): Promise<void> {
  const store = await cookies();
  const refreshToken = store.get(REFRESH_TOKEN_COOKIE)?.value;
  const tenant = store.get(TENANT_COOKIE)?.value;

  if (refreshToken) {
    try {
      await apiFetch<void>({
        path: '/auth/logout',
        method: 'POST',
        body: { refreshToken, ...(tenant ? { tenant } : {}) },
      });
    } catch {
      // Already expired, already revoked, or unreachable. None of them change what happens next.
    }
  }

  store.delete(ACCESS_TOKEN_COOKIE);
  store.delete(REFRESH_TOKEN_COOKIE);
  store.delete(TENANT_COOKIE);
}

async function storeSession(result: AuthenticationResponse, tenant?: string): Promise<void> {
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
  // The organisation this session belongs to, for as long as its refresh token lives — sign-out
  // has to name it (WEB-1).
  if (tenant) {
    store.set(TENANT_COOKIE, tenant, {
      ...shared,
      expires: new Date(result.refreshTokenExpiresAt),
    });
  }
}

// -------------------------------------------------------------------------------------------------
// Sign-in through Munaxa Identity (one Munaxa sign-in for every product; Identity ADR-0008)
// -------------------------------------------------------------------------------------------------

/**
 * The short-lived cookie that binds the browser finishing a federated sign-in to the browser that
 * started it.
 *
 * The API keeps the flow's `state` server-side, which stops a forged callback but not **login
 * CSRF**: an attacker starts a flow, signs in as themselves, and hands the callback URL to a victim,
 * whose browser would then be signed in as the attacker. So starting also writes this `httpOnly`
 * cookie holding a digest of the `state`, the organisation and where to go afterwards, and the
 * callback is honoured only when the cookie names the same `state`. `Lax`, because the callback is
 * a top-level navigation back from Identity and a `Strict` cookie is withheld from exactly that.
 */
// `__Host-` in production: the browser then accepts it only from this exact host, `Secure`, path `/`
// and without a domain, so a sibling host under the same parent domain cannot plant a binding and
// bring login CSRF back. Plain HTTP in development cannot carry a `__Host-` cookie.
export const FEDERATION_COOKIE =
  process.env.NODE_ENV === 'production' ? '__Host-edms_federation' : 'edms_federation';
const FEDERATION_TTL_SECONDS = 600;

/**
 * Spends the binding. Written as an expired `set` with the same attributes, because a browser
 * ignores a `__Host-` cookie update that lacks `Secure`, and `delete` sends none.
 */
const spendBinding = (store: Awaited<ReturnType<typeof cookies>>): void => {
  store.set(FEDERATION_COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
};

interface FederationBinding {
  readonly stateDigest: string;
  readonly tenant: string;
  readonly next: string;
}

const digest = async (value: string): Promise<string> => {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(value, 'utf8').digest('base64url');
};

export type FederatedStart =
  | { readonly ok: true; readonly authorizationUrl: string }
  | { readonly ok: false; readonly reason: 'NOT_OFFERED' | 'UNAVAILABLE' };

export async function startFederatedSignIn(input: {
  readonly email: string;
  readonly tenant: string;
  readonly next: string;
}): Promise<FederatedStart> {
  let offer: { federated: boolean; authorizationUrl: string | null };
  try {
    const query = new URLSearchParams({ email: input.email, tenant: input.tenant });
    offer = await apiFetch<{ federated: boolean; authorizationUrl: string | null }>({
      path: `/auth/federation?${query.toString()}`,
    });
  } catch {
    return { ok: false, reason: 'UNAVAILABLE' };
  }
  if (!offer.federated || offer.authorizationUrl === null) {
    return { ok: false, reason: 'NOT_OFFERED' };
  }
  const state = new URL(offer.authorizationUrl).searchParams.get('state');
  if (state === null || state === '') return { ok: false, reason: 'UNAVAILABLE' };

  const binding: FederationBinding = {
    stateDigest: await digest(state),
    tenant: input.tenant,
    next: input.next,
  };
  (await cookies()).set(FEDERATION_COOKIE, JSON.stringify(binding), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: FEDERATION_TTL_SECONDS,
  });
  return { ok: true, authorizationUrl: offer.authorizationUrl };
}

/** Spends the binding without completing, for a callback that carries the provider's error. */
export async function abandonFederatedSignIn(): Promise<void> {
  spendBinding(await cookies());
}

export type FederatedCompletion =
  | { readonly ok: true; readonly next: string }
  | { readonly ok: false; readonly reason: 'REJECTED' | 'UNAVAILABLE' };

/**
 * The callback's half: only for the browser that started the flow, then the API exchanges the code
 * and the session is stored exactly as after a password sign-in. The binding cookie is spent either
 * way.
 */
export async function completeFederatedSignIn(input: {
  readonly code: string | null;
  readonly state: string | null;
}): Promise<FederatedCompletion> {
  const store = await cookies();
  const raw = store.get(FEDERATION_COOKIE)?.value;
  spendBinding(store);

  let binding: FederationBinding;
  try {
    binding = JSON.parse(raw ?? '') as FederationBinding;
  } catch {
    return { ok: false, reason: 'REJECTED' };
  }
  if (
    typeof binding?.stateDigest !== 'string' ||
    typeof binding.tenant !== 'string' ||
    typeof binding.next !== 'string' ||
    input.code === null ||
    input.state === null ||
    input.code === '' ||
    (await digest(input.state)) !== binding.stateDigest
  ) {
    return { ok: false, reason: 'REJECTED' };
  }

  try {
    const forwardedFor = await clientAddress();
    const result = await apiFetch<AuthenticationResponse>({
      path: '/auth/federation/callback',
      method: 'POST',
      body: { code: input.code, state: input.state, tenant: binding.tenant },
      ...(forwardedFor !== undefined && { forwardedFor }),
    });
    await storeSession(result, binding.tenant);
    return { ok: true, next: binding.next };
  } catch (error) {
    if (error instanceof DomainError && error.code === ErrorCode.UNAUTHENTICATED) {
      return { ok: false, reason: 'REJECTED' };
    }
    return { ok: false, reason: 'UNAVAILABLE' };
  }
}
