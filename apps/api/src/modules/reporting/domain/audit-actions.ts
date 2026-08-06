// Each catalogue below `satisfies Record<string, DocsAuditAction>`: the audit writer is typed to
// the union of all thirteen modules' catalogues, and that assertion is what keeps them in step.
import type { DocsAuditAction } from '@edms/domain';

/**
 * The one audit action this phase writes.
 *
 * `13-audit-architecture.md` §2's Export group has three rows. Phase 9 wrote two of them and named
 * the third as this phase's in its own `audit-actions.ts`: *"`REPORT_EXPORTED` belongs to the
 * reporting phase, which is what will have a report to export"*. This is that file, and it has
 * exactly one entry.
 *
 * **No action for running a report**, and that is a decision rather than an omission. A report is a
 * read, and this product already decided what a read costs the trail: Phase 9 buffers read auditing
 * for documents above a confidentiality rank, and Phase 13 recorded that a dashboard load writes
 * nothing because *"a count is not a read of a document"*. The same is true here — a report opens no
 * record and returns no bytes — and a row per page of every report would put one event per scroll
 * into a table that already carries one per document view, answering no question the underlying
 * acts do not. What the *export* does is different in kind: it produces a file that leaves the
 * product and can be redeemed later by whoever holds the link, which is why it is the act that is
 * recorded.
 *
 * **And no second action for taking the file.** Phase 9 wrote `BULK_DOWNLOAD` beside
 * `AUDIT_EXPORTED` because an evidence bundle is three artefacts signed as a set, and handing them
 * over is a distinct compliance fact. A report export is one file stored as one `file_object`, and
 * `FILE_DOWNLOAD_ISSUED` — written by Storage's own `createDownloadUrl`, which this phase goes
 * through rather than around — is already the row for "a signed URL for these bytes was issued to
 * somebody". Adding a second would give one act two names in the trail, which 13 §2's reconciliation
 * exists to prevent.
 */
export const ReportingAudit = {
  /**
   * A report export was requested, and later that it completed or failed.
   *
   * Written twice for two facts, exactly as `AUDIT_EXPORTED` is: the request is somebody's act and
   * the completion is the system's, and a single row written at the end would leave a window in
   * which a report was being assembled for somebody and nothing said so.
   *
   * The first row carries **the parameters that produced it**. That is the difference between a
   * trail that records an export and one that records *which* export: "Ada exported the deleted
   * documents report" is not answerable six months later without the library, the date range and
   * the status that narrowed it, and those are the fields an investigation asks about.
   */
  REPORT_EXPORTED: 'REPORT_EXPORTED',
} as const satisfies Record<string, DocsAuditAction>;

export type ReportingAuditAction = (typeof ReportingAudit)[keyof typeof ReportingAudit];
