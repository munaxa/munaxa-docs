import { createHash } from 'node:crypto';

import type { AnyId, PermissionKey, UserId } from '@edms/domain';

/**
 * The subject vocabulary the ACL predicate speaks.
 *
 * A search predicate compares two arrays of opaque tokens: the subjects an index entry allows,
 * and the subjects a caller *is* (`12-search-architecture.md` §3). Both sides are produced by
 * the resolver in this module — one implementation, two call sites — and these functions are
 * that vocabulary, defined once so the two sides can never drift into speaking different
 * dialects. The tokens are typed by prefix because a user id and a role id are both UUIDs, and
 * an untyped overlap between them would let a role id grant a user of the same digits.
 *
 * `grant:<permission>` is the one token that is not an identity. It says "anyone whose
 * tenant-level role grant covers this permission", which before ACL entries existed to say
 * anything narrower was the entire reach question, answered the same way a direct read answers
 * it. The paragraph that stood here predicted what would happen when the ACL phase arrived:
 * *"entries below a node that breaks inheritance stop carrying the grant token and start
 * carrying explicit subject tokens; the predicate, and everything above it, does not change."*
 *
 * **Phase 14 built it, and the prediction held.** `indexSubjectsFromEntries` in `acl-walk.ts`
 * adds `grant:<permission>` when — and only when — the effective chain still reaches the tenant,
 * and adds an explicit `user:` / `role:` / `department:` token for every entry on that chain. The
 * caller side (`callerSubjectTokens`, below) is byte-for-byte what it was; the engine's predicate
 * in `postgres-search.adapter.ts` is what it was; `12 §3`'s contract — an entry's `allowSubjects`
 * overlap a caller's `subjectIds` exactly when `resolve` would allow that caller — is what it was.
 * The one thing the phase had to add on this side is nothing at all, which is the strongest
 * evidence available that Phase 8 cut the seam in the right place.
 *
 * What did change is that `denySubjects` is now sometimes non-empty. It was always in the shape and
 * the adapter always excluded on it; there was simply nothing to put in it before entries existed.
 */
export function userSubjectToken(userId: UserId): string {
  return `user:${userId}`;
}

export function roleSubjectToken(roleId: AnyId): string {
  return `role:${roleId}`;
}

export function departmentSubjectToken(departmentId: AnyId): string {
  return `department:${departmentId}`;
}

export function grantSubjectToken(permission: PermissionKey): string {
  return `grant:${permission}`;
}

/**
 * Every token a caller may match an index entry with: who they are, what they belong to, and
 * the grant tokens for the permissions their tenant-level roles hold.
 */
export function callerSubjectTokens(input: {
  readonly userId: UserId;
  readonly roleIds: readonly AnyId[];
  readonly departmentIds: readonly AnyId[];
  readonly grantedPermissions: readonly PermissionKey[];
}): readonly string[] {
  return [
    ...(input.userId === '' ? [] : [userSubjectToken(input.userId)]),
    ...input.roleIds.map(roleSubjectToken),
    ...input.departmentIds.map(departmentSubjectToken),
    ...input.grantedPermissions.map(grantSubjectToken),
  ];
}

/**
 * The subjects an index entry materialises when nothing on its chain says anything narrower.
 *
 * Phase 8's whole answer, and still the answer for the overwhelming majority of documents: a
 * tenant with no ACL entry on a document's chain materialises the grant token and denies nobody,
 * which is what a direct read enforces. `indexSubjectsFromEntries` in `acl-walk.ts` is the general
 * case and produces exactly this when the entry list is empty and the chain reaches the tenant —
 * asserted in `acl-walk.spec.ts` rather than left as a claim, because the two agreeing is what
 * stops a tenant that has never opened the permissions screen from being re-indexed differently.
 */
export function indexAclSubjects(permission: PermissionKey): {
  readonly allowSubjects: readonly string[];
  readonly denySubjects: readonly string[];
} {
  return { allowSubjects: [grantSubjectToken(permission)], denySubjects: [] };
}

/**
 * A stable digest of a resolved subject set.
 *
 * Stored on the index entry as `acl_hash` so a permission-model change is detectable as
 * staleness, and returned in `VisibilityFilter.fingerprint` so the two call sites can be
 * compared. Order-insensitive: two computations of the same set are the same fingerprint.
 */
export function aclFingerprint(
  allowSubjects: readonly string[],
  denySubjects: readonly string[],
): string {
  const hash = createHash('sha256');
  hash.update([...allowSubjects].sort().join('\n'));
  // A literal separator, so {allow: [a, b]} and {allow: [a], deny: [b]} cannot digest alike.
  hash.update('\n|deny|\n');
  hash.update([...denySubjects].sort().join('\n'));
  return hash.digest('hex');
}
