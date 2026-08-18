import type { Folder } from '@edms/contracts';

import type { ActionResult } from '../../lib/admin/action-result';

/**
 * The folder the URL names, when the page it arrived on does not contain it — Slice 7.
 *
 * ## The defect this removes
 *
 * `documents/page.tsx` fetches folders at `pageSize: 100`, which is `MAX_PAGE_SIZE` and the most
 * the pagination schema will accept. A library with more folders than that gets a *prefix* of its
 * structure, and everything after the cut is simply absent — measured on the running stack, a
 * 149-folder library returned 100 rows and dropped 49 of the root's own children.
 *
 * Nothing about that was reported. `selectedFolderName` resolved `folder?.name ?? library?.name`,
 * so a deep link to a dropped folder produced a page headed with the **library's** name, a
 * breadcrumb that had collapsed to `Documents`, a rail showing a single row, and no `aria-current`
 * anywhere — while the document list underneath was correctly scoped to the folder the URL asked
 * for. Correct rows under an incorrect label, which is worse than either alone: it is the same
 * defect class Slices 2 and 3 removed, reintroduced by truncation rather than by logic.
 *
 * ## What this does, and what it deliberately does not
 *
 * It recovers **one chain**: the selected folder and whatever ancestors are needed to attach it to
 * the folders already held. It does not make the rest of the library browsable — a library of a
 * thousand folders still shows a hundred of them, and the rail says so. Completeness is a
 * lazy-loading problem with its own design questions (a server action per expansion, per-node
 * loading and error states) and it is not this.
 *
 * ## Why the walk is nearly always one request
 *
 * The page asks for `sortBy: 'path'`, and a materialised path makes an ancestor's path a proper
 * prefix of its descendant's — which sorts first. So the fetched page is **closed under the
 * ancestor relation**: every row's parent is in it too. Verified against the running stack, where
 * `sortBy=path` gave zero rows with a missing parent and `sortBy=name` gave a hundred out of a
 * hundred. The practical consequence is that a folder past the cut usually has its whole ancestry
 * *inside* the cut, so the walk reads the selected folder, finds its parent already known, and
 * stops. One request, not a chain.
 *
 * That property belongs to the sort, not to this function, which is why `page.spec.ts` pins
 * `sortBy: 'path'` with a test that names the consequence of changing it.
 */

/**
 * How deep a chain may be walked.
 *
 * The same ceiling the API enforces on the tree itself — `MAXIMUM_FOLDER_DEPTH` in
 * `apps/api/src/modules/library/domain/folder-tree.ts`, which no folder may be created or moved
 * below. It is restated here rather than imported because the web application cannot import from
 * the API, and the shared `@edms/domain` tree module takes a `maximumDepth` argument rather than
 * declaring one. Promoting the constant into `@edms/domain` would be the right home for it and is
 * a change to a package this slice may not touch.
 *
 * It bounds the number of requests as well as the depth, which is the property that matters here:
 * a malformed chain cannot turn one page load into an unbounded fan of reads.
 */
export const MAXIMUM_FOLDER_DEPTH = 32;

/** Reads one folder by identifier, reporting a refusal rather than throwing it. */
export type FolderReader = (id: string) => Promise<ActionResult<Folder>>;

/**
 * What happened, named — so the page can act on it and a test can assert it.
 *
 * - `present` — the folder was in the page already. **No request was made.** The common path.
 * - `recovered` — the folder was read, and its chain reached the folders already held, or a
 *   genuine root. Merged.
 * - `detached` — the folder was read, but the chain never attached: an ancestor was refused, or
 *   not found, or the ceiling was reached, or the data contains a cycle. **Nothing is merged**;
 *   see below.
 * - `unresolved` — the folder itself could not be read. Nothing is known about it.
 */
export type FolderRecoveryOutcome = 'present' | 'recovered' | 'detached' | 'unresolved';

export interface FolderChainRecovery {
  /** The original page, plus a recovered chain when there is one to attach. Never reordered. */
  readonly folders: readonly Folder[];
  /** The selected folder itself, if it could be established. `null` means genuinely unknown. */
  readonly selected: Folder | null;
  /** How many reads this issued. Zero on the common path; bounded by `MAXIMUM_FOLDER_DEPTH`. */
  readonly reads: number;
  readonly outcome: FolderRecoveryOutcome;
}

/**
 * Why a detached chain is **not** merged.
 *
 * `TreeView` builds its hierarchy from `parentId` and promotes any node whose parent is missing to
 * a **root** — that is its documented behaviour, and the right default for a chart. Here it would
 * be a lie: merging a folder whose parent was refused would render it at `aria-level="1"`, telling
 * every reader and every screen reader that a folder six levels down is a top-level one. The
 * missing ancestor would have been fabricated — as an absence, which is still a claim.
 *
 * So a chain that cannot be attached is dropped from the tree, and the page keeps only what it can
 * say truthfully: the folder's own name, for the heading. That is strictly more than the defect
 * this slice removes left it with, and nothing in it is invented.
 */
export async function recoverSelectedFolderChain({
  selectedFolderId,
  libraryId,
  folders,
  read,
}: {
  readonly selectedFolderId: string | null;
  /** The library being shown. A folder from another one is not this page's to place or to name. */
  readonly libraryId: string | null;
  readonly folders: readonly Folder[];
  readonly read: FolderReader;
}): Promise<FolderChainRecovery> {
  const known = new Map(folders.map((folder) => [folder.id, folder]));

  if (selectedFolderId === null) {
    return { folders, selected: null, reads: 0, outcome: 'present' };
  }

  const alreadyHeld = known.get(selectedFolderId);
  if (alreadyHeld !== undefined) {
    return { folders, selected: alreadyHeld, reads: 0, outcome: 'present' };
  }

  // Leaf first, because that is the direction `parentId` points. Reversed before merging.
  const chain: Folder[] = [];
  const visited = new Set<string>();
  let currentId: string | null = selectedFolderId;
  let reads = 0;
  let attached = false;

  while (currentId !== null) {
    // A cycle in `parentId` is malformed server data, and the reason this is a set rather than a
    // counter: the ceiling alone would still spend thirty-two requests going round in circles.
    if (visited.has(currentId)) {
      break;
    }
    if (known.has(currentId)) {
      attached = true;
      break;
    }
    if (chain.length >= MAXIMUM_FOLDER_DEPTH) {
      break;
    }

    visited.add(currentId);
    reads += 1;
    const result = await read(currentId);
    // A refusal stops the walk and is never retried by another route. `AclGuard` decided the
    // caller may not reach this folder, and that decision is the answer rather than an obstacle.
    if (!result.ok) {
      break;
    }

    const folder = result.value;
    // A folder from another library is not this rail's to draw. Merging it would put a stranger's
    // structure into this library's tree; naming it in the heading would describe a place the list
    // below is not showing. An inconsistent URL gets the neutral title instead.
    if (libraryId !== null && folder.libraryId !== libraryId) {
      break;
    }

    chain.push(folder);
    currentId = folder.parentId;
    if (currentId === null) {
      // A library's own root. Level one is where it belongs, so the chain is anchored.
      attached = true;
    }
  }

  const selected = chain[0] ?? null;

  if (!attached) {
    return {
      folders,
      selected,
      reads,
      outcome: selected === null ? 'unresolved' : 'detached',
    };
  }

  return {
    // Appended rather than merged in place: the original page arrives in path order and stays in
    // it, and `TreeView` reads `parentId` rather than position, so where the chain sits in the
    // array decides only the order of siblings. Root-first within the chain, matching the order
    // the page itself is in.
    folders: [...folders, ...[...chain].reverse()],
    selected,
    reads,
    outcome: 'recovered',
  };
}
