import type { MessageKey } from '@edms/i18n';

/**
 * A notification type's key, and the sentence a person reads instead of it.
 *
 * A table rather than a derivation, because a key and a label are different things:
 * `workflow.task-assigned` tells a developer where a notification comes from and tells a user
 * nothing, and mechanically prettifying it — "Workflow task assigned" — would produce a phrase no
 * translator wrote and no reader asked for.
 *
 * It lives on the client rather than on the API for the reason every label in this product does:
 * the catalogue is `@edms/i18n`'s, the API returns identifiers, and a server that returned English
 * would be a server that has to be asked twice for Arabic.
 *
 * An unmapped key falls back to a generic label rather than to the key itself. A type added to the
 * catalogue and forgotten here shows a person "Notification", which is unhelpful; showing them
 * `retention.review-due` is a defect.
 */
const LABELS: Readonly<Record<string, MessageKey>> = Object.freeze({
  'security.sign-in.new-device': 'notifications.type.securityNewDevice',
  'security.password.changed': 'notifications.type.securityPasswordChanged',
  'security.session.revoked': 'notifications.type.securitySessionRevoked',
  'workflow.task-assigned': 'notifications.type.approvalAssigned',
  'workflow.deadline-approaching': 'notifications.type.approvalReminder',
  'workflow.overdue': 'notifications.type.approvalOverdue',
  'document.approved': 'notifications.type.documentApproved',
  'document.rejected': 'notifications.type.documentRejected',
  'document.published': 'notifications.type.documentPublished',
  'document.checked-out': 'notifications.type.documentCheckedOut',
  'document.checked-in': 'notifications.type.documentCheckedIn',
  'delegation.requested': 'notifications.type.delegationRequested',
  'delegation.approved': 'notifications.type.delegationApproved',
  'delegation.revoked': 'notifications.type.delegationRevoked',
  'delegation.expired': 'notifications.type.delegationExpired',
  'retention.review-due': 'notifications.type.retentionReviewDue',
  'retention.hold-placed': 'notifications.type.legalHoldPlaced',
  'retention.hold-released': 'notifications.type.legalHoldReleased',
  'security.file-quarantined': 'notifications.type.fileQuarantined',
  'security.address-suppressed': 'notifications.type.addressSuppressed',
  'audit.chain-broken': 'notifications.type.auditChainBroken',
  // Phase 6.4. Both types have had a producer since Phase 12 and Phase 16 respectively and neither
  // had a label, so the two notifications a person is *most* likely to see after a large operation
  // both rendered as the generic fallback the comment above calls "unhelpful". A digest is the one
  // that arrives in an inbox with no other clue what it is.
  'bulk.operation-completed': 'notifications.type.bulkOperationCompleted',
  'digest.summary': 'notifications.type.digestSummary',
});

export function labelKeyFor(typeKey: string): MessageKey {
  return LABELS[typeKey] ?? 'notifications.type.unknown';
}
