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
  /**
   * Somebody put their name to a revision's exact bytes — Phase 16, and 13 §2's one new Document
   * row.
   *
   * Its own action rather than an operation on `DOCUMENT_CHANGED`, and argued in
   * [ADR-0017](../../../../../../docs/architecture/adr/0017-electronic-signature-as-witnessed-attestation.md)
   * §8 rather than assumed. The alternative was to overload `APPROVED`, which would make "which
   * approvals were signed" — the one question the whole capability exists to answer —
   * unanswerable. A withdrawal writes this action too, with `operation: DELETED` and the stated
   * ground in the trail's own attested `reason` column.
   */
  DOCUMENT_SIGNED: 'DOCUMENT_SIGNED',
  /**
   * A controlled starting point was created, edited or withdrawn — Phase 16.
   *
   * Filed under Document rather than as an `Administration` `TYPE_CHANGED`, because a template
   * produces documents and the question "where did this document's content come from" is a
   * document question. `CONFIGURATION` is its subject type: a template is configuration, and
   * filing it under `DOCUMENT` would put it on the timeline of no document at all.
   */
  DOCUMENT_TEMPLATE_CHANGED: 'DOCUMENT_TEMPLATE_CHANGED',
  /**
   * The record left the live shelf — Phase 6.1, and the first of the two rows
   * `13-audit-architecture.md` §2 has listed as *owing* since Phase 9.
   *
   * Its own action rather than a `DOCUMENT_CHANGED` with `operation: UPDATED`, and the reason is
   * the one §2 gives for every split in this file: "which records were retired last quarter" is a
   * question a records-management report asks by itself, and answering it by filtering a stream
   * that also contains every retitle makes the common query the expensive one. It is also the
   * question an ISO 9001 surveillance audit opens with.
   *
   * **Written by both archive paths**, which is the point of the row rather than an accident. An
   * explicit archive and a retention disposition that archives are the same fact about the record —
   * it is no longer current — and an auditor asking "when did this leave the shelf" must not have
   * to know which of the two put it there. The payload's `via` says which, because *that* is a
   * different question and it belongs in the payload rather than in a second action.
   */
  DOCUMENT_ARCHIVED: 'ARCHIVED',
  /**
   * The record came back to the shelf — §2's `REINSTATED`, the other half of the owed pair.
   *
   * Deliberately **not** `RESTORED`. A restore reverses a *delete* and is `DOCUMENT_CHANGED` with
   * `operation: RESTORED`; a reinstatement reverses an *archival*, and the two differ in what an
   * auditor concludes from them — one says a record was recovered from the recycle bin, the other
   * says a retired record was returned to active use, which is a controlled-document decision
   * somebody is accountable for.
   */
  DOCUMENT_REINSTATED: 'REINSTATED',
  /**
   * The effective window closed — Phase 6.1.
   *
   * Its own action for the same reason as the two above, plus one specific to it: this is the only
   * document action in the catalogue whose actor is **always** the system. A trail filtered to
   * "changes nobody made" is how an operator confirms the nightly sweep is running, and folding it
   * into `DOCUMENT_CHANGED` would hide it among ten thousand rows that do have an actor.
   *
   * Not in `13-audit-architecture.md` §2's original Document group, and added to it in the same
   * commit as this line — the standing rule for a new action.
   */
  DOCUMENT_EXPIRED: 'EXPIRED',
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
