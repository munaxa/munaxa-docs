/**
 * Every action this product writes to the audit trail, as one closed union.
 *
 * ## Why this is here and not in `core/audit`
 *
 * Each module already owns its own catalogue in `modules/<module>/domain/audit-actions.ts`, and
 * those stay the authoring surface: an action is declared beside the code that emits it, with the
 * paragraph explaining why it earned a name of its own. But the audit writer has to be typed to
 * *all* of them at once, and there is no file in `apps/api` that may import them all — `core/` may
 * not depend on a module, and a module may not reach into another module's `domain/`. Both rules
 * are enforced in `eslint.config.mjs`, and both are right. So the union lives in the one package
 * every layer may import.
 *
 * ## Why the literals are repeated rather than derived
 *
 * Deriving the union would mean moving thirteen catalogues out of the modules that own them, and
 * the catalogues carry the reasoning for the vocabulary — why `RULE_CHANGED` is not a
 * `POLICY_CHANGED`, why a delegation is not a user. Relocating that to a shared package to save a
 * list of strings would cost more than it saves.
 *
 * The duplication cannot drift, because each module's catalogue asserts conformance to this union
 * with `satisfies Record<string, DocsAuditAction>`. An action added to a module and not added here
 * is a compile error in that module, at the line that added it.
 *
 * ## Why a union at all
 *
 * `@munaxa/audit`'s `AuditService<TName>` is parameterised by the event vocabulary, so the writer,
 * the repository port and the sealer all carry this type end to end. A typo in an action name is a
 * compile error rather than a row in the trail that no report will ever match, and the trail is
 * append-only — a misspelled action cannot be corrected after the fact.
 */
export const DOCS_AUDIT_ACTIONS = [
  // Administration — configuration, and the numbering series.
  'TYPE_CHANGED',
  'FIELD_CHANGED',
  'POLICY_CHANGED',
  'RULE_CHANGED',
  'SETTING_CHANGED',
  'ROUTING_CHANGED',
  'NUMBER_RESERVED',
  'NUMBER_ASSIGNED',
  'NUMBER_VOIDED',

  // Audit — the trail's own acts.
  'AUDIT_EXPORTED',
  'BULK_DOWNLOAD',

  // Authorization and bulk. Declared in `core/`, because a denial and a bulk run are recorded by
  // machinery every module shares rather than by a module of their own.
  'ACCESS_DENIED',
  'BULK_OPERATION',

  // Document, and revision control.
  'DOCUMENT_CHANGED',
  'DOCUMENT_MOVED',
  'DOCUMENT_VIEWED',
  'DOCUMENT_PRINTED',
  'DOCUMENT_SIGNED',
  'DOCUMENT_TEMPLATE_CHANGED',
  'CHECKED_OUT',
  'CHECKED_IN',
  'CHECKOUT_CANCELLED',
  'CHECKOUT_FORCED',
  'PUBLISHED',
  'SUPERSEDED',
  'RESTORED_FROM',

  // Identity — security, administration, delegation, and the Phase 17 integrations.
  'LOGIN_SUCCEEDED',
  'LOGIN_FAILED',
  'SESSION_REVOKED',
  'PASSWORD_CHANGED',
  'MFA_ENROLLED',
  'MFA_FAILED',
  'USER_CREATED',
  'USER_CHANGED',
  'USER_DISABLED',
  'ROLE_ASSIGNED',
  'ROLE_PERMISSION_CHANGED',
  'DELEGATION_CREATED',
  'DELEGATION_USED',
  'DELEGATION_REVOKED',
  'DELEGATION_EXPIRED',
  'API_CLIENT_CREATED',
  'API_CLIENT_REVOKED',
  'IDENTITY_PROVIDER_CHANGED',
  'USER_PROVISIONED_FROM_PROVIDER',
  'TENANT_PROVISIONED',

  // Integration.
  'WEBHOOK_ENDPOINT_CHANGED',
  'AUDIT_SINK_CHANGED',

  // Library and access control.
  'LIBRARY_CHANGED',
  'FOLDER_CHANGED',
  'ACL_GRANTED',
  'ACL_REVOKED',
  'INHERITANCE_BROKEN',

  // Notification.
  'NOTIFICATION_SUPPRESSED',

  // Organization.
  'ORG_CHANGED',

  // Reporting.
  'REPORT_EXPORTED',

  // Retention.
  'SCHEDULE_SET',
  'HOLD_PLACED',
  'HOLD_RELEASED',
  'DISPOSITION_APPROVED',
  'PURGE_EXECUTED',
  'PURGED',

  // Search.
  'SEARCH_PERFORMED',
  'SEARCH_REBUILD_REQUESTED',

  // Storage.
  'FILE_UPLOADED',
  'FILE_DOWNLOAD_ISSUED',
  'FILE_SCANNED',
  'INTEGRITY_MISMATCH',

  // Workflow.
  'WORKFLOW_PUBLISHED',
  'WORKFLOW_CHANGED',
  'SUBMITTED',
  'STAGE_ACTIVATED',
  'APPROVED',
  'REJECTED',
  'CHANGES_REQUESTED',
  'ESCALATED',
  'AUTO_APPROVED',
  'WITHDRAWN',
  'WORKFLOW_PAUSED',
  'TIMER_FIRED',
] as const;

/**
 * The audit vocabulary, as a type.
 *
 * Two modules deliberately share a name: `SETTING_CHANGED` is written by both Administration and
 * Notification, and `DELEGATION_USED` by both Identity and Workflow. They are one action in the
 * trail — "a setting changed", "an authority was exercised" — and the subject type says which. A
 * union does not care that two catalogues reach the same member.
 */
export type DocsAuditAction = (typeof DOCS_AUDIT_ACTIONS)[number];

export function isDocsAuditAction(value: string): value is DocsAuditAction {
  return (DOCS_AUDIT_ACTIONS as readonly string[]).includes(value);
}
