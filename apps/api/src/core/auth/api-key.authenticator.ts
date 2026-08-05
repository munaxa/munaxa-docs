import type { AnyId, PermissionKey, TenantId, UserId } from '@edms/domain';

/**
 * Resolving a machine credential, as `core/` is allowed to know about it.
 *
 * The port lives here and the implementation lives in Identity, for exactly the reason
 * `TOKEN_VERIFIER` does: Identity owns credentials, `core/` may not import a module, and
 * `AuthenticationMiddleware` — which is declared in `core/` — is the consumer. The composition
 * root is the one place that may import both and is where they are joined
 * (`AuthModule.withVerifier(...)`, extended in Phase 17 to take this as well).
 *
 * Its shape is deliberately *not* `TokenVerifier`'s. A token verifier is handed an opaque string
 * and returns claims, because a JWT carries its own tenant. A key does not: the tenant comes from
 * the host, exactly as it does at sign-in and with exactly the same standing — it selects *whose
 * directory this is* and is never an authorisation input, because what the caller may then do is
 * decided by the row this resolves to.
 */
export const API_KEY_AUTHENTICATOR = Symbol('ApiKeyAuthenticator');

/**
 * What a resolved key asserts.
 *
 * `subjectUserId` is the person the key acts as, and it becomes `RequestContext.userId` unchanged
 * — [ADR-0018](../../../../../docs/architecture/adr/0018-machine-identity-as-a-delegated-subject.md).
 * `permissions` is already the scope-narrowed intersection, so nothing downstream can reach the
 * subject's unfiltered set: `RbacGuard` reads what the context carries, and the context carries
 * this.
 */
export interface ApiKeyPrincipal {
  readonly apiClientId: AnyId;
  readonly tenantId: TenantId;
  readonly subjectUserId: UserId;
  readonly roleKeys: readonly string[];
  readonly permissions: readonly PermissionKey[];
  readonly permissionVersion: number;
}

export interface ApiKeyAuthenticator {
  /**
   * Resolves a key against the tenant the host names, or `null`.
   *
   * `tenantSlug` may be empty, which is a single-tenant installation whose host has no label to
   * spare. The implementation resolves that through the same registry sign-in uses, so the two
   * paths can never disagree about which tenant an unqualified host means.
   */
  authenticate(tenantSlug: string, presented: string): Promise<ApiKeyPrincipal | null>;
}
