import type { Folder } from '@edms/contracts';

/**
 * The chain of folders from a library's root down to the one being shown.
 *
 * The breadcrumb said `Documents › SOP` — the destination and nothing about the route to it. In a
 * library where `SOP` exists under Quality, under Manufacturing, that is three levels of context
 * dropped, and "where am I" is the question the tree on the left and the crumb at the top are both
 * supposed to answer.
 *
 * ## Why a walk rather than the path
 *
 * `Folder.path` is a materialised path and the tree already sorts on it, so splitting it looks like
 * the obvious way to get ancestors. It is not: the path is built from *identifiers*, not names, so
 * splitting it yields the chain's shape without a single word a reader could see. The names live on
 * the folder rows themselves, which is what this walks.
 *
 * ## What it does when the chain is incomplete
 *
 * `documents/page.tsx` fetches folders at the API's maximum page size of 100. A library with more
 * than that returns a partial list, and an ancestor can genuinely be missing from it — so the walk
 * stops where the chain breaks and returns the part it could establish, rather than throwing or
 * inventing a crumb. A short trail is a true statement about a deep folder; a fabricated one is not.
 *
 * `seen` is not defensive decoration. `parentId` is server data, and a cycle in it — a folder that
 * is transitively its own ancestor — would spin this function forever and hang the render rather
 * than showing a wrong breadcrumb. Stopping at the repeat costs one Set and turns a hang into a
 * short trail.
 */
export function folderTrail(
  folders: readonly Folder[],
  selectedFolderId: string | null,
): readonly Folder[] {
  if (selectedFolderId === null) {
    return [];
  }

  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const trail: Folder[] = [];
  const seen = new Set<string>();

  let current = byId.get(selectedFolderId);
  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    trail.push(current);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }

  // Built leaf-first because that is the direction `parentId` points; a breadcrumb reads the other
  // way.
  return trail.reverse();
}
