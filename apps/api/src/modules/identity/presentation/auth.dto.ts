import { z } from 'zod';

import { MAXIMUM_PASSWORD_LENGTH } from '../domain/password-policy';

/**
 * The wire shapes for authentication.
 *
 * Sign-in deliberately does **not** apply the password policy. The policy governs what may be
 * *set*; applying it here would reject a legitimate holder of an older password, and would
 * also tell an attacker which candidate strings are worth trying.
 */
export const signInSchema = z.object({
  email: z.string().min(3).max(320),
  password: z.string().min(1).max(MAXIMUM_PASSWORD_LENGTH),
  /**
   * Which organisation to sign in to. Optional because the host normally answers it; supplied
   * explicitly by API clients and local development, where every tenant shares one hostname.
   */
  tenant: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z0-9][a-z0-9-]*$/)
    .optional(),
  /**
   * The second factor, when the account has one (Phase 14).
   *
   * On the sign-in body rather than at a separate `/auth/mfa` endpoint, and the reason is what a
   * two-call flow would have to carry between the calls: a token proving the password was right.
   * That token is a credential with a lifetime and a revocation story, minted for one purpose, and
   * it is exactly the sort of thing that is issued once and then reused. One call spends the
   * password and the code together and issues nothing until both are right.
   *
   * Optional, because the client cannot know whether a factor is owed until it has tried — and the
   * API will not tell it before the password is verified, since "this address has MFA" is a fact
   * about who holds an account.
   *
   * Also accepts a recovery code, which is why the length allows more than six digits.
   */
  mfaCode: z.string().min(1).max(32).optional(),
});

export type SignInBody = z.infer<typeof signInSchema>;

export const refreshSchema = z.object({
  refreshToken: z.string().min(1).max(512),
  tenant: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z0-9][a-z0-9-]*$/)
    .optional(),
});

export type RefreshBody = z.infer<typeof refreshSchema>;

/**
 * The response body — both tokens.
 *
 * The API sets no cookies. It is a JSON API consumed by a server-side client: the Next.js
 * application is the only browser-facing surface, and it is what puts these into `httpOnly`
 * cookies so that no script in the page can read either
 * (`apps/web/src/lib/session.ts`, `docs/architecture/17-security-architecture.md` §2).
 *
 * Returning a refresh token in a body would be wrong for a browser calling this directly, and
 * is right for a back-end-for-front-end that never hands it to one. Splitting the difference —
 * the API setting a cookie the web application then has to forward — would give a token two
 * owners and no clear one.
 */
export interface AuthenticationResponse {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: string;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: string;
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly displayName: string;
    readonly roles: readonly string[];
    readonly permissions: readonly string[];
    readonly mfaEnrolled: boolean;
  };
}

/**
 * The wire shape of a successful authentication, from whichever path produced it.
 *
 * Lifted here in Phase 17 so that a **federated** sign-in and a password sign-in cannot answer
 * differently. Two mappers would be two chances for one of them to add a field the other did not,
 * and a client that could tell the two apart would start branching on it — which is the opposite
 * of the property federation is meant to have: a federated session is an ordinary session.
 */
export function respondWith(result: {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: Date;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: Date;
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly displayName: string;
    readonly roles: readonly string[];
    readonly permissions: readonly string[];
    readonly mfaEnrolled: boolean;
  };
}): AuthenticationResponse {
  return {
    accessToken: result.accessToken,
    accessTokenExpiresAt: result.accessTokenExpiresAt.toISOString(),
    refreshToken: result.refreshToken,
    refreshTokenExpiresAt: result.refreshTokenExpiresAt.toISOString(),
    user: {
      id: result.user.id,
      email: result.user.email,
      displayName: result.user.displayName,
      roles: result.user.roles,
      permissions: result.user.permissions,
      mfaEnrolled: result.user.mfaEnrolled,
    },
  };
}
