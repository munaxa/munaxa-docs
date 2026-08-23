import type { UserId } from '@edms/domain';

/**
 * The authoritative permission generation for one person — Slice 31.
 *
 * `permVersion` has been minted into every access token since Phase 0.5 and compared nowhere, so
 * three statements in the product were false: `17-security-architecture.md` §2's revocation row,
 * `UserAdminService.update`'s "their token must stop being accepted", and — most explicitly —
 * `RoleAdminService.update`'s "there is no window in which the role says one thing and the tokens
 * still in flight say another". There was a window, and it was the whole access-token lifetime:
 * fifteen minutes by default and up to an hour by configuration.
 *
 * This port is what makes the claim authoritative. It answers "what generation is this person's
 * authority on, right now", and `AuthenticationGuard` refuses a token that disagrees.
 *
 * A port rather than a direct read because a guard must not hold a Prisma client: `AclGuard` sets
 * the precedent — it depends on `ACL_RESOLVER` and the adapter opens the unit of work it needs.
 * Guards run outside any transaction, so an implementation must open its own.
 */
export const PERMISSION_VERSION_READER = Symbol('PermissionVersionReader');

export interface PermissionVersionReader {
  /**
   * The person's current `permission_version`, or `null` when there is no live row for them.
   *
   * `null` is not "unknown" — it is "there is nobody here", which is what a deleted user looks
   * like from this port. The guard refuses it. A failure to *read* throws rather than answering
   * `null`, because a fallback answer on this path would be the fail-open the whole change exists
   * to close (`ports/cache.port.ts`: a cold cache must produce the same answer, never a different
   * one).
   */
  currentFor(userId: UserId): Promise<number | null>;
}
