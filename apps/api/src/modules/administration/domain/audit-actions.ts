/**
 * The audit actions Administration writes.
 *
 * Every name comes from the catalogue in `docs/architecture/13-audit-architecture.md` §2 — the
 * Administration group for configuration and settings, and the Numbering group for a rule change.
 * The catalogue names one action per *area*, and `before`/`after` plus an `operation` in the payload
 * carry what actually happened; a distinct action per resource and per verb would be thirty strings
 * every compliance report would have to learn to say what six and a payload already say.
 *
 * `RULE_CHANGED` is deliberately its own action rather than folded into `POLICY_CHANGED`: a numbering
 * rule decides the identifiers printed on documents, and "when did this series change shape" is a
 * question asked on its own.
 */
export const AdministrationAudit = {
  /** A document type — the policy pack a document is created under. */
  TYPE_CHANGED: 'TYPE_CHANGED',
  /** A metadata field, and the categories documents are classified by. */
  FIELD_CHANGED: 'FIELD_CHANGED',
  /** A retention policy or a confidentiality level: how long, and how sensitive. */
  POLICY_CHANGED: 'POLICY_CHANGED',
  /** A numbering rule. Never renumbers anything that exists. */
  RULE_CHANGED: 'RULE_CHANGED',
  /** One tenant setting. */
  SETTING_CHANGED: 'SETTING_CHANGED',
} as const;

export type AdministrationAuditAction =
  (typeof AdministrationAudit)[keyof typeof AdministrationAudit];
