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
} as const;

export type DocumentAuditAction = (typeof DocumentAudit)[keyof typeof DocumentAudit];
