import {
  Disposition,
  type DispositionKey,
  RetentionScheduleState,
  type RetentionScheduleStateKey,
  RetentionTrigger,
  type RetentionTriggerKey,
} from '@edms/domain';

/**
 * When a record's period ends, and what happens then. Pure.
 *
 * The whole of retention's judgement is in this file, and it is separated from the service for the
 * reason every other domain file in this product is: the decisions here are about dates and
 * dispositions, they are asked the same questions by the sweep, by the recycle bin and by the
 * disposition review, and none of them should have to open a transaction to find out what a policy
 * implies.
 */

/**
 * The policy as the document froze it (`03-domain-model.md` §3, ADR-0010 §7).
 *
 * A copy rather than a reference, because editing a policy must not re-date records already kept
 * under it. The document carries `retention_policy_id`, and everything below is read through that
 * at the moment the trigger fires — after which the schedule row is the fact.
 */
export interface FrozenPolicy {
  readonly id: string;
  readonly trigger: RetentionTriggerKey;
  /** Whole months, because that is how record-keeping regimes are written. */
  readonly periodMonths: number;
  readonly disposition: DispositionKey;
  readonly reviewRequired: boolean;
}

export interface ScheduleProposal {
  readonly triggerAt: Date;
  readonly dueAt: Date;
  readonly disposition: DispositionKey;
  readonly state: RetentionScheduleStateKey;
  readonly reviewRequired: boolean;
  readonly policyId: string | null;
}

/**
 * Adds whole months, keeping the day of the month where the target month has one.
 *
 * `setUTCMonth` alone rolls 31 January + 1 month into 3 March, which would make a retention period
 * silently longer than the policy says for four days of every month. Clamping to the last day of
 * the target month is the reading every record-keeping regime intends by "one month later", and it
 * is the reading two runs of the same sweep agree on.
 */
export function addMonths(from: Date, months: number): Date {
  const year = from.getUTCFullYear();
  const month = from.getUTCMonth() + months;
  const day = from.getUTCDate();
  const lastDayOfTarget = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(day, lastDayOfTarget),
      from.getUTCHours(),
      from.getUTCMinutes(),
      from.getUTCSeconds(),
      from.getUTCMilliseconds(),
    ),
  );
}

export function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 86_400_000);
}

/**
 * What this trigger implies for this document, or null when it implies nothing.
 *
 * Null is a real answer and the common one. A policy fires on *its own* trigger and no other, so a
 * publication does not start the clock on a policy written for supersession; and a document whose
 * type names no policy has nothing to compute from — unless it was deleted and never numbered, in
 * which case the recycle-bin window is its period. That last case is the only place the product
 * schedules a disposition without a policy, and it is deliberate: ADR-0010 §4 requires destruction
 * to run from a schedule rather than from a button, and a draft nobody ever numbered still has to
 * leave the recycle bin eventually.
 */
export function proposeSchedule(input: {
  readonly trigger: RetentionTriggerKey;
  readonly at: Date;
  readonly policy: FrozenPolicy | null;
  /** Null while the document has never been numbered — which is what makes it a draft. */
  readonly documentNumber: string | null;
  readonly recycleBinDays: number;
}): ScheduleProposal | null {
  const { trigger, at, policy, documentNumber, recycleBinDays } = input;

  if (policy !== null && policy.trigger === trigger) {
    if (policy.disposition === Disposition.RETAIN_FOREVER) {
      // A record kept forever has no date to reach, and a row saying "due never" would be a row
      // `listDue` has to keep skipping. The absence of a schedule is the schedule.
      return null;
    }
    return {
      triggerAt: at,
      dueAt: addMonths(at, policy.periodMonths),
      disposition: policy.disposition,
      state: RetentionScheduleState.PENDING,
      reviewRequired: policy.reviewRequired || policy.disposition === Disposition.PURGE,
      policyId: policy.id,
    };
  }

  if (trigger === RetentionTrigger.ON_DELETE && documentNumber === null) {
    return {
      triggerAt: at,
      dueAt: addDays(at, recycleBinDays),
      disposition: Disposition.PURGE,
      state: RetentionScheduleState.PENDING,
      // No review. A draft that was never numbered, never approved and never published is not a
      // record anybody is accountable for, and requiring a person to confirm each one would make
      // the review queue a list of other people's abandoned uploads.
      reviewRequired: false,
      policyId: null,
    };
  }

  return null;
}

/** What the sweep does with a schedule whose date has arrived. */
export const DispositionOutcome = {
  /** A person must confirm. The schedule moves to `IN_REVIEW` and waits. */
  REVIEW: 'REVIEW',
  /** Destroy the content. The audit trail and the number stay. */
  PURGE: 'PURGE',
  /** Move the document out of the live library without destroying it. */
  ARCHIVE: 'ARCHIVE',
  /** A legal hold forbids it, whatever the policy says. */
  BLOCKED: 'BLOCKED',
} as const;

export type DispositionOutcomeKey = (typeof DispositionOutcome)[keyof typeof DispositionOutcome];

/**
 * What to do with a due schedule.
 *
 * The hold is checked *first* and unconditionally, which is ADR-0010 §5's "regardless of policy or
 * permission" expressed as an order of evaluation rather than as a comment. A held document does
 * not enter review either: asking somebody to approve a disposition that cannot run would produce
 * an approval the sweep then refuses, and a queue of them.
 */
export function decideDisposition(input: {
  readonly disposition: DispositionKey;
  readonly state: RetentionScheduleStateKey;
  readonly reviewRequired: boolean;
  readonly held: boolean;
}): DispositionOutcomeKey {
  if (input.held) {
    return DispositionOutcome.BLOCKED;
  }
  if (input.reviewRequired && input.state !== RetentionScheduleState.IN_REVIEW) {
    return DispositionOutcome.REVIEW;
  }
  switch (input.disposition) {
    case Disposition.PURGE:
      return DispositionOutcome.PURGE;
    case Disposition.ARCHIVE:
      return DispositionOutcome.ARCHIVE;
    case Disposition.REVIEW:
      return DispositionOutcome.REVIEW;
    case Disposition.RETAIN_FOREVER:
      // Only reachable for a schedule written before a policy was edited to `RETAIN_FOREVER`.
      // Nothing is destroyed on the strength of a disposition the policy no longer names.
      return DispositionOutcome.REVIEW;
    default:
      return DispositionOutcome.REVIEW;
  }
}

/**
 * Whether a schedule created by a delete should be withdrawn because the delete was undone.
 *
 * Only the schedules a delete created: a document restored from the recycle bin still has whatever
 * its publication scheduled, and cancelling that would hand somebody a way to reset a retention
 * period by deleting and restoring a record.
 */
export function cancelledByRestore(trigger: RetentionTriggerKey): boolean {
  return trigger === RetentionTrigger.ON_DELETE;
}
