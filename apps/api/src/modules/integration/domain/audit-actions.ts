/**
 * The audit actions Integration writes — Phase 17.
 *
 * The other half of 13 §2's Integration group; the three that concern *credentials and identity*
 * are Identity's, in `modules/identity/domain/audit-actions.ts`. One group in the catalogue, two
 * files in the code, because each module owns the actions it writes and a cross-module reach into
 * another module's `domain/` is a lint error rather than a convention.
 *
 * Both are separate actions rather than one `INTEGRATION_CHANGED` with the operation in the
 * payload, which is the opposite of `AdministeredWriter`'s usual convention and earns itself on
 * Retention's and Delegation's reasoning: each answers a question somebody asks on its own. "Where
 * do this tenant's events go" and "who can read its trail from outside" are two different
 * investigations, and collapsing them would make one a payload filter over the other.
 */
export const IntegrationAudit = {
  /**
   * A webhook endpoint was created, changed, disabled or removed.
   *
   * The operation is in the payload — this resource genuinely does follow 13 §2's "one action per
   * area" convention, because its four operations are one question: what is this tenant sending,
   * and to where. The **URL** is in the trail deliberately: where a tenant's events go is exactly
   * the fact an investigation into a leak needs. The signing secret is not, for the reason a
   * password hash is not.
   */
  WEBHOOK_ENDPOINT_CHANGED: 'WEBHOOK_ENDPOINT_CHANGED',
  /**
   * The audit sink was configured, changed, removed — or had its cursor moved.
   *
   * The last of those is why the action exists at all rather than riding `CONFIGURATION`: moving a
   * stream's cursor backwards makes a collector re-receive a range, and moving it forwards makes it
   * *skip* one. The second is the one that matters, and a trail that recorded it as "somebody
   * changed some configuration" would not be answering the question an auditor is asking.
   */
  AUDIT_SINK_CHANGED: 'AUDIT_SINK_CHANGED',
} as const;

export type IntegrationAuditAction = (typeof IntegrationAudit)[keyof typeof IntegrationAudit];
