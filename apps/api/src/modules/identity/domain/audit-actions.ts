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
  /**
   * A second factor was enrolled, or removed — Phase 14's, and one of the two rows 13 §2's
   * ownership table attributes to this phase.
   *
   * **One action for both directions**, with the direction in the payload, which is the catalogue's
   * own convention ("one action per area, the operation in the payload"). It is also the honest
   * shape here: enrolling and un-enrolling are the same question asked from two sides — "what
   * factors does this account have, and since when" — and a second action would make the second
   * half of that a payload filter over the first.
   *
   * `MFA_DISABLED` was considered and rejected for that reason and one more: §2 names
   * `MFA_ENROLLED` and does not name a counterpart, and growing the catalogue's vocabulary in the
   * code before the document is how the two drift.
   */
  MFA_ENROLLED: 'MFA_ENROLLED',
  /**
   * A challenge was refused — 13 §2's other row for this phase.
   *
   * Written for a wrong code, a replayed one, and an attempt against an enrolment already locked
   * out by repeated failures; the reason code distinguishes them and the code that was tried is
   * never recorded. Separate from `LOGIN_FAILED` because they answer different questions: the first
   * is "somebody does not know the password", the second is "somebody knows the password and not
   * the factor", and collapsing them would hide the only signal that says a password has leaked.
   */
  MFA_FAILED: 'MFA_FAILED',
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

/**
 * The Integration group — Phase 17, and 13 §2 gains it.
 *
 * **Four actions rather than one `INTEGRATION_CHANGED` with the operation in the payload**, which
 * is the opposite of the convention `IdentityAdminAudit` and `AdministeredWriter` follow, so the
 * departure has to earn itself. It does, on Retention's and Delegation's reasoning: each is the
 * answer to a question somebody asks on its own, and three of the four are security events rather
 * than configuration changes.
 *
 * "Which keys were issued last quarter, to act as whom" is the question an access review asks, and
 * it is a different question from "where does this tenant send its events". "When did we start
 * federating, and which groups map to the administrator role" is what an auditor asks about
 * privilege. Collapsing them would make all three payload filters over one action — and the one
 * that matters most, `API_CLIENT_CREATED`, would be indistinguishable at a glance from somebody
 * renaming a webhook.
 *
 * `API_CLIENT_CREATED` and `API_CLIENT_REVOKED` are separated for the reason `DELEGATION_CREATED`
 * and `DELEGATION_REVOKED` are: a credential's issue and its withdrawal are the two ends of a
 * period, and an access review reads both columns.
 *
 * **Only the three this module writes are here.** `WEBHOOK_ENDPOINT_CHANGED` and
 * `AUDIT_SINK_CHANGED` live in `modules/integration/domain/audit-actions.ts`, because the rule
 * this file's own opening states is *each module owns the actions it writes* — and the lint rule
 * that forbids a cross-module reach into `domain/` is what turned that from a convention into a
 * constraint. The two files are one group in 13 §2's catalogue and two files in the code, which is
 * the same shape `SecurityAudit` and `IdentityAdminAudit` already have.
 */
export const IntegrationAudit = {
  /**
   * A machine credential was issued.
   *
   * The payload names the subject it acts as and the scopes it carries — which together are the
   * whole of what it can do — and **never the secret**. It is the highest-privilege act in this
   * group by some distance: a key bound to a tenant administrator is, in effect, that
   * administrator without a second factor.
   */
  API_CLIENT_CREATED: 'API_CLIENT_CREATED',
  API_CLIENT_REVOKED: 'API_CLIENT_REVOKED',
  /**
   * The tenant's identity provider was configured or changed.
   *
   * One action for the resource because its interesting field — the role mapping — is a `before`
   * and an `after` that the trail already carries, and "who made the Entra group `all-staff` map
   * to `TENANT_ADMIN`" is answered by reading them rather than by a second action name.
   */
  IDENTITY_PROVIDER_CHANGED: 'IDENTITY_PROVIDER_CHANGED',
  /**
   * A federated sign-in provisioned a person who did not exist here.
   *
   * Written by the JIT path and not by ordinary user administration, because they are genuinely
   * different facts: `USER_CREATED` means an administrator decided somebody should have an
   * account, and this means a *provider assertion* did. The payload names the provider, the
   * external subject and the roles the mapping produced — so "which accounts did we create
   * because Entra said so, and what did the mapping give them" is one query.
   */
  USER_PROVISIONED_FROM_PROVIDER: 'USER_PROVISIONED_FROM_PROVIDER',
} as const;

export type IntegrationAuditAction = (typeof IntegrationAudit)[keyof typeof IntegrationAudit];
