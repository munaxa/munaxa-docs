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
} as const;

export type LibraryAuditAction = (typeof LibraryAudit)[keyof typeof LibraryAudit];
