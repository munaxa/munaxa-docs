import { AsyncLocalStorage } from 'node:async_hooks';

import type { PermissionKey, TenantId, UserId } from '@edms/domain';

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
