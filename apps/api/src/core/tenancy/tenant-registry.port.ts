import type { TenantPlacement } from './tenant-placement';

/**
 * Where the platform learns which tenants exist and where each one's infrastructure lives.
 *
 * This is the seam that makes one codebase serve both deployments. An on-premise installation
 * resolves one placement from its own environment; the hosted service resolves many from a
 * catalogue; a future control-plane database resolves them from a table. All three are adapters
 * behind this port, and nothing above it can tell which is in use
 * ([ADR-0015](../../../../../docs/architecture/adr/0015-database-per-tenant.md)).
 *
 * The port is **synchronous-looking but async**, and deliberately so: a config-backed adapter answers
 * from memory, and a database-backed one will not. Making the fast case async now costs nothing and
 * means the slow case is not a breaking change to every caller.
 *
 * Resolution is by slug **or** by id because both questions are asked at different moments. Sign-in
 * has a slug and no token; every request after it has an id from a signed claim and no slug.
 */
export const TENANT_REGISTRY = Symbol('TenantRegistry');

export interface TenantRegistry {
  /**
   * The placement for a sign-in slug, or null.
   *
   * Null for a slug that does not exist **and** for one whose tenant is closed, because the caller
   * must not be able to tell the difference: "which organisations exist" is not a question an
   * unauthenticated endpoint answers.
   */
  bySlug(slug: string): Promise<TenantPlacement | null>;

  /** The placement for a tenant id from a token claim, or null if it no longer resolves. */
  byId(tenantId: string): Promise<TenantPlacement | null>;

  /**
   * Every placement this deployment serves.
   *
   * For the migration runner and the health check — the two things that legitimately act across
   * tenants. Nothing in a request path may call it: iterating tenants inside a request is how a
   * cross-tenant read gets written by accident.
   */
  all(): Promise<readonly TenantPlacement[]>;
}
