/**
 * The audit actions Storage writes.
 *
 * `13-audit-architecture.md` §2 names one action per area with the operation in the payload, and
 * files are one area an investigation asks about on its own: "what was uploaded, by whom, and did
 * it pass the scanner" is a question about bytes, not about the document they later became.
 *
 * **The issuance of every presigned URL is audited, and audited *before* the URL exists.** That is
 * §4's rule and it is not decoration: a signed URL is a capability that outlives the request and
 * can be redeemed by anyone holding it, so the record of who was handed one is the only evidence
 * of how bytes left the system. Writing it afterwards would leave a window in which a URL was
 * issued and nothing says so — and that window is exactly where a failure would hide.
 */
export const StorageAudit = {
  /** An upload target was issued, completed, or abandoned. */
  FILE_UPLOADED: 'FILE_UPLOADED',
  /** A download URL was issued for a stored blob. */
  FILE_DOWNLOAD_ISSUED: 'FILE_DOWNLOAD_ISSUED',
  /** A scan verdict was recorded, clean or otherwise. */
  FILE_SCANNED: 'FILE_SCANNED',
  /**
   * The rolling verifier read a blob back and it did not hash to what was recorded — Phase 18.
   *
   * This action has been in `13-audit-architecture.md` §2's Security group since Phase 0 with the
   * note "Phase 18 — the integrity sweep that would detect one", and nothing had ever written it.
   * It is Storage's rather than Security's for the reason every other action in this file is:
   * each module owns the actions it writes, and the lint rule forbidding a cross-module reach into
   * `domain/` turns that from a convention into a constraint.
   *
   * `AuditOutcome.FAILED`, not `SUCCESS`. The sweep succeeded; the *integrity* did not, and an
   * auditor filtering the trail for failures must find this one.
   */
  INTEGRITY_MISMATCH: 'INTEGRITY_MISMATCH',
} as const;

export type StorageAuditAction = (typeof StorageAudit)[keyof typeof StorageAudit];
