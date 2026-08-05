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
 * tenant-level role grant covers this permission", which in this generation — before ACL
 * entries exist to say anything narrower — is the entire reach question, answered the same way
 * a direct read answers it. When the ACL phase builds entries and the walk, entries below a
 * node that breaks inheritance stop carrying the grant token and start carrying explicit
 * subject tokens; the predicate, and everything above it, does not change.
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
 * The subjects an index entry materialises for one permission, in this generation.
 *
 * No ACL entry exists yet, so every scope chain resolves to the same answer a direct read
 * enforces: the tenant-level role grant, closed by default. The entry therefore allows exactly
 * the grant token and denies nobody. When entries exist, this becomes the walk's output for
 * the document's chain — and an ACL change re-projects the affected subtree, which is what
 * `library.acl-changed` is declared for.
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
