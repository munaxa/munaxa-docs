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
