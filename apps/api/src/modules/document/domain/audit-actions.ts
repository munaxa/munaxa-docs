/**
 * The audit actions Document writes.
 *
 * `13-audit-architecture.md` §2 names one action per area with the operation in the payload, and
 * documents are the area the whole product exists to keep a trail of. Three actions rather than
 * one, because they answer three different questions an investigation asks separately:
 *
 * `DOCUMENT_CHANGED` — what was created, retitled, reclassified or removed.
 * `DOCUMENT_MOVED` — where it went, which is the question that also changes who can see it.
 * `DOCUMENT_VIEWED` — who opened it, which is what a confidentiality level's "audit on read" means.
 *
 * The last one is deliberately its own action rather than an operation on the first. A compliance
 * report asking "who has read this" must not have to filter a stream that also contains every
 * rename, and reads outnumber writes by orders of magnitude — grouping them together would make
 * the common query the expensive one.
 */
export const DocumentAudit = {
  /** A document was created, edited, reclassified, deleted or restored. */
  DOCUMENT_CHANGED: 'DOCUMENT_CHANGED',
  /** A document changed folder, and therefore changed the permission chain it resolves through. */
  DOCUMENT_MOVED: 'DOCUMENT_MOVED',
  /** Somebody opened it. Required outright by levels that demand a stated reason. */
  DOCUMENT_VIEWED: 'DOCUMENT_VIEWED',
  /**
   * Somebody was issued a print of it — through the preview path, never the original, so the
   * watermark survives (`14-preview-architecture.md` §4). 13 §2's `PRINTED` row, made real by
   * Phase 7; always written, because 13 says prints are audited unconditionally.
   */
  DOCUMENT_PRINTED: 'DOCUMENT_PRINTED',
} as const;

export type DocumentAuditAction = (typeof DocumentAudit)[keyof typeof DocumentAudit];

/**
 * The revision-control actions, exactly as `13-audit-architecture.md` §2 files them under the
 * Revision area: `CHECKED_OUT`, `CHECKED_IN`, `CHECKOUT_CANCELLED`, `CHECKOUT_FORCED`,
 * `PUBLISHED`, `SUPERSEDED`, `RESTORED_FROM`.
 *
 * Declared in Document's domain rather than Revision's, because the module that performs an
 * act is the module that records it — and every one of these is a Document use case: the lock
 * is Document's own aggregate ("Owns: … check-out Lock"), and publication and restore move the
 * document's lifecycle. Revision implements the row-writing behind Document's port; it decides
 * nothing here and so records nothing.
 *
 * Distinct actions rather than operations on `DOCUMENT_CHANGED`, for the same reason the
 * catalogue names them: "who forced a check-in" and "when did this become effective" are
 * questions a compliance report asks by action, not by filtering a stream of retitles.
 */
export const RevisionControlAudit = {
  /** Somebody took the exclusive claim on producing the next revision. */
  CHECKED_OUT: 'CHECKED_OUT',
  /** A new draft revision exists beneath the published one. */
  CHECKED_IN: 'CHECKED_IN',
  /** The claim was given back; any working draft was discarded, and the payload says so. */
  CHECKOUT_CANCELLED: 'CHECKOUT_CANCELLED',
  /** Somebody with `document:force-checkin` released another person's lock, with a reason. */
  CHECKOUT_FORCED: 'CHECKOUT_FORCED',
  /** This revision became the effective one. */
  PUBLISHED: 'PUBLISHED',
  /** This revision stopped being the effective one, superseded by a newer publication. */
  SUPERSEDED: 'SUPERSEDED',
  /** A new revision was created carrying an older revision's content. */
  RESTORED_FROM: 'RESTORED_FROM',
} as const;

export type RevisionControlAuditAction =
  (typeof RevisionControlAudit)[keyof typeof RevisionControlAudit];
