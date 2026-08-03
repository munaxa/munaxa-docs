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
} as const;

export type RevisionStatusKey = (typeof RevisionStatus)[keyof typeof RevisionStatus];

/** How a document relates to another (`document_link.link_type`). */
export const DocumentLinkType = {
  REFERENCES: 'REFERENCES',
  SUPERSEDES: 'SUPERSEDES',
  ATTACHMENT_OF: 'ATTACHMENT_OF',
  RELATED_TO: 'RELATED_TO',
} as const;

export type DocumentLinkTypeKey = (typeof DocumentLinkType)[keyof typeof DocumentLinkType];
