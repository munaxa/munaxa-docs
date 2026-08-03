import type { DeletedFilter, SortDirection } from '@edms/contracts';
import type { ScopeTypeKey } from '@edms/domain';
import type { Page, PageRequest } from '@edms/utils';

/**
 * Administering libraries and folders.
 *
 * Phase 2 builds the *place* documents will live in and the tree ACLs are granted on. It does not
 * build the ACL entries themselves — those are the permissions phase's, along with the resolver that
 * walks them — so nothing here grants anything. What it does build is the structure that grant will
 * name, which is why the folder tree's ancestry rules are as carefully guarded here as the scope
 * tree's are next door.
 */

export const LIBRARY_ADMIN_SERVICE = Symbol('LibraryAdminService');
export const LIBRARY_ADMIN_REPOSITORY = Symbol('LibraryAdminRepository');

interface Stamped {
  readonly id: string;
  readonly createdAt: Date;
  readonly createdBy: string | null;
  readonly updatedAt: Date;
  readonly updatedBy: string | null;
  readonly deletedAt: Date | null;
  readonly deletedBy: string | null;
  readonly version: number;
}

export interface LibraryRow extends Stamped {
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly ownerScopeType: ScopeTypeKey;
  readonly ownerScopeId: string | null;
  /** The owning node's name, resolved so a list needs no lookup per row. */
  readonly ownerScopeName: string;
  readonly rootFolderId: string;
  readonly folderCount: number;
}

export interface FolderRow extends Stamped {
  readonly libraryId: string;
  readonly libraryName: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly description: string | null;
  readonly path: string;
  readonly depth: number;
  readonly inheritAcl: boolean;
  readonly isRoot: boolean;
  readonly childCount: number;
}

export interface LibraryListRequest extends PageRequest {
  readonly search?: string | undefined;
  readonly sortBy?: string | undefined;
  readonly sortDirection: SortDirection;
  readonly deleted: DeletedFilter;
  readonly ownerScopeType?: ScopeTypeKey | undefined;
  readonly ownerScopeId?: string | undefined;
}

export interface FolderListRequest extends PageRequest {
  readonly search?: string | undefined;
  readonly sortBy?: string | undefined;
  readonly sortDirection: SortDirection;
  readonly deleted: DeletedFilter;
  readonly libraryId?: string | undefined;
  readonly parentId?: string | undefined;
  readonly underId?: string | undefined;
}

export interface FolderSubtreeNode {
  readonly id: string;
  readonly path: string;
  readonly depth: number;
}

export interface LibraryAdminRepository {
  // --- Libraries ---
  listLibraries(request: LibraryListRequest): Promise<Page<LibraryRow>>;
  findLibrary(id: string, includeDeleted: boolean): Promise<LibraryRow | null>;
  libraryCodeTaken(code: string, exceptId: string | null): Promise<boolean>;
  /**
   * Creates a library and its root folder together, and points one at the other.
   *
   * One method rather than three calls, because the two rows and the link between them are a single
   * fact: a library with no root folder is a place nothing can be filed in, and a root folder with no
   * library is unreachable. The schema has to allow the intermediate state — a folder cannot exist
   * before the library it belongs to — so the repository is what makes it unobservable.
   */
  insertLibraryWithRoot(input: {
    readonly libraryId: string;
    readonly rootFolderId: string;
    readonly code: string;
    readonly name: string;
    readonly description: string | null;
    readonly ownerScopeType: ScopeTypeKey;
    readonly ownerScopeId: string | null;
    readonly rootFolderName: string;
  }): Promise<void>;
  updateLibrary(
    id: string,
    version: number,
    patch: { readonly code?: string; readonly name?: string; readonly description?: string | null },
  ): Promise<void>;
  setLibraryDeleted(id: string, version: number, deleted: boolean): Promise<void>;
  /** Live folders in a library, other than its root — what blocks deleting it. */
  countLibraryFolders(libraryId: string): Promise<number>;

  // --- Folders ---
  listFolders(request: FolderListRequest): Promise<Page<FolderRow>>;
  findFolder(id: string, includeDeleted: boolean): Promise<FolderRow | null>;
  /** Names are unique among live siblings, case-insensitively. */
  folderSiblingNameTaken(parentId: string, name: string, exceptId: string | null): Promise<boolean>;
  insertFolder(input: {
    readonly id: string;
    readonly libraryId: string;
    readonly parentId: string;
    readonly name: string;
    readonly description: string | null;
    readonly path: string;
    readonly depth: number;
    readonly inheritAcl: boolean;
  }): Promise<void>;
  updateFolder(
    id: string,
    version: number,
    patch: {
      readonly name?: string;
      readonly description?: string | null;
      readonly inheritAcl?: boolean;
    },
  ): Promise<void>;
  folderSubtree(path: string): Promise<readonly FolderSubtreeNode[]>;
  moveFolder(input: {
    readonly id: string;
    readonly version: number;
    readonly parentId: string;
    readonly nodes: readonly FolderSubtreeNode[];
  }): Promise<void>;
  /**
   * Soft-deletes a folder and everything under it, stamped with one cascade identifier.
   *
   * The identifier is what makes a restore exact. Restoring "everything currently deleted under this
   * node" would resurrect folders somebody had deleted individually and deliberately beforehand
   * (`05-database-design.md` §4).
   */
  cascadeDeleteFolder(input: {
    readonly id: string;
    readonly version: number;
    readonly path: string;
    readonly cascadeId: string;
  }): Promise<number>;
  /** Restores exactly the folders one cascade removed. */
  restoreCascade(cascadeId: string): Promise<number>;
  /**
   * Restores one folder and nothing else.
   *
   * For a row that carries no cascade identifier — deleted by an earlier release, or by a maintenance
   * script. Restoring its whole "subtree" would be guessing at an intent nothing recorded.
   */
  restoreFolderOnly(id: string, version: number): Promise<void>;
  /** The cascade a folder was removed by, or null if it was deleted on its own. */
  cascadeIdOf(id: string): Promise<string | null>;
}
