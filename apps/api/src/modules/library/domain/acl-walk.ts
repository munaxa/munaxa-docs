import { type PermissionKey, type ScopeRef, type ScopeTypeKey, survivesBrokenInheritance } from '@edms/domain';

import {
  departmentSubjectToken,
  grantSubjectToken,
  roleSubjectToken,
  userSubjectToken,
} from './acl-subjects';

/**
 * The walk, as arithmetic over a chain that has already been read.
 *
 * `08-permission-model.md` §3 is eight steps; steps 2 and 3 are database reads and everything else
 * is this file. Keeping the decision pure is not tidiness — it is what lets the same rules be
 * asserted without a database, and what stops the two call sites that must agree (a direct read and
 * the search index's materialised subjects) from being two implementations of one algorithm.
 *
 * The chain is **ancestor-first**: tenant at index 0, the object last, exactly as `SCOPE_CHAIN`
 * orders it. "Nearest" therefore means "latest", and every function here reads the array backwards
 * when it wants the most specific answer.
 */

/** One node of a resolved scope chain, with the one fact the walk needs about it. */
export interface ChainNode {
  readonly scope: ScopeRef;
  /**
   * `folder.inherit_acl = false`. Only folders can carry it; every other node reports `false`
   * because there is no column for them to say otherwise on, and inventing one would be a second
   * way to hide a subtree.
   */
  readonly breaksInheritance: boolean;
  /** The materialised path, for the nodes that have one. Folders only; null elsewhere. */
  readonly path: string | null;
}

/** An entry as the walk consumes it: which node, which subject, allow or deny. */
export interface ChainEntry {
  readonly scopeId: string;
  readonly subjectType: 'USER' | 'ROLE' | 'DEPARTMENT';
  readonly subjectId: string;
  readonly effect: 'ALLOW' | 'DENY';
}

export type DecisionReason =
  | 'ALLOW'
  | 'DENY'
  | 'ROLE_GRANT'
  | 'CLOSED_BY_DEFAULT'
  | 'STATE'
  | 'CONFIDENTIALITY';

export interface WalkOutcome {
  readonly allowed: boolean;
  /** The node that decided it — ADR-0005's mitigation, and what the permissions screen renders. */
  readonly decidedAt: ScopeRef | null;
  readonly reason: DecisionReason;
}

/**
 * The part of a chain a permission is actually resolved over.
 *
 * A folder with `inherit_acl = false` stops the walk *there*: nothing above it contributes, which
 * includes the tenant-level role grant of step 6. That is the point of the flag — a folder that
 * breaks inheritance is one whose contents are reachable only by an entry on it or below it.
 *
 * **The truncation removes denies as well as allows**, and that is a decision rather than a
 * consequence. "Stops the walk" is one sentence in ADR-0005 and could have meant "stops granting";
 * letting a `DENY` cross a break while an `ALLOW` cannot would make the break a one-way valve that
 * only ever subtracts, and an administrator reading "this folder does not inherit" would have no
 * way to discover that half of what is above it still applies. Deny-wins stays exactly what §3
 * says it is — a rule about the entries on the chain — and the break decides what the chain *is*.
 *
 * Administrative permissions (`*:manage`, `audit:*`) ignore the break entirely, or a user could
 * hide a subtree from the administrators accountable for it. `survivesBrokenInheritance` in
 * `@edms/domain` is the one definition of which those are; it was written in Phase 1 and this is
 * its first caller.
 */
export function effectiveChain(
  chain: readonly ChainNode[],
  permission: PermissionKey,
): readonly ChainNode[] {
  if (survivesBrokenInheritance(permission)) {
    return chain;
  }
  // The *deepest* break wins: two breaks on one chain mean the lower one is the boundary, because
  // the upper one already stopped applying to anything below the lower.
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const node = chain[index];
    if (node !== undefined && node.breaksInheritance) {
      return chain.slice(index);
    }
  }
  return chain;
}

/** Whether the effective chain still reaches the tenant — the precondition for step 6. */
export function reachesTenant(effective: readonly ChainNode[]): boolean {
  return effective.length > 0 && effective[0]?.scope.type === 'TENANT';
}

/**
 * Steps 4 to 7, over the entries that matched the caller's subjects on the effective chain.
 *
 * Deny first and unconditionally, at any level: that is ADR-0005's alternative-1 rejection made
 * literal — "why can this person not see it" is answerable by finding one row, without simulating
 * the tree. Among several denies the *nearest* node is reported, because that is the one an
 * administrator will edit.
 */
export function decideFromEntries(
  effective: readonly ChainNode[],
  entries: readonly ChainEntry[],
  holdsRoleGrant: boolean,
): WalkOutcome {
  const byScope = new Map<string, ChainEntry[]>();
  for (const entry of entries) {
    const bucket = byScope.get(entry.scopeId);
    if (bucket === undefined) {
      byScope.set(entry.scopeId, [entry]);
    } else {
      bucket.push(entry);
    }
  }

  let nearestAllow: ScopeRef | null = null;
  let nearestDeny: ScopeRef | null = null;
  for (const node of effective) {
    for (const entry of byScope.get(String(node.scope.id)) ?? []) {
      if (entry.effect === 'DENY') {
        nearestDeny = node.scope;
      } else {
        nearestAllow = node.scope;
      }
    }
  }

  if (nearestDeny !== null) {
    return { allowed: false, decidedAt: nearestDeny, reason: 'DENY' };
  }
  if (nearestAllow !== null) {
    return { allowed: true, decidedAt: nearestAllow, reason: 'ALLOW' };
  }
  if (holdsRoleGrant && reachesTenant(effective)) {
    return { allowed: true, decidedAt: effective[0]?.scope ?? null, reason: 'ROLE_GRANT' };
  }
  return { allowed: false, decidedAt: null, reason: 'CLOSED_BY_DEFAULT' };
}

/**
 * The subject tokens an index entry materialises for one object and permission.
 *
 * The same walk, expressed as two sets instead of one answer, because a search query cannot run
 * the walk per row — it compares arrays (`12-search-architecture.md` §3). A caller matches when
 * their tokens overlap `allowSubjects` and do **not** overlap `denySubjects`, which is deny-wins
 * evaluated by the engine's `&&` operators rather than by this function.
 *
 * A subject with an `ALLOW` above and a `DENY` below appears in *both* lists, and that is correct:
 * the predicate excludes them, exactly as `decideFromEntries` would.
 *
 * `grant:<permission>` is in `allowSubjects` when — and only when — the effective chain still
 * reaches the tenant. That is `acl-subjects.ts`'s prediction, unchanged: below a folder that breaks
 * inheritance the grant token disappears and explicit subject tokens take over, and neither the
 * predicate nor anything above it had to change to make it true.
 */
export function indexSubjectsFromEntries(
  effective: readonly ChainNode[],
  entries: readonly ChainEntry[],
  permission: PermissionKey,
): { readonly allowSubjects: readonly string[]; readonly denySubjects: readonly string[] } {
  const onChain = new Set(effective.map((node) => String(node.scope.id)));
  const allow = new Set<string>();
  const deny = new Set<string>();

  for (const entry of entries) {
    if (!onChain.has(entry.scopeId)) {
      continue;
    }
    (entry.effect === 'DENY' ? deny : allow).add(subjectToken(entry));
  }
  if (reachesTenant(effective)) {
    allow.add(grantSubjectToken(permission));
  }
  return { allowSubjects: [...allow], denySubjects: [...deny] };
}

/** The token vocabulary, from an entry's own two columns. */
export function subjectToken(entry: Pick<ChainEntry, 'subjectType' | 'subjectId'>): string {
  switch (entry.subjectType) {
    case 'USER':
      return userSubjectToken(entry.subjectId as never);
    case 'ROLE':
      return roleSubjectToken(entry.subjectId as never);
    default:
      return departmentSubjectToken(entry.subjectId as never);
  }
}

/**
 * Which subject identifiers a caller matches entries with.
 *
 * Not the token vocabulary — that is for the *index*, whose two sides are opaque strings. An ACL
 * query filters `subject_id IN (…)` against a UUID column, so this is the raw list, and a role id
 * that happened to equal a user id would match both. That is harmless here and not in the index:
 * the query also filters on the subject *type* through the entry's own column, whereas the index
 * has only the array (which is why the tokens are prefixed at all).
 */
export function callerSubjectIds(subject: {
  readonly userId: string;
  readonly roleIds: readonly string[];
  readonly departmentIds: readonly string[];
}): readonly string[] {
  return [
    ...(subject.userId === '' ? [] : [subject.userId]),
    ...subject.roleIds,
    ...subject.departmentIds,
  ];
}

/** Whether a scope type may carry an ACL entry at all — every node on `SCOPE_CHAIN` may. */
export function isAclScopeType(value: string): value is ScopeTypeKey {
  return (
    value === 'TENANT' ||
    value === 'COMPANY' ||
    value === 'ENTITY' ||
    value === 'DEPARTMENT' ||
    value === 'LIBRARY' ||
    value === 'FOLDER' ||
    value === 'DOCUMENT'
  );
}
