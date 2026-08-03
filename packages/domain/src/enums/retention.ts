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

export const RetentionScheduleState = {
  PENDING: 'PENDING',
  IN_REVIEW: 'IN_REVIEW',
  EXECUTED: 'EXECUTED',
  SUSPENDED: 'SUSPENDED',
} as const;

export type RetentionScheduleStateKey =
  (typeof RetentionScheduleState)[keyof typeof RetentionScheduleState];
