import { type TreePlacementRejection, checkTreePlacement } from '@edms/domain';

/**
 * The folder tree's own rules.
 *
 * The path arithmetic is shared with departments and categories — `@edms/domain`'s `tree.ts` — because
 * "is A under B" has to mean the same thing in all three, and here it decides whether an ACL granted
 * on a folder reaches a document. What is local is the ceiling, and the two things that make a folder
 * tree different from the other two: a library has exactly one root, and a folder never leaves its
 * library.
 */

/**
 * How deep folders may nest (`03-domain-model.md` §3).
 *
 * Far deeper than departments, because a folder tree mirrors how a business already files things —
 * imported structures routinely run to a dozen levels, and refusing them would mean asking a customer
 * to reorganise before they can migrate. The ceiling exists because a path is rewritten for the whole
 * subtree on every move, and because an unbounded tree makes the ACL walk unbounded with it.
 */
export const MAXIMUM_FOLDER_DEPTH = 32;

export type FolderRejection =
  TreePlacementRejection | 'PARENT_IN_ANOTHER_LIBRARY' | 'ROOT_CANNOT_MOVE';

/**
 * Whether a folder may be created or moved under a parent.
 *
 * Two rules on top of the shared cycle and depth checks:
 *
 * **A folder does not cross libraries.** Its ancestry is the chain the ACL resolver walks from the
 * library down, so a folder whose parent is in another library would resolve permissions from a node
 * it does not belong to. Moving content between libraries is a different operation on the documents
 * themselves, not a re-parenting of the folder.
 *
 * **A root folder never moves.** It is the library's own anchor — `library.root_folder_id` points at
 * it — so moving it would leave the library pointing into the middle of a tree.
 */
export function checkFolderPlacement(input: {
  readonly nodeId: string | null;
  readonly nodePath: string | null;
  readonly nodeIsRoot: boolean;
  readonly libraryId: string;
  readonly parentId: string | null;
  readonly parentPath: string | null;
  readonly parentLibraryId: string | null;
}): readonly FolderRejection[] {
  const rejections: FolderRejection[] = [
    ...checkTreePlacement({
      nodeId: input.nodeId,
      nodePath: input.nodePath,
      parentId: input.parentId,
      parentPath: input.parentPath,
      maximumDepth: MAXIMUM_FOLDER_DEPTH,
    }),
  ];

  if (input.nodeIsRoot) {
    rejections.push('ROOT_CANNOT_MOVE');
  }
  if (input.parentLibraryId !== null && input.parentLibraryId !== input.libraryId) {
    rejections.push('PARENT_IN_ANOTHER_LIBRARY');
  }

  return rejections;
}

/** Whether a whole subtree still fits under a new parent, measured from its deepest leaf. */
export function folderSubtreeFits(parentDepth: number, subtreeHeight: number): boolean {
  return parentDepth + subtreeHeight <= MAXIMUM_FOLDER_DEPTH;
}
