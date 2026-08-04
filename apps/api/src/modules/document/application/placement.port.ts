/**
 * Where a document may sit, in Document's own words.
 *
 * A document belongs to a folder, and the folder is not merely a location: it is the chain the ACL
 * resolver walks, so "does this folder exist" and "which library is it in" are questions every
 * create and every move has to ask before it writes. They are Library's answers, and this is the
 * shape Document needs them in.
 *
 * Two fields beyond the obvious, and both earn their place. `path` is what makes "everything
 * beneath this folder" one indexed query rather than a recursive walk — the materialised path is
 * a prefix, so a subtree listing is a `LIKE 'a.b.%'` (ADR-0014). `libraryId` is what lets a
 * document list be filtered by library without a join per row.
 */
export const DOCUMENT_PLACEMENT = Symbol('DocumentPlacement');

export interface FolderPlacement {
  readonly id: string;
  readonly name: string;
  /** Dot-separated ancestor identifiers, this folder last. Never written by hand. */
  readonly path: string;
  readonly libraryId: string;
  readonly libraryName: string;
}

export interface DocumentPlacement {
  /** Null for a folder that does not exist, is deleted, or belongs to another tenant. */
  folder(id: string): Promise<FolderPlacement | null>;
}
