import 'server-only';

import type { PermissionKey } from '@edms/domain';
import { DomainError, ErrorCode } from '@edms/domain';

import { apiFetch } from './api-client';
import { HOME_DESTINATION, safeDestination } from './destination';

/**
 * Whether the session cookie still stands for a session — RC validation, D-18.
 *
 * Three answers, not two. The workspace layout used to treat every failure of `/auth/me` as "not
 * signed in" and redirect to `/login`, while the login page treated the mere *presence* of the
 * cookie as "signed in" and redirected back. A cookie the API refused, or an API that did not answer
 * at all, therefore bounced the browser between the two for as long as it would follow redirects —
 * measured at 273 navigations and 3 014 requests in ten seconds with the API down.
 *
 * The two failures are different facts and need different responses:
 *
 * - `REJECTED` — the API answered, in its own problem format, `UNAUTHENTICATED`. That is the one
 *   refusal the API gives an expired, forged or revoked token, a disabled account (whose sessions are
 *   revoked) and a stale permission version alike (`AuthenticationGuard`). The session is over; the
 *   cookie is worthless and is cleared.
 * - `UNAVAILABLE` — anything else: the connection refused or timed out, a gateway answered in its own
 *   format, the API answered 5xx or with any code that is not a verdict on the credential. Nobody
 *   knows whether the session is valid, so the cookie is kept and nobody is sent to sign in: signing
 *   in again would not work any better, and discarding a valid session because a dependency blinked
 *   is the wrong way to fail.
 *
 * Only a parsed `UNAUTHENTICATED` counts as a rejection. An unparseable 401 from something between
 * here and the API becomes `INTERNAL` in `apiFetch`, and is therefore `UNAVAILABLE` — a proxy must
 * not be able to sign somebody out.
 */
export interface Identity {
  readonly userId: string | null;
  /**
   * The caller's own name and address — Phase 7.9.
   *
   * Nullable because a token need not stand for a person: an API-key caller has a tenant and
   * permissions and nobody behind it. The chip falls back to the identifier rather than deriving
   * anything from it.
   */
  readonly displayName: string | null;
  readonly email: string | null;
  readonly tenantId: string;
  readonly roles: readonly string[];
  readonly permissions: readonly PermissionKey[];
}

export type SessionCheck =
  | { readonly state: 'VALID'; readonly identity: Identity }
  | { readonly state: 'REJECTED' }
  | { readonly state: 'UNAVAILABLE' };

/**
 * How long one check may wait for the API.
 *
 * A host that accepts the connection and never answers would otherwise hold the page open until the
 * platform's own socket timeout, which is minutes. Past this the answer is "unknown", which is what
 * `UNAVAILABLE` means.
 */
export const SESSION_CHECK_TIMEOUT_MS = 10_000;

export async function checkSession(accessToken: string): Promise<SessionCheck> {
  try {
    const identity = await apiFetch<Identity>({
      path: '/auth/me',
      accessToken,
      signal: AbortSignal.timeout(SESSION_CHECK_TIMEOUT_MS),
    });
    return { state: 'VALID', identity };
  } catch (error) {
    return isRejection(error) ? { state: 'REJECTED' } : { state: 'UNAVAILABLE' };
  }
}

/** The API's own verdict that a credential is not a session — and nothing else. */
export function isRejection(error: unknown): boolean {
  return error instanceof DomainError && error.code === ErrorCode.UNAUTHENTICATED;
}

/**
 * Where a rejected session is sent: the route that clears it, then the sign-in screen.
 *
 * A server component cannot delete a cookie — only a route handler or a server action can — so a
 * page that learns its session was refused hands the browser to `/login/session-ended`, which checks
 * again and clears only on the API's own rejection (see that route).
 */
export function sessionEndedPath(next?: string | null): string {
  const destination = safeDestination(next);
  return destination === HOME_DESTINATION
    ? '/login/session-ended'
    : `/login/session-ended?next=${encodeURIComponent(destination)}`;
}
