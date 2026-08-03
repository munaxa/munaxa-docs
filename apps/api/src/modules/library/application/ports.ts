import type {
  AclEffectKey,
  AclSubjectTypeKey,
  FolderId,
  LibraryId,
  PermissionKey,
  ScopeRef,
} from '@edms/domain';
import type { Page, PageRequest } from '@edms/utils';

export const LIBRARY_REPOSITORY = Symbol('LibraryRepository');
export const FOLDER_REPOSITORY = Symbol('FolderRepository');
export const ACL_REPOSITORY = Symbol('AclRepository');

export interface LibraryRecord {
  readonly id: LibraryId;
  readonly code: string;
  readonly name: string;
  readonly ownerScope: ScopeRef;
  readonly rootFolderId: FolderId;
}

export interface LibraryRepository {
  findById(id: LibraryId): Promise<LibraryRecord | null>;
  findByCode(code: string): Promise<LibraryRecord | null>;
  save(library: LibraryRecord): Promise<void>;
  list(page: PageRequest): Promise<Page<LibraryRecord>>;
}

export interface FolderRecord {
  readonly id: FolderId;
  readonly libraryId: LibraryId;
  readonly parentId: FolderId | null;
  readonly name: string;
  readonly path: string;
  /** When false, the ACL walk stops here — except for administrative permissions. */
  readonly inheritAcl: boolean;
}

export interface FolderRepository {
  findById(id: FolderId): Promise<FolderRecord | null>;
  listChildren(id: FolderId): Promise<readonly FolderRecord[]>;
  /** Ancestor-first, from the materialised path: one query, whatever the depth. */
  listAncestors(id: FolderId): Promise<readonly FolderRecord[]>;
  save(folder: FolderRecord): Promise<void>;
  /** Moving a subtree rewrites descendant paths; the caller's transaction covers all of it. */
  moveSubtree(id: FolderId, newParentId: FolderId): Promise<void>;
}

export interface AclEntryRecord {
  readonly scope: ScopeRef;
  readonly subjectType: AclSubjectTypeKey;
  readonly subjectId: string;
  readonly permission: PermissionKey;
  readonly effect: AclEffectKey;
}

export interface AclRepository {
  /** Every entry on a scope chain, for the subjects given: the resolver's single query. */
  listForChain(
    scopeIds: readonly string[],
    subjectIds: readonly string[],
  ): Promise<readonly AclEntryRecord[]>;
  listForScope(scope: ScopeRef): Promise<readonly AclEntryRecord[]>;
  replaceForScope(scope: ScopeRef, entries: readonly AclEntryRecord[]): Promise<void>;
}

export const LIBRARY_SERVICE = Symbol('LibraryService');
export const PERMISSION_SERVICE = Symbol('PermissionService');

export interface LibraryService {
  get(id: LibraryId): Promise<LibraryRecord | null>;
  folderExists(id: FolderId): Promise<boolean>;
}

/**
 * Explicit and effective permissions for a scope node. The permissions tab shows *why* a
 * user has access — which node decided it — not merely that they do
 * (`docs/architecture/16-frontend-architecture.md` §5).
 */
export interface PermissionService {
  explicitFor(scope: ScopeRef): Promise<readonly AclEntryRecord[]>;
  effectiveFor(scope: ScopeRef, subjectId: string): Promise<readonly AclEntryRecord[]>;
}
