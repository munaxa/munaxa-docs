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
} as const;

export type StorageAuditAction = (typeof StorageAudit)[keyof typeof StorageAudit];
