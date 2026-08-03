import type { AnyId, PermissionKey, ScopeRef, UserId } from '@edms/domain';
import type { Capabilities } from '@edms/contracts';

/**
 * The single place an authorisation decision is made.
 *
 * The algorithm it implements is fixed by `docs/architecture/08-permission-model.md` §3:
 * collect the caller's subjects (user, roles, departments, active delegations), walk the
 * scope chain from the object up to the tenant, and let **deny win at any level**. Absent an
 * entry, the answer is no — closed by default. State and confidentiality modifiers may only
 * subtract from the result, never add to it.
 *
 * Every consumer asks this port. A module that reimplements any part of the walk has
 * created a second, divergent answer to the product's most security-sensitive question.
 */
export const ACL_RESOLVER = Symbol('AclResolver');

export interface AuthorizationSubject {
  readonly userId: UserId;
  readonly roleIds: readonly AnyId[];
  readonly departmentIds: readonly AnyId[];
  /** Active delegations only; an expired delegation is not a subject. */
  readonly delegationIds: readonly AnyId[];
}

export interface Decision {
  readonly allowed: boolean;
  /** The scope node that decided it — what the permissions tab shows the user as *why*. */
  readonly decidedAt: ScopeRef | null;
  readonly reason:
    'ALLOW' | 'DENY' | 'ROLE_GRANT' | 'CLOSED_BY_DEFAULT' | 'STATE' | 'CONFIDENTIALITY';
}

export interface AclResolver {
  resolve(
    subject: AuthorizationSubject,
    scope: ScopeRef,
    permission: PermissionKey,
  ): Promise<Decision>;

  /**
   * Every permission the caller holds on one object, computed server-side and returned with
   * the resource so the UI renders actions instead of inferring them.
   */
  capabilitiesFor(
    subject: AuthorizationSubject,
    scope: ScopeRef,
    permissions: readonly PermissionKey[],
  ): Promise<Capabilities>;

  /**
   * A predicate the caller can push into SQL, so a list is filtered in the database.
   * Fetch-then-filter leaks totals, facet counts and page boundaries
   * (`docs/architecture/08-permission-model.md` §7).
   */
  visibilityFilter(
    subject: AuthorizationSubject,
    permission: PermissionKey,
  ): Promise<VisibilityFilter>;
}

/** The resolved subject fingerprint a query is filtered by, and the index is keyed on. */
export interface VisibilityFilter {
  readonly subjectIds: readonly AnyId[];
  readonly deniedScopeIds: readonly AnyId[];
  readonly unrestricted: boolean;
  readonly fingerprint: string;
}
