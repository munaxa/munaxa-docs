import type { AnyId, PermissionKey, ScopeRef, UserId } from '@edms/domain';
import type { Capabilities } from '@edms/contracts';

/**
 * The single place an authorisation decision is made.
 *
 * The algorithm it implements is fixed by `docs/architecture/08-permission-model.md` §3:
 * collect the caller's subjects (user, roles, departments — never a delegation, see §3), walk
 * the scope chain from the object up to the tenant, and let **deny win at any level**. Absent an
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

  /**
   * The subject sets an index entry materialises for one scope and permission — the search
   * projection's call site of the same resolution `visibilityFilter` answers the query side
   * with. One implementation, two call sites, so the index can never disagree with a direct
   * read (`docs/architecture/12-search-architecture.md` §3). An entry's `allowSubjects` must
   * overlap a caller's `VisibilityFilter.subjectIds` exactly when `resolve` would allow that
   * caller to view the scope.
   */
  aclSubjectsFor(scope: ScopeRef, permission: PermissionKey): Promise<IndexAclSubjects>;
}

/** What the projection writes into `acl_subjects` / `acl_deny_subjects` / `acl_hash`. */
export interface IndexAclSubjects {
  readonly allowSubjects: readonly string[];
  readonly denySubjects: readonly string[];
  readonly fingerprint: string;
}

/** The resolved subject fingerprint a query is filtered by, and the index is keyed on. */
export interface VisibilityFilter {
  readonly subjectIds: readonly AnyId[];
  readonly deniedScopeIds: readonly AnyId[];
  readonly unrestricted: boolean;
  readonly fingerprint: string;
  /**
   * The same decision, shaped for a **relational** list rather than for the search index.
   *
   * Phase 8 gave this filter one shape because it had one consumer: the index compares two arrays
   * of tokens, and `subjectIds` is the caller's side of that comparison. A document list has no
   * materialised token column to compare against — it has `document`, `folder.path` and
   * `folder.library_id` — so Phase 14 adds the regions rather than making the list maintain a
   * second materialisation of the walk. **Both are computed by one resolution**, in one call, so
   * the two can no more disagree than the index and a direct read can.
   *
   * A region is a set of containers the caller reaches, minus the folder subtrees that break
   * inheritance below the node that granted it. The predicate a consumer builds is
   * `(any allowed region) AND NOT (any denied region)` — deny-wins, expressed as SQL.
   */
  readonly allowedRegions: readonly VisibilityRegion[];
  readonly deniedRegions: readonly VisibilityRegion[];
}

/**
 * One container the caller reaches, or is refused, and what is cut out of it.
 *
 * Deliberately shaped in the *library's* vocabulary — libraries, folder paths, document ids —
 * rather than in scope refs. A consumer holding a scope ref would have to resolve an `ENTITY`
 * to the libraries beneath it to write a `WHERE`, which is the walk leaking into every list that
 * filters by it. The resolver does that resolution once, where the scope tree already is.
 */
export interface VisibilityRegion {
  /** The whole tenant: the tenant-level role grant, or an entry on the tenant node itself. */
  readonly tenantWide: boolean;
  readonly libraryIds: readonly string[];
  /** Materialised folder paths; each covers that folder and everything beneath it. */
  readonly folderPaths: readonly string[];
  readonly documentIds: readonly string[];
  /**
   * Folder subtrees this region does not reach, because a folder between its node and them sets
   * `inherit_acl = false`. Empty for a region rooted at a document, and — for an administrative
   * permission — empty everywhere, since a break never blocks one.
   */
  readonly excludedFolderPaths: readonly string[];
}
