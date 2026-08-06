// Each catalogue below `satisfies Record<string, DocsAuditAction>`: the audit writer is typed to
// the union of all thirteen modules' catalogues, and that assertion is what keeps them in step.
import type { DocsAuditAction } from '@edms/domain';

/**
 * The audit actions Phase 9 writes, and the catalogue rows it is answerable for.
 *
 * `13-audit-architecture.md` §2's Export group is this phase's, and only two of its three rows
 * are: `AUDIT_EXPORTED` and `BULK_DOWNLOAD` are written here, and `REPORT_EXPORTED` belongs to
 * the reporting phase, which is what will have a report to export. Naming that split here is the
 * point — a catalogue row with no writer and no owner reads as an oversight, and the ones this
 * phase leaves are deliberate.
 *
 * `ACCESS_DENIED` is also this phase's, and it is not here: it is written by the guard that
 * denies, in `core/authorization/`, because the module that performs an act is the module that
 * records it and no domain module performs a refusal.
 */
export const AuditAudit = {
  /**
   * An evidence bundle was requested, and later that it completed or failed.
   *
   * 13 §6 requires the export itself to be audited, and it is audited twice for two facts: the
   * request is somebody's act, and the completion is the system's. A single row written at the
   * end would leave a window in which a range of the trail had been assembled for somebody and
   * nothing said so — the same reasoning that makes `FILE_DOWNLOAD_ISSUED` precede its URL.
   */
  AUDIT_EXPORTED: 'AUDIT_EXPORTED',
  /**
   * A bundle's artefacts were handed to somebody as signed URLs.
   *
   * Distinct from `AUDIT_EXPORTED` because producing evidence and *taking* it are two acts, and
   * the second can happen repeatedly, days later, by whoever holds the link. The trail records
   * every issuance, exactly as it does for a document's bytes.
   */
  BULK_DOWNLOAD: 'BULK_DOWNLOAD',
} as const satisfies Record<string, DocsAuditAction>;

export type AuditAuditAction = (typeof AuditAudit)[keyof typeof AuditAudit];
