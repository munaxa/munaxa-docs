import { AsyncLocalStorage } from 'node:async_hooks';

import type { ActorChannelKey, AnyId, PermissionKey, TenantId, UserId } from '@edms/domain';

import { UnauthenticatedError } from '../errors/application-errors';

/**
 * The request's tenant and actor, held in `AsyncLocalStorage` rather than threaded through
 * every signature by hand.
 *
 * This is the layer everything else routes on: the token carries a signed `tenantId`, this context
 * carries it through the call tree, the isolation guard rejects any request naming another tenant, and
 * then — under [ADR-0015](../../../../../docs/architecture/adr/0015-database-per-tenant.md) — the
 * tenant read from here decides *which database* the transaction opens on, which storage prefix a key
 * is written under, and which search index answers a query. The row-level predicate and RLS still sit
 * underneath all of that, inside each tenant's own database.
 *
 * Which is why the context is the thing that must never be absent rather than merely wrong: a missing
 * tenant used to mean an unfiltered query, and now means no database to query at all.
 *
 * A parameter can be forgotten at one call site out of two hundred. A context read by the
 * data layer itself cannot.
 */
export interface RequestContext {
  readonly tenantId: TenantId;
  readonly userId: UserId | null;
  readonly roles: readonly string[];
  /** Tenant-level grants from the token. Object-level reach is resolved per request. */
  readonly permissions: readonly PermissionKey[];
  readonly sessionId: string | null;
  readonly correlationId: string;
  /** Forces re-evaluation when a role or permission changes mid-session. */
  readonly permissionVersion: number;
  readonly locale: string;
  /**
   * How this actor reached the system — Phase 17, and the field that finally writes
   * `ActorChannel.API`.
   *
   * That value has been in the enum and in the database's `actor_channel` type since Phase 0.5 and
   * **nothing had ever written it**: every audit actor in the product was constructed with a
   * literal `'WEB'`, including the ones built by scheduled jobs. The channel was a guess in four
   * places rather than a fact in one, which is what this field replaces.
   *
   * Optional so that nothing constructing a context has to be changed to keep behaving as it did:
   * absent means `WEB`, which is what the literal said. What sets it deliberately is the API-key
   * authenticator (`API`), the lane consumers (`WORKER`) and provisioning (`SYSTEM`).
   */
  readonly channel?: ActorChannelKey;
  /**
   * Which API key this request arrived on, when it arrived on one.
   *
   * Recorded beside the actor rather than instead of them, because both facts matter and neither
   * substitutes for the other. `userId` stays the *person* the key acts as —
   * [ADR-0018](../../../../../docs/architecture/adr/0018-machine-identity-as-a-delegated-subject.md)
   * — so every reach decision in the product is unchanged and no predicate has to learn what a
   * machine is. This is what makes "which of our seventeen integrations downloaded that" a
   * question the trail can answer, rather than "somebody's service account did".
   */
  readonly apiClientId?: AnyId;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<TResult>(context: RequestContext, fn: () => TResult): TResult {
  return storage.run(context, fn);
}

/** The context, or `null` outside a request — a scheduled job, a boot-time check. */
export function currentContext(): RequestContext | null {
  return storage.getStore() ?? null;
}

/**
 * The context, or a failure. Called by anything that must not run unscoped: the Prisma
 * extension, the audit writer, the outbox writer.
 */
export function requireContext(): RequestContext {
  const context = storage.getStore();
  if (!context) {
    throw new UnauthenticatedError('This operation requires a tenant context.');
  }
  return context;
}

export function currentTenantId(): TenantId | null {
  return storage.getStore()?.tenantId ?? null;
}
