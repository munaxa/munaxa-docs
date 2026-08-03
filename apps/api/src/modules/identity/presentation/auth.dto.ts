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
