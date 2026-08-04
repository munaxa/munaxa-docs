import { DocumentStatus, type DocumentStatusKey } from '@edms/domain';

/**
 * The document state machine, as a table.
 *
 * `06-document-lifecycle.md` §5 states the rules this file exists to obey, and the first of them is
 * the reason it is a table at all: **it is the only source of truth**, and there is no
 * `if (status === 'PUBLISHED')` scattered through a service. A status check written inline is a
 * check that disagrees with this table the first time somebody adds a state, and disagrees silently.
 *
 * Pure, and it decides nothing about permission. Whether *this person* may make a transition is the
 * permission model's; whether the transition exists at all is this. Keeping them apart is what lets
 * "may I submit" be answered for a screen without resolving anybody's roles.
 *
 * Phase 4 fills in the half of this table that submission and approval reach. The rest — check-out,
 * publication superseding a prior revision, archival, purge — is written here because the table is
 * the design and a partial table would be a second thing to reconcile later, but the transitions
 * belonging to Phases 5, 6, 9 and 10 have nothing that performs them yet. `availableTransitions`
 * reports what the *engine* can do today, which is deliberately narrower than what the table allows.
 */

/**
 * Every legal transition, from the table in §3.
 *
 * Read it as "from this state, a document may become one of these". A pair absent from here is
 * refused, and §4 explains each of the ones worth refusing explicitly.
 */
export const LEGAL_TRANSITIONS: Readonly<Record<DocumentStatusKey, readonly DocumentStatusKey[]>> =
  Object.freeze({
    [DocumentStatus.DRAFT]: Object.freeze([DocumentStatus.SUBMITTED, DocumentStatus.DELETED]),
    [DocumentStatus.SUBMITTED]: Object.freeze([
      DocumentStatus.UNDER_REVIEW,
      // Back to draft when the author withdraws before anybody has decided. Not in §3's table as
      // its own row because §3 describes the engine's own moves; a withdrawal is the author
      // cancelling the instance with reason `WITHDRAWN`, which returns the document to where it
      // came from.
      DocumentStatus.DRAFT,
    ]),
    [DocumentStatus.UNDER_REVIEW]: Object.freeze([
      DocumentStatus.CHANGES_REQUESTED,
      DocumentStatus.REJECTED,
      DocumentStatus.APPROVED,
      DocumentStatus.DRAFT,
    ]),
    [DocumentStatus.CHANGES_REQUESTED]: Object.freeze([
      DocumentStatus.DRAFT,
      DocumentStatus.DELETED,
    ]),
    [DocumentStatus.REJECTED]: Object.freeze([DocumentStatus.DRAFT, DocumentStatus.DELETED]),
    [DocumentStatus.APPROVED]: Object.freeze([DocumentStatus.PUBLISHED]),
    [DocumentStatus.PUBLISHED]: Object.freeze([
      DocumentStatus.CHECKED_OUT,
      DocumentStatus.SUPERSEDED,
      DocumentStatus.EXPIRED,
      DocumentStatus.ARCHIVED,
    ]),
    [DocumentStatus.CHECKED_OUT]: Object.freeze([DocumentStatus.PUBLISHED, DocumentStatus.DRAFT]),
    [DocumentStatus.SUPERSEDED]: Object.freeze([DocumentStatus.ARCHIVED]),
    [DocumentStatus.ARCHIVED]: Object.freeze([
      DocumentStatus.PUBLISHED,
      DocumentStatus.DELETED,
      DocumentStatus.PURGED,
    ]),
    [DocumentStatus.EXPIRED]: Object.freeze([DocumentStatus.ARCHIVED, DocumentStatus.CHECKED_OUT]),
    [DocumentStatus.DELETED]: Object.freeze([
      DocumentStatus.DRAFT,
      DocumentStatus.ARCHIVED,
      DocumentStatus.PURGED,
    ]),
    /** Terminal by definition. Nothing follows a purge but the audit trail. */
    [DocumentStatus.PURGED]: Object.freeze([]),
  });

export function isLegalTransition(from: DocumentStatusKey, to: DocumentStatusKey): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

/**
 * Content is frozen from submission onward.
 *
 * Written in Phase 3 against statuses nothing could reach, and Phase 4 is what makes it fire. It
 * lives here now rather than beside the service that calls it, because it is the same table's
 * business: "the bytes under review must be the bytes approved" is §4's last row.
 *
 * `CHANGES_REQUESTED` is deliberately absent. An approver asking for changes is asking the author
 * to make them, so the document is editable again the moment the request is recorded — that is what
 * distinguishes it from a rejection.
 *
 * `CHECKED_OUT` joined the set in Phase 6, when the state became reachable. §1's table allows a
 * checked-out document a "new draft revision only": the holder's edit happens in their own tools
 * and arrives as the next revision at check-in, and a metadata edit landing meanwhile would change
 * the record beneath somebody working from a copy of it.
 */
export const FROZEN_STATUSES: ReadonlySet<DocumentStatusKey> = new Set<DocumentStatusKey>([
  DocumentStatus.SUBMITTED,
  DocumentStatus.UNDER_REVIEW,
  DocumentStatus.APPROVED,
  DocumentStatus.PUBLISHED,
  DocumentStatus.SUPERSEDED,
  DocumentStatus.CHECKED_OUT,
  DocumentStatus.ARCHIVED,
]);

export function isFrozen(status: DocumentStatusKey): boolean {
  return FROZEN_STATUSES.has(status);
}

/**
 * The states a document may be submitted for approval from.
 *
 * `CHANGES_REQUESTED` is not among them, and that is not an oversight: an approver's request
 * returns the document to `DRAFT` when the author reopens it, and resubmitting without reopening
 * would put a document back in front of the same approver with the same content.
 */
export const SUBMITTABLE_STATUSES: ReadonlySet<DocumentStatusKey> = new Set<DocumentStatusKey>([
  DocumentStatus.DRAFT,
]);

/**
 * The transitions the product can actually perform today, per state.
 *
 * Deliberately narrower than `LEGAL_TRANSITIONS`, and the gap is the honest part. The table above is
 * the design and includes rows owned by Phases 5, 6, 9 and 10; this is what an endpoint exists for.
 * `GET /documents/{id}/transitions` answers from here, because §5's rule is that "the UI asks the
 * API for the available transitions and renders exactly those" — and offering a transition nothing
 * implements would make the client render a button that returns a 404.
 */
export const IMPLEMENTED_TRANSITIONS: Readonly<
  Record<DocumentStatusKey, readonly DocumentStatusKey[]>
> = Object.freeze({
  [DocumentStatus.DRAFT]: Object.freeze([DocumentStatus.SUBMITTED, DocumentStatus.DELETED]),
  [DocumentStatus.SUBMITTED]: Object.freeze([DocumentStatus.DRAFT]),
  [DocumentStatus.UNDER_REVIEW]: Object.freeze([DocumentStatus.DRAFT]),
  [DocumentStatus.CHANGES_REQUESTED]: Object.freeze([DocumentStatus.DRAFT, DocumentStatus.DELETED]),
  [DocumentStatus.REJECTED]: Object.freeze([DocumentStatus.DRAFT, DocumentStatus.DELETED]),
  /**
   * Offered since Phase 5 — `ck_document_numbered_when_published` stood guard while nothing
   * performed it — and performed since Phase 6: publication supersedes the prior revision in
   * the same transaction.
   */
  [DocumentStatus.APPROVED]: Object.freeze([DocumentStatus.PUBLISHED]),
  /**
   * Check-out is Phase 6's. `SUPERSEDED`, `EXPIRED` and `ARCHIVED` stay unoffered: nothing
   * yet supersedes a *document* (a newer revision supersedes a revision, and the document
   * stays `PUBLISHED`), nothing watches `effective_to`, and archival is a later phase.
   */
  [DocumentStatus.PUBLISHED]: Object.freeze([DocumentStatus.CHECKED_OUT]),
  [DocumentStatus.CHECKED_OUT]: Object.freeze([DocumentStatus.PUBLISHED, DocumentStatus.DRAFT]),
  [DocumentStatus.SUPERSEDED]: Object.freeze([]),
  [DocumentStatus.ARCHIVED]: Object.freeze([DocumentStatus.DELETED]),
  [DocumentStatus.EXPIRED]: Object.freeze([]),
  [DocumentStatus.DELETED]: Object.freeze([DocumentStatus.DRAFT]),
  [DocumentStatus.PURGED]: Object.freeze([]),
});

export function implementedTransitionsFrom(
  status: DocumentStatusKey,
): readonly DocumentStatusKey[] {
  return IMPLEMENTED_TRANSITIONS[status];
}
