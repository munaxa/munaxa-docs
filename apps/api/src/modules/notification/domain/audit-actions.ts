/**
 * The one audit action Notification writes — `13-audit-architecture.md` §2's Security group.
 *
 * ## Why there is one, and why there is only one
 *
 * 13 §2 named no Notification group and attributed no row to Phase 12, so this phase had to
 * decide whether any notification act belongs in the trail at all. Most do not, and the reason is
 * 18 §8's second prohibition: a notification is **never the only record of anything**. Every fact
 * a notification carries is already an audited act — a document was approved, a delegation was
 * revoked, a chain failed verification — so an audit row saying "and we told somebody" would be a
 * second entry per event, on a table that already carries one per document view, answering no
 * question the first does not.
 *
 * Suppressing an address is the exception, and it is the one the phase brief predicted. It is not
 * a record of somebody being told; it is a record of somebody **ceasing to be told**. Nothing
 * else in the product writes it down: the messages that follow are `SUPPRESSED` rows in a table
 * nobody reads for compliance, and the state that caused them is one column on one row that an
 * administrator may clear at any time. "When did this account stop receiving mail, and on what
 * grounds" would otherwise be unanswerable — and it is exactly the question asked after somebody
 * says they were never told about an approval.
 *
 * The action is filed in the **Security** group rather than a new Notification one, because the
 * catalogue "names one action per area, not one per resource and verb", and one row does not make
 * an area. It sits beside `SESSION_REVOKED` for the same reason: both are the product deciding to
 * stop doing something for an account, on evidence, without the account's consent.
 *
 * The stated ground — the provider's own bounce reason — goes in the trail's own `reason` column
 * rather than a payload field, where Phase 9's widened digest attests it and a verifier can
 * address it. The address is **masked** in both the reason and the payload: 13 §3 requires
 * payloads to minimise personal data, and an administrator needs to recognise which mailbox
 * stopped working, not to find a copy of the directory in the audit trail.
 */
export const NotificationAudit = {
  /**
   * An email address was suppressed after repeated permanent failures (18 §7).
   *
   * Written once, on the crossing, by `DeliveryService` — never on each subsequent bounce, which
   * would make the trail's answer to "how many addresses have we suppressed" a count of bounces.
   */
  SUPPRESSED: 'NOTIFICATION_SUPPRESSED',

  /**
   * A tenant edited the wording of a notification (18 §6).
   *
   * Deliberately **the Administration group's `SETTING_CHANGED`**, not a Notification action of
   * its own: 13 §2 "names one action per area, not one per resource and verb", and a template is
   * tenant configuration in exactly the way a setting is. Declared here rather than imported from
   * Administration because a module may not reach into another module's internals — the *string*
   * is the catalogue's, and the catalogue is a document rather than a file.
   */
  TEMPLATE_CHANGED: 'SETTING_CHANGED',
} as const;

export type NotificationAuditAction = (typeof NotificationAudit)[keyof typeof NotificationAudit];
