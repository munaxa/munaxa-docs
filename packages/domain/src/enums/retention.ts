/** Retention vocabulary (`docs/architecture/adr/0010-soft-delete-and-retention.md`). */
export const RetentionTrigger = {
  ON_PUBLISH: 'ON_PUBLISH',
  ON_SUPERSEDE: 'ON_SUPERSEDE',
  ON_ARCHIVE: 'ON_ARCHIVE',
  ON_DELETE: 'ON_DELETE',
} as const;

export type RetentionTriggerKey = (typeof RetentionTrigger)[keyof typeof RetentionTrigger];

export const Disposition = {
  REVIEW: 'REVIEW',
  ARCHIVE: 'ARCHIVE',
  PURGE: 'PURGE',
  RETAIN_FOREVER: 'RETAIN_FOREVER',
} as const;

export type DispositionKey = (typeof Disposition)[keyof typeof Disposition];

/**
 * Where one document's schedule has got to.
 *
 * `CANCELLED` was added in Phase 10 and is the state a *restore* produces. A delete can create a
 * schedule (`ON_DELETE`), and restoring the document has to withdraw it — leaving it `PENDING`
 * would mean a document somebody put back is still queued for disposition, and closing it as
 * `EXECUTED` would claim a disposition that never ran. Neither is true, so the state that says
 * what happened is its own.
 */
export const RetentionScheduleState = {
  /** Waiting for its date. The only state `listDue` looks at. */
  PENDING: 'PENDING',
  /** Due, and the policy demands a person confirm before the disposition runs. */
  IN_REVIEW: 'IN_REVIEW',
  /** The disposition ran. Terminal. */
  EXECUTED: 'EXECUTED',
  /** A legal hold blocks it. Resumes at `PENDING` when the last hold is released. */
  SUSPENDED: 'SUSPENDED',
  /** Withdrawn before it ran, because what triggered it was undone. Terminal. */
  CANCELLED: 'CANCELLED',
} as const;

export type RetentionScheduleStateKey =
  (typeof RetentionScheduleState)[keyof typeof RetentionScheduleState];
