// Each catalogue below `satisfies Record<string, DocsAuditAction>`: the audit writer is typed to
// the union of all thirteen modules' catalogues, and that assertion is what keeps them in step.
import type { DocsAuditAction } from '@edms/domain';

/**
 * The audit actions Retention writes — `13-audit-architecture.md` §2's Retention group, plus the
 * Document group's `PURGED`, which §2's ownership table attributes to this phase.
 *
 * Five of the six are the catalogue's Retention rows verbatim. They are separate actions rather
 * than operations on one, because each is the answer to a question a compliance report asks on its
 * own: when the clock started, when it was suspended, when it resumed, who authorised the
 * destruction, and that it was carried out. Collapsing them into `RETENTION_CHANGED` with an
 * operation in the payload — which is the catalogue's default shape — would make "show me every
 * disposition somebody approved last year" a payload filter, and that is precisely the query an
 * auditor arrives with.
 *
 * `PURGED` and `PURGE_EXECUTED` are both written, by one act, and that is deliberate rather than
 * duplication. They have different subjects and answer to different readers: `PURGED` is filed
 * against the **document**, so it is the last entry on that document's own timeline and reads as
 * "this record was destroyed on this date"; `PURGE_EXECUTED` is the **retention** act, filed
 * against the same subject but carrying the schedule, the policy and who approved the disposition,
 * which is what a records-management report reconciles against the policy register. §2 lists both,
 * in two groups, and the two groups are two audiences.
 */
export const RetentionAudit = {
  /** A disposition date was set — or withdrawn — for a document. */
  SCHEDULE_SET: 'SCHEDULE_SET',
  /** Disposition is suspended, regardless of policy or permission (ADR-0010 §5). */
  HOLD_PLACED: 'HOLD_PLACED',
  /** The suspension ended and the schedule resumed. */
  HOLD_RELEASED: 'HOLD_RELEASED',
  /** A person confirmed a disposition the policy had already scheduled. */
  DISPOSITION_APPROVED: 'DISPOSITION_APPROVED',
  /** The disposition ran: what it removed, and what it deliberately left behind. */
  PURGE_EXECUTED: 'PURGE_EXECUTED',
  /**
   * The document's own last event.
   *
   * Its payload carries the document number, because after this the row that held the number is
   * gone. `13 §6` requires the trail to stay "with the document number preserved so the record is
   * still meaningful", and a payload is the only part of an audit row that can carry it — which is
   * why the tombstone exists as well, for the events written *before* this one.
   */
  PURGED: 'PURGED',
} as const satisfies Record<string, DocsAuditAction>;

export type RetentionAuditAction = (typeof RetentionAudit)[keyof typeof RetentionAudit];
