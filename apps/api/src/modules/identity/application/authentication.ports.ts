import type { PermissionKey, RoleId, TenantId, UserId } from '@edms/domain';

/**
 * Authentication's contracts.
 *
 * Everything here is an interface plus a DI token, and nothing names a library: the password
 * hasher does not mention scrypt, the token issuer does not mention JWT. That is what allows
 * the parameters to be raised, or signing moved to an external issuer, without a single use
 * case changing (`docs/architecture/02-backend-architecture.md` §4).
 */

export const PASSWORD_HASHER = Symbol('PasswordHasher');
export const ACCESS_TOKEN_ISSUER = Symbol('AccessTokenIssuer');
export const REFRESH_TOKEN_FACTORY = Symbol('RefreshTokenFactory');
export const TENANT_DIRECTORY = Symbol('TenantDirectory');
export const AUTHENTICATION_SERVICE = Symbol('AuthenticationService');

/**
 * Derives and checks password hashes.
 *
 * `verify` takes the encoded hash rather than a bare digest so the parameters used to derive
 * it travel with it. That is what makes `needsRehash` answerable, and therefore what makes it
 * possible to raise the cost later without locking anyone out.
 */
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  /** Constant-time. Returns false for a malformed stored hash rather than throwing. */
  verify(password: string, encodedHash: string): Promise<boolean>;
  /** True when the stored hash was derived with parameters weaker than today's. */
  needsRehash(encodedHash: string): boolean;
  /**
   * A well-formed hash that no password matches.
   *
   * Sign-in verifies against this when no user was found, so that a missing account costs the
   * same time as a wrong password. Without it, the endpoint answers "does this address exist"
   * with a stopwatch.
   */
  decoyHash(): string;
}

/** The claims an access token is minted from. Expiry is the issuer's decision, not the caller's. */
export interface AccessTokenRequest {
  readonly userId: UserId;
  readonly tenantId: TenantId;
  readonly roles: readonly string[];
  readonly permissions: readonly PermissionKey[];
  readonly sessionId: string;
  readonly permissionVersion: number;
}

export interface IssuedAccessToken {
  readonly token: string;
  readonly expiresAt: Date;
}

export interface AccessTokenIssuer {
  issue(request: AccessTokenRequest): IssuedAccessToken;
}

/** A freshly minted refresh token: the secret, its stored digest, and when it dies. */
export interface MintedRefreshToken {
  readonly token: string;
  readonly hash: string;
  readonly expiresAt: Date;
}

/**
 * Mints and digests refresh tokens.
 *
 * Refresh tokens are opaque random strings, never JWTs: the whole point is that they can be
 * revoked, and a self-describing token is valid until it expires no matter what the server
 * thinks (`docs/architecture/17-security-architecture.md` §2).
 */
export interface RefreshTokenFactory {
  create(now: Date): MintedRefreshToken;
  /** The digest a presented token is looked up by. Same input, same output, always. */
  hash(token: string): string;
}

/**
 * Resolves which tenant a sign-in is against.
 *
 * The host selects the tenant, exactly as far as
 * [21-saas-commercial-architecture.md](../../../../../docs/architecture/21-saas-commercial-architecture.md)
 * §5 permits: to choose whose login screen and directory this is, never as an authorisation
 * input. What the caller ends up authorised for is decided entirely by the signed `tenantId`
 * claim in the token this produces.
 *
 * This is the one read in the product that legitimately happens outside a tenant context,
 * which is why `tenant` is the one table with no row-level security policy.
 */
export interface TenantDirectory {
  findIdBySlug(slug: string): Promise<TenantId | null>;
}

/** What a successful sign-in or refresh hands back. */
export interface AuthenticationResult {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: Date;
  /** Opaque, high-entropy, stored only as a hash. Never a JWT: it must be revocable. */
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: Date;
  readonly user: AuthenticatedUser;
}

export interface AuthenticatedUser {
  readonly id: UserId;
  readonly email: string;
  readonly displayName: string;
  readonly roleIds: readonly RoleId[];
  readonly roles: readonly string[];
  readonly permissions: readonly PermissionKey[];
  readonly mfaEnrolled: boolean;
}

/**
 * Everything about the request that a session records or needs, minus the credentials.
 *
 * `correlationId` and `locale` are carried explicitly because sign-in runs before any request
 * context exists — there is no token yet to build one from.
 */
export interface SessionContext {
  readonly tenantSlug: string;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly correlationId: string;
  readonly locale: string;
}

export interface SignInCommand extends SessionContext {
  readonly email: string;
  readonly password: string;
  /** A TOTP code or a recovery code, when the account has a confirmed authenticator (Phase 14). */
  readonly mfaCode?: string;
}

export interface AuthenticationService {
  /**
   * Exchanges credentials for a session.
   *
   * Fails identically for an unknown tenant, an unknown address, a wrong password, a user with
   * no password set and a disabled account: the caller learns only that the pair was not
   * accepted. Distinguishing them turns the endpoint into a directory of who holds an account.
   */
  signIn(command: SignInCommand): Promise<AuthenticationResult>;

  /**
   * Exchanges a refresh token for a new pair, rotating it.
   *
   * Presenting a token that has already been exchanged revokes the entire family: the token
   * was captured, and there is no way to tell the thief from the legitimate holder.
   */
  refresh(refreshToken: string, context: SessionContext): Promise<AuthenticationResult>;

  /** Revokes the family the token belongs to. Idempotent: an unknown token is not an error. */
  signOut(refreshToken: string, context: SessionContext): Promise<void>;
}
