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

/**
 * The response body.
 *
 * The refresh token is **not** here — it is set as an `httpOnly` cookie, so script running in
 * the page cannot read it. The access token is returned in the body precisely because it is
 * short-lived and must be attachable as a bearer header
 * (`docs/architecture/17-security-architecture.md` §2).
 */
export interface AuthenticationResponse {
  readonly accessToken: string;
  readonly expiresAt: string;
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly displayName: string;
    readonly roles: readonly string[];
    readonly permissions: readonly string[];
    readonly mfaEnrolled: boolean;
  };
}
