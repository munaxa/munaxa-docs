import type { PermissionKey, TenantId, UserId } from '@edms/domain';

/**
 * What an access token asserts.
 *
 * Object-level permissions are deliberately **not** in here. They are resolved per request
 * against the scope tree, so revoking access on a folder takes effect on the next call
 * rather than at the next token refresh (`docs/architecture/15-api-architecture.md` §5).
 */
export interface AccessTokenClaims {
  readonly sub: UserId;
  readonly tenantId: TenantId;
  readonly roles: readonly string[];
  /** Tenant-wide grants only. Reach is decided by the ACL resolver. */
  readonly permissions: readonly PermissionKey[];
  readonly sessionId: string;
  /** Bumped when a role, delegation or permission changes; a stale token is re-evaluated. */
  readonly permVersion: number;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

export const TOKEN_VERIFIER = Symbol('TokenVerifier');

/**
 * Verifies a bearer token. Implemented by the Identity module's infrastructure: local
 * signing keys today, a tenant's OIDC provider where the tenant federates.
 */
export interface TokenVerifier {
  verify(token: string): Promise<AccessTokenClaims>;
}
