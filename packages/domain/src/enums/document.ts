/**
 * The document lifecycle states (`docs/architecture/06-document-lifecycle.md`).
 *
 * The states are vocabulary and belong here; the transition table and its guards are
 * behaviour and belong to the Document module's domain layer, which Phase 1 builds.
 */
export const DocumentStatus = {
  DRAFT: 'DRAFT',
  SUBMITTED: 'SUBMITTED',
  UNDER_REVIEW: 'UNDER_REVIEW',
  CHANGES_REQUESTED: 'CHANGES_REQUESTED',
  REJECTED: 'REJECTED',
  APPROVED: 'APPROVED',
  PUBLISHED: 'PUBLISHED',
  CHECKED_OUT: 'CHECKED_OUT',
  SUPERSEDED: 'SUPERSEDED',
  ARCHIVED: 'ARCHIVED',
  EXPIRED: 'EXPIRED',
  DELETED: 'DELETED',
  PURGED: 'PURGED',
} as const;

export type DocumentStatusKey = (typeof DocumentStatus)[keyof typeof DocumentStatus];

export const ALL_DOCUMENT_STATUSES: readonly DocumentStatusKey[] = Object.freeze(
  Object.values(DocumentStatus),
);

/** A revision has its own, smaller machine beneath the document's. */
export const RevisionStatus = {
  DRAFT: 'DRAFT',
  IN_APPROVAL: 'IN_APPROVAL',
  PUBLISHED: 'PUBLISHED',
  SUPERSEDED: 'SUPERSEDED',
  /**
   * A draft abandoned when its check-out was cancelled or replaced. Retained in history —
   * its ordinal is spent and never reissued, so the row stays and says what became of it
   * (`10-revision-architecture.md` §3).
   */
  DISCARDED: 'DISCARDED',
} as const;

export type RevisionStatusKey = (typeof RevisionStatus)[keyof typeof RevisionStatus];

/**
 * Why a check-out lock ended. A closed set rather than a note, because "who released this
 * lock and why" is a question a compliance report groups by; the free-text half is the
 * lock's `releaseNote`, required when the release was forced.
 */
export const DocumentLockReleaseReason = {
  /** The holder checked a new draft revision in. */
  CHECKED_IN: 'CHECKED_IN',
  /** The holder cancelled; any working draft was discarded. */
  CANCELLED: 'CANCELLED',
  /** Somebody with `document:force-checkin` released another person's lock. */
  FORCED: 'FORCED',
  /** The lock sat past its expiry and a later operation swept it aside. */
  EXPIRED: 'EXPIRED',
} as const;

export type DocumentLockReleaseReasonKey =
  (typeof DocumentLockReleaseReason)[keyof typeof DocumentLockReleaseReason];

/**
 * How the content arrived.
 *
 * Provenance rather than behaviour: nothing in the product branches on it. It exists because an
 * auditor asking "was this captured from paper or authored on a machine" is asking a real question
 * about a controlled record, and the answer is not recoverable afterwards from anything else.
 */
export const DocumentOrigin = {
  UPLOAD: 'UPLOAD',
  SCAN: 'SCAN',
} as const;

export type DocumentOriginKey = (typeof DocumentOrigin)[keyof typeof DocumentOrigin];

/** How a document relates to another (`document_link.link_type`). */
export const DocumentLinkType = {
  REFERENCES: 'REFERENCES',
  SUPERSEDES: 'SUPERSEDES',
  ATTACHMENT_OF: 'ATTACHMENT_OF',
  RELATED_TO: 'RELATED_TO',
} as const;

export type DocumentLinkTypeKey = (typeof DocumentLinkType)[keyof typeof DocumentLinkType];
