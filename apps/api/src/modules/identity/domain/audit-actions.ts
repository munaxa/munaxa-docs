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
} as const;

export type SecurityAuditAction = (typeof SecurityAudit)[keyof typeof SecurityAudit];
