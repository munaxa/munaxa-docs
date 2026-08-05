/**
 * Delegation vocabulary (`docs/architecture/07-workflow-architecture.md` §4).
 *
 * Delegation is a **routing overlay, never a permission grant**. The task stays the delegator's
 * and the delegate acts on it, which is the whole of what makes the audit answer "who actually
 * decided" *and* "for whom". Everything in this file is shaped by that sentence: there is no state
 * in which a delegation confers reach, and every state below describes only whether the overlay is
 * in force.
 */

/**
 * Where a delegation is in its life.
 *
 * Five states rather than a pair of booleans, because a compliance report asks about each of them
 * separately: what is awaiting somebody's approval, what is in force, what somebody refused, what
 * was cut short, and what simply ran out. A `revoked_at IS NOT NULL` on a row that also has an
 * `ends_at` in the past cannot say which of the last two happened, and those are different facts —
 * one is a decision somebody took and the other is a clock.
 */
export const DelegationStatus = {
  /**
   * Created, and not yet in force.
   *
   * The ordinary path: a delegation waits for the delegator's manager, or for a holder of
   * `delegation:manage` who is neither party to it. An emergency delegation never passes through
   * this state, which is exactly what "emergency" means here.
   */
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  /** Approved — or declared as an emergency. In force during its period and not after it. */
  ACTIVE: 'ACTIVE',
  /** An approver refused it. Terminal, and it keeps the stated ground. */
  DECLINED: 'DECLINED',
  /** Ended before its end date. Immediate: in-flight tasks revert to the delegator (§4). */
  REVOKED: 'REVOKED',
  /** Its end date passed. Recorded by the sweep; never the thing that makes it inert. */
  EXPIRED: 'EXPIRED',
} as const;

export type DelegationStatusKey = (typeof DelegationStatus)[keyof typeof DelegationStatus];

/**
 * The states in which a delegation could still authorise something.
 *
 * `ACTIVE` alone. `PENDING_APPROVAL` has not been agreed to, and the three terminal states are
 * terminal. Exported because both the authority predicate and the chain walk need the same answer,
 * and two lists that must agree are one list.
 */
export const LIVE_DELEGATION_STATUSES: readonly DelegationStatusKey[] = Object.freeze([
  DelegationStatus.ACTIVE,
]);

/**
 * How a delegation came to be in force.
 *
 * The distinction exists because an emergency delegation *bypasses the approval an ordinary one
 * requires*, and something has to say so afterwards. It is a column rather than an inference from
 * "was it ever `PENDING_APPROVAL`", because the trail must answer the question without replaying
 * the row's history — and because the row is what the delegation screens filter on.
 *
 * What the column is deliberately **not** is the whole of that record. The audit event for an
 * emergency delegation carries its stated ground in `audit_event.reason` — the trail's own column,
 * which Phase 9's digest attests — rather than only in a payload field. A payload field is
 * attested as part of a blob the verifier cannot address; the reason column is addressable, and a
 * bypass of a control is exactly the thing that must be attested rather than merely stored.
 */
export const DelegationKind = {
  /** Requested, then approved by somebody who is not a party to it. */
  STANDARD: 'STANDARD',
  /**
   * Declared without approval, bounded much more tightly, and always with a stated ground.
   *
   * Whatever it bypasses, it does not bypass the audit: it is created with a reason, that reason
   * lands in the attested column, and the period is capped by its own setting rather than by the
   * ordinary one.
   */
  EMERGENCY: 'EMERGENCY',
} as const;

export type DelegationKindKey = (typeof DelegationKind)[keyof typeof DelegationKind];

/**
 * Why a delegation stopped authorising, when the answer is not simply "it is not `ACTIVE`".
 *
 * Returned by `authorityFor` so a refusal can say *which* rule refused, and a refusal at decision
 * time can be told apart from one at creation. §4 puts the authority check at decision time and
 * not at creation precisely so that the second kind exists; without a named reason it would be
 * indistinguishable from "there is no delegation", which is what an approver would then be told.
 */
export const DelegationRefusal = {
  /** No delegation from this person to this one, in any state. */
  NONE: 'NONE',
  /** There is one, and it is not in force — pending, declined, revoked or expired. */
  NOT_IN_FORCE: 'NOT_IN_FORCE',
  /** In force, but the instant asked about is outside its period. */
  OUTSIDE_PERIOD: 'OUTSIDE_PERIOD',
  /** In force and current, but it does not name the permission being exercised. */
  PERMISSION_NOT_DELEGATED: 'PERMISSION_NOT_DELEGATED',
  /**
   * In force, current, and names the permission — but the **delegator** no longer holds it.
   *
   * §4's central rule made a value: "a delegate can never exercise more than the delegator holds,
   * checked at decision time, not at creation". A delegation created while the delegator held
   * `document:approve` refuses the moment their role is edited, and this is what it refuses with.
   */
  DELEGATOR_LACKS_AUTHORITY: 'DELEGATOR_LACKS_AUTHORITY',
} as const;

export type DelegationRefusalKey = (typeof DelegationRefusal)[keyof typeof DelegationRefusal];
