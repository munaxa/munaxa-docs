/**
 * The audit actions Library writes.
 *
 * `13-audit-architecture.md` §2 names actions per area, and libraries and folders are two areas an
 * investigation asks about separately: "who created this library" and "who moved that folder" are
 * different questions with different subjects, and `AuditSubjectType` already distinguishes `LIBRARY`
 * from `FOLDER`. Following that grouping gives two actions rather than the ten a per-verb split would.
 *
 * Neither name appears in the catalogue's table, which lists the areas that existed when it was
 * written. They follow its convention — one action per area, `before`/`after` and an `operation` in the
 * payload — and the corresponding rows are added to that document by this phase.
 */
export const LibraryAudit = {
  /** A library was created, renamed, deleted or restored. */
  LIBRARY_CHANGED: 'LIBRARY_CHANGED',
  /** A folder was created, renamed, moved, deleted with its subtree, or restored. */
  FOLDER_CHANGED: 'FOLDER_CHANGED',
  /**
   * Reach was given to a subject on a node — 13 §2's row, written for the first time in Phase 14.
   *
   * **Three actions rather than one**, which breaks this file's own "one action per area" rule
   * deliberately and with the catalogue's blessing: 13 §2 names all three by name and assigns them
   * to "the phase that builds ACL entries". They are not three verbs on one resource; they are the
   * three questions asked after a disclosure. "Who could see this, and since when" is `ACL_GRANTED`.
   * "Why can this person no longer see it" is `ACL_REVOKED`. "Why did the tenant grant stop
   * applying to this subtree" is `INHERITANCE_BROKEN`, and it is the one ADR-0005 singles out —
   * "audited because it is the operation most likely to hide content from the people accountable
   * for it". Collapsing them into `ACL_CHANGED` with an operation in the payload would make each of
   * those a payload filter over a table that already carries a row per document view.
   *
   * A single edit to a node writes at most one of each: the entries added are one `ACL_GRANTED`
   * naming them, and the entries removed are one `ACL_REVOKED`. A matrix edit that adds four and
   * removes two is two events, not six, because it was one act.
   */
  ACL_GRANTED: 'ACL_GRANTED',
  ACL_REVOKED: 'ACL_REVOKED',
  /** `folder.inherit_acl` went false. Only ever written in that direction — see the service. */
  INHERITANCE_BROKEN: 'INHERITANCE_BROKEN',
} as const;

export type LibraryAuditAction = (typeof LibraryAudit)[keyof typeof LibraryAudit];
