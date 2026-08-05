/**
 * The audit actions Identity writes.
 *
 * Named constants rather than string literals at the call site, because these strings are read
 * by compliance reports and evidence exports years after they are written: a typo is not a bug
 * that surfaces, it is a gap in an audit trail that nobody notices.
 *
 * The names come from the Security group of the catalogue in
 * `docs/architecture/13-audit-architecture.md` §2. Each module owns the actions it writes.
 */
export const SecurityAudit = {
  LOGIN_SUCCEEDED: 'LOGIN_SUCCEEDED',
  LOGIN_FAILED: 'LOGIN_FAILED',
  SESSION_REVOKED: 'SESSION_REVOKED',
  PASSWORD_CHANGED: 'PASSWORD_CHANGED',
} as const;

export type SecurityAuditAction = (typeof SecurityAudit)[keyof typeof SecurityAudit];

/**
 * The actions administering people and access writes.
 *
 * `USER_CREATED` and `USER_DISABLED` come from the Administration group of the catalogue and
 * `ROLE_ASSIGNED` and `ROLE_PERMISSION_CHANGED` from the Permission group — the two events the
 * catalogue names for this area precisely because they are the ones an investigation asks about
 * ("who gave them that", "when did this account start working").
 *
 * `USER_CHANGED` is not in the catalogue's table, and it is here rather than folded into
 * `USER_CREATED` because the catalogue's own convention is one action per *kind of thing that
 * happened*: an account being created, disabled, and having its address changed are three different
 * questions an auditor asks, and answering the third by filtering the payloads of the first would
 * make it the only question in the trail that needs a payload filter to answer.
 */
export const IdentityAdminAudit = {
  USER_CREATED: 'USER_CREATED',
  USER_CHANGED: 'USER_CHANGED',
  USER_DISABLED: 'USER_DISABLED',
  /** A role was granted to or withdrawn from somebody. */
  ROLE_ASSIGNED: 'ROLE_ASSIGNED',
  /** A role's permission set changed, which changes what everyone holding it may do. */
  ROLE_PERMISSION_CHANGED: 'ROLE_PERMISSION_CHANGED',
} as const;

export type IdentityAdminAuditAction = (typeof IdentityAdminAudit)[keyof typeof IdentityAdminAudit];

/**
 * The Delegation group of `13-audit-architecture.md` §2, whose four rows §2's ownership table
 * attributes to Phase 11. All four are written; none is invented.
 *
 * The four are separate actions rather than one `DELEGATION_CHANGED` with an operation in the
 * payload — which is the catalogue's usual shape — for the reason Retention's five are: each is
 * the answer to a question somebody asks on its own. "Who was covering for whom last quarter",
 * "what was decided under a delegation", "which arrangements were cut short and by whom", and
 * "which simply ran out" are four different reports, and collapsing them would make three of them
 * payload filters.
 *
 * Two things this group deliberately does **not** have.
 *
 * **No fifth action for an emergency delegation.** §2's catalogue names four and the code writes
 * four; growing a `DELEGATION_DECLARED` would put the product's vocabulary ahead of the document
 * that defines it. The emergency path is distinguished instead by something stronger than a name:
 * its `DELEGATION_CREATED` event carries the stated ground in the trail's own `reason` column —
 * the column Phase 9's widened digest attests, and which the verifier can address — where an
 * ordinary delegation's is null. A bypass of a control recorded in an attested column is a better
 * record than a bypass recorded in a fifth string.
 *
 * **No action for a declined request.** A delegation that was never in force authorised nothing,
 * and the refusal is on the row with its stated ground. The catalogue has four rows and this is
 * the one place where following it costs something; it is recorded here rather than worked around.
 */
export const DelegationAudit = {
  /** A delegation exists. `PENDING_APPROVAL`, or `ACTIVE` when it was declared as an emergency. */
  DELEGATION_CREATED: 'DELEGATION_CREATED',
  /**
   * Somebody took a decision under a delegation.
   *
   * Written per decision, in the same transaction as the decision's own `APPROVED` or `REJECTED`
   * event, through `AdministeredWriter.record`. It is filed against the **delegation** rather than
   * the task, which is what makes "everything done under this arrangement" a trail query on one
   * subject rather than a join through `approval_task` — and it is what *attests* the link, since
   * Phase 9's digest covers `on_behalf_of_id` but not the foreign key added by this phase.
   */
  DELEGATION_USED: 'DELEGATION_USED',
  /** Ended before its end date. In-flight tasks revert to the delegator from this instant (§4). */
  DELEGATION_REVOKED: 'DELEGATION_REVOKED',
  /**
   * Its period ended.
   *
   * Written by the nightly sweep, and never the thing that makes the delegation inert — the
   * authority predicate is. The event exists so the trail can answer "which delegations ended last
   * quarter" without the answer depending on whether anybody happened to look.
   */
  DELEGATION_EXPIRED: 'DELEGATION_EXPIRED',
} as const;

export type DelegationAuditAction = (typeof DelegationAudit)[keyof typeof DelegationAudit];
