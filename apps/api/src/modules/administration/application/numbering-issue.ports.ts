import type {
  DocumentId,
  DocumentTypeId,
  NumberOriginKey,
  NumberReservationId,
  NumberReservationStateKey,
  NumberingRuleId,
  SequenceResetScopeKey,
  WorkflowInstanceId,
} from '@edms/domain';
import type { Page, PageRequest } from '@edms/utils';

import type { NumberSegment } from '../domain/numbering';

/**
 * What issuing a number reads and writes.
 *
 * Separate from `CONFIGURATION_REPOSITORY` because the two answer different masters: that one
 * serves the administration screens and carries counts and soft-delete choreography; this one
 * serves the hot path inside an approval's transaction, and everything in it is shaped by the
 * locking rules in `09-numbering-architecture.md` §2.
 */
export const NUMBER_ISSUE_REPOSITORY = Symbol('NumberIssueRepository');

/** A rule as the formatter needs it — shape and flags, nothing administrative. */
export interface IssuableRule {
  readonly id: NumberingRuleId;
  readonly separator: string;
  readonly segments: readonly NumberSegment[];
  readonly resetScope: readonly SequenceResetScopeKey[];
  readonly reserveOnSubmit: boolean;
  readonly strictGapless: boolean;
}

export interface ReservationRecord {
  readonly id: NumberReservationId;
  readonly numberingRuleId: NumberingRuleId;
  readonly scopeKey: string;
  readonly sequenceValue: bigint;
  readonly formatted: string;
  readonly state: NumberReservationStateKey;
  readonly origin: NumberOriginKey;
  readonly documentId: DocumentId | null;
  readonly workflowInstanceId: WorkflowInstanceId | null;
  readonly reservedAt: Date;
  readonly assignedAt: Date | null;
  readonly voidedAt: Date | null;
  readonly voidReason: string | null;
  readonly note: string | null;
}

export interface NewReservation {
  readonly id: string;
  readonly numberingRuleId: NumberingRuleId;
  readonly scopeKey: string;
  readonly sequenceValue: bigint;
  readonly formatted: string;
  readonly state: NumberReservationStateKey;
  readonly origin: NumberOriginKey;
  readonly documentId: string | null;
  readonly workflowInstanceId: string | null;
  readonly reservedAt: Date;
  readonly assignedAt: Date | null;
  readonly note: string | null;
}

export interface ReservationListRequest extends PageRequest {
  readonly state?: NumberReservationStateKey | undefined;
}

export interface NumberIssueRepository {
  /** The live rule, or null — deleted rules issue nothing. */
  ruleShape(id: NumberingRuleId): Promise<IssuableRule | null>;
  /** Which rule a live document type numbers under. */
  ruleIdForDocumentType(documentTypeId: DocumentTypeId): Promise<NumberingRuleId | null>;

  /**
   * Claims the next value of a series, creating the counter on first use.
   *
   * One statement: an upsert whose conflict arm increments, which takes the same row lock
   * `SELECT … FOR UPDATE` would and holds it for the microseconds until the transaction commits.
   * Two draws in one series serialise on that lock; two series never touch. The value is never
   * given out twice and never decremented — not on rollback (the transaction that rolled back
   * takes its claim with it), not on rejection (the claim stands and the reservation is voided).
   *
   * This lock is deliberately the **last** one its transaction takes (§2): the callers hold
   * their instance and document rows first, so the counter — the one row every approval in a
   * series shares — is held for the shortest possible tail of each transaction.
   */
  claimNext(input: {
    readonly numberingRuleId: NumberingRuleId;
    readonly scopeKey: string;
    readonly freshId: string;
    readonly at: Date;
  }): Promise<bigint>;

  /**
   * Moves a series past a supplied value, creating the counter if it never drew (§3). Never
   * moves it backwards: `GREATEST` on the conflict arm, so importing an old number under a live
   * series is a no-op on the counter and the uniqueness constraints alone judge the value.
   */
  fastForward(input: {
    readonly numberingRuleId: NumberingRuleId;
    readonly scopeKey: string;
    readonly past: bigint;
    readonly freshId: string;
    readonly at: Date;
  }): Promise<void>;

  insertReservation(reservation: NewReservation): Promise<void>;
  reservationById(id: NumberReservationId): Promise<ReservationRecord | null>;
  /** The live `RESERVED` row an approval holds — at most one, by partial unique index. */
  reservationForInstance(workflowInstanceId: WorkflowInstanceId): Promise<ReservationRecord | null>;
  pendingFormattedForDocument(documentId: DocumentId): Promise<string | null>;
  findByFormatted(formatted: string): Promise<ReservationRecord | null>;

  /**
   * Moves a claimable row to `ASSIGNED`, only from the named states. Zero rows matched means
   * somebody got there first or the row is not claimable — the caller treats both as refusal.
   */
  markAssigned(input: {
    readonly id: NumberReservationId;
    readonly documentId: string;
    readonly at: Date;
    readonly from: readonly NumberReservationStateKey[];
  }): Promise<boolean>;
  markVoided(input: {
    readonly id: NumberReservationId;
    readonly reason: string;
    readonly at: Date;
    readonly from: readonly NumberReservationStateKey[];
  }): Promise<boolean>;

  /** A rule's reservations, newest first — the admin screen's read. */
  listReservations(
    numberingRuleId: NumberingRuleId,
    request: ReservationListRequest,
  ): Promise<Page<ReservationRecord>>;
}
