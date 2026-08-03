import { type DomainEventDraft, defineEvent } from '@edms/domain';

/**
 * Library's domain events.
 *
 * An event is a fact in the past tense, its payload shape never changes once shipped, and
 * delivery is at least once — so every handler is idempotent on `eventId`
 * (`docs/architecture/02-backend-architecture.md` §6).
 *
 * The payloads are deliberately thin: an event carries identifiers and the facts a consumer
 * cannot derive, never a copy of the aggregate. A fat event becomes a second schema that
 * nobody migrates.
 */
export const LIBRARY_AGGREGATE = 'library';

/** A new governed container exists under an organisation node. */
export const LIBRARY_CREATED = 'library.created' as const;

export interface LibraryCreatedPayload {
  readonly libraryId: string;
  readonly code: string;
  readonly ownerScopeType: string;
  readonly ownerScopeId: string;
  readonly rootFolderId: string;
}

export const libraryCreatedEvent = defineEvent<typeof LIBRARY_CREATED, LibraryCreatedPayload>(
  LIBRARY_CREATED,
  1,
  LIBRARY_AGGREGATE,
);

/** Ancestry changed; inherited permissions and search ACL fingerprints change with it. */
export const FOLDER_MOVED = 'library.folder-moved' as const;

export interface FolderMovedPayload {
  readonly folderId: string;
  readonly fromParentId: string | null;
  readonly toParentId: string;
  readonly documentCount: number;
}

export const folderMovedEvent = defineEvent<typeof FOLDER_MOVED, FolderMovedPayload>(
  FOLDER_MOVED,
  1,
  LIBRARY_AGGREGATE,
);

/** Invalidates the permission cache and re-fingerprints affected index entries. */
export const ACL_CHANGED = 'library.acl-changed' as const;

export interface AclChangedPayload {
  readonly scopeType: string;
  readonly scopeId: string;
  readonly affectedSubjectIds: readonly string[];
}

export const aclChangedEvent = defineEvent<typeof ACL_CHANGED, AclChangedPayload>(
  ACL_CHANGED,
  1,
  LIBRARY_AGGREGATE,
);

/** Every event type this module publishes, for the outbox's routing table. */
export const LIBRARY_EVENT_TYPES: readonly string[] = Object.freeze([
  LIBRARY_CREATED,
  FOLDER_MOVED,
  ACL_CHANGED,
]);

export type LibraryEvent = DomainEventDraft;
