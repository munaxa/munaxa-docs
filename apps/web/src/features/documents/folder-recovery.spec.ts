import type { Folder } from '@edms/contracts';
import { ErrorCode } from '@edms/domain';
import { describe, expect, it, vi } from 'vitest';

import { failed, succeeded } from '../../lib/admin/action-result';
import {
  MAXIMUM_FOLDER_DEPTH,
  type FolderReader,
  recoverSelectedFolderChain,
} from './folder-recovery';

/**
 * Recovering the folder the URL names — Slice 7.
 *
 * ## What each case here is protecting
 *
 * The function has one job and four ways to stop, and every one of the four is a decision somebody
 * could reasonably get wrong later:
 *
 * - stopping when the chain reaches folders already held is what keeps the common case **one**
 *   request rather than a walk to the root;
 * - stopping at a refusal is what keeps `AclGuard`'s answer the answer, rather than a condition to
 *   route around;
 * - stopping at a repeat is what keeps malformed server data from turning one page load into an
 *   unbounded fan of reads;
 * - stopping at the depth ceiling is the backstop for a chain that is merely very long.
 *
 * And the *merge* decision is the one with a user-visible consequence: a chain that never attached
 * must not be merged, because `TreeView` promotes a parentless node to a root and would announce a
 * folder six levels down at `aria-level="1"`.
 */

const STAMPS = {
  version: 1,
  createdAt: '2026-08-01T00:00:00.000Z',
  createdBy: null,
  updatedAt: '2026-08-01T00:00:00.000Z',
  updatedBy: null,
  deletedAt: null,
  deletedBy: null,
} as const;

function folder(overrides: Partial<Folder> & Pick<Folder, 'id'>): Folder {
  return {
    ...STAMPS,
    libraryId: 'lib-1',
    libraryName: 'Quality',
    parentId: null,
    name: overrides.id,
    description: null,
    path: overrides.id,
    depth: 1,
    inheritAcl: true,
    isRoot: false,
    childCount: 0,
    ...overrides,
  };
}

/** The library's own root: the anchor every well-formed chain eventually reaches. */
const ROOT = folder({ id: 'root', parentId: null, isRoot: true, depth: 1 });

/** A reader over a fixed set, recording what it was asked for. */
function readerOver(rows: readonly Folder[]): FolderReader & { calls: string[] } {
  const calls: string[] = [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const read = (id: string) => {
    calls.push(id);
    const found = byId.get(id);
    return Promise.resolve(
      found === undefined ? failed<Folder>(ErrorCode.NOT_FOUND) : succeeded(found),
    );
  };
  return Object.assign(read, { calls });
}

const recover = (
  selectedFolderId: string | null,
  folders: readonly Folder[],
  read: FolderReader,
  libraryId: string | null = 'lib-1',
) => recoverSelectedFolderChain({ selectedFolderId, libraryId, folders, read });

describe('A · the folder is already on the page', () => {
  it('reads nothing at all', async () => {
    /*
     * The case that matters most for cost, because it is every page load of every library under a
     * hundred folders. A recovery that "just checked" would add a request to all of them.
     */
    const read = readerOver([]);
    const result = await recover('root', [ROOT], read);

    expect(read.calls).toStrictEqual([]);
    expect(result.reads).toBe(0);
    expect(result.outcome).toBe('present');
    expect(result.selected).toBe(ROOT);
    // The same array, not a copy of it — nothing was merged, so nothing was rebuilt.
    expect(result.folders).toHaveLength(1);
  });

  it('reads nothing when no folder is selected either', async () => {
    const read = readerOver([]);
    const result = await recover(null, [ROOT], read);

    expect(read.calls).toStrictEqual([]);
    expect(result.selected).toBeNull();
    expect(result.outcome).toBe('present');
  });
});

describe('B · the folder is off the page, and so are its ancestors', () => {
  const branch = folder({ id: 'branch', parentId: 'root', depth: 2 });
  const leaf = folder({ id: 'leaf', parentId: 'branch', depth: 3 });

  it('walks to the folders already held and attaches there', async () => {
    const read = readerOver([branch, leaf]);
    const result = await recover('leaf', [ROOT], read);

    expect(read.calls).toStrictEqual(['leaf', 'branch']);
    expect(result.reads).toBe(2);
    expect(result.outcome).toBe('recovered');
    expect(result.selected).toBe(leaf);
  });

  it('merges the chain root-first, behind the page it is joining', async () => {
    // Order decides only which sibling comes first — `TreeView` reads `parentId` — but the page
    // arrives in path order and the chain is written the same way round, so the array still reads
    // as a tree to anybody printing it.
    const read = readerOver([branch, leaf]);
    const result = await recover('leaf', [ROOT], read);

    expect(result.folders.map((entry) => entry.id)).toStrictEqual(['root', 'branch', 'leaf']);
  });

  it('never repeats a folder the page already carried', async () => {
    const read = readerOver([leaf]);
    const result = await recover('leaf', [ROOT, branch], read);

    const ids = result.folders.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('C · the folder is off the page but its parent is on it', () => {
  it('reads exactly one folder', async () => {
    /*
     * The shape the running stack actually produces, and the reason this slice is cheap. The page
     * asks for `sortBy: 'path'`, an ancestor's path is a proper prefix of its descendant's, and a
     * proper prefix sorts first — so the hundred rows are closed under the ancestor relation and a
     * dropped folder's parent is nearly always still in them.
     */
    const off = folder({ id: 'off', parentId: 'root', depth: 2 });
    const read = readerOver([off]);
    const result = await recover('off', [ROOT], read);

    expect(read.calls).toStrictEqual(['off']);
    expect(result.reads).toBe(1);
    expect(result.outcome).toBe('recovered');
    expect(result.folders.map((entry) => entry.id)).toStrictEqual(['root', 'off']);
  });
});

describe('D · the walk continues past an ancestor that is also missing', () => {
  it('keeps going until it reaches something known', async () => {
    const chain = [
      folder({ id: 'a', parentId: 'root', depth: 2 }),
      folder({ id: 'b', parentId: 'a', depth: 3 }),
      folder({ id: 'c', parentId: 'b', depth: 4 }),
      folder({ id: 'd', parentId: 'c', depth: 5 }),
    ];
    const read = readerOver(chain);
    const result = await recover('d', [ROOT], read);

    expect(read.calls).toStrictEqual(['d', 'c', 'b', 'a']);
    expect(result.outcome).toBe('recovered');
    expect(result.folders.map((entry) => entry.id)).toStrictEqual(['root', 'a', 'b', 'c', 'd']);
  });

  it('anchors on a genuine root rather than requiring the page to hold one', async () => {
    // A library whose folder page came back empty still has a real root, and a chain that reaches
    // `parentId === null` is attached: level one is where that folder actually belongs.
    const top = folder({ id: 'top', parentId: null, isRoot: true });
    const under = folder({ id: 'under', parentId: 'top', depth: 2 });
    const read = readerOver([top, under]);
    const result = await recover('under', [], read);

    expect(result.outcome).toBe('recovered');
    expect(result.folders.map((entry) => entry.id)).toStrictEqual(['top', 'under']);
  });
});

describe('E · an ancestor is refused', () => {
  const secret = folder({ id: 'secret', parentId: 'root', depth: 2 });
  const reachable = folder({ id: 'reachable', parentId: 'secret', depth: 3 });

  /** The folder is readable; its parent is not. Exactly what a folder-level ACL grant produces. */
  function refusingReader(): FolderReader & { calls: string[] } {
    const calls: string[] = [];
    const read = (id: string) => {
      calls.push(id);
      if (id === reachable.id) return Promise.resolve(succeeded(reachable));
      return Promise.resolve(failed<Folder>(ErrorCode.FORBIDDEN));
    };
    return Object.assign(read, { calls });
  }

  it('stops at the refusal and tries nothing else', async () => {
    const read = refusingReader();
    const result = await recover('reachable', [ROOT], read);

    // Two reads: the folder, then the parent that answered no. Nothing after it.
    expect(read.calls).toStrictEqual(['reachable', 'secret']);
    expect(result.outcome).toBe('detached');
  });

  it('fabricates nothing — the refused ancestor is in no result', async () => {
    const result = await recover('reachable', [ROOT], refusingReader());

    expect(result.folders.map((entry) => entry.id)).toStrictEqual(['root']);
    expect(result.folders.some((entry) => entry.id === secret.id)).toBe(false);
  });

  it('keeps the selected folder’s own identity, which was read legitimately', async () => {
    /*
     * The half that must survive. `AclGuard` said yes to this folder and no to its parent, so the
     * page may name it and may not place it — and naming it is the whole of the defect Slice 7
     * removes. What it must never do instead is fall back to the library's name.
     */
    const result = await recover('reachable', [ROOT], refusingReader());

    expect(result.selected).toStrictEqual(reachable);
    expect(result.selected?.name).toBe('reachable');
  });

  it('does not merge the detached folder, because the tree would call it a root', async () => {
    // `TreeView` promotes a node whose parent it cannot see to `aria-level="1"`. Merging here
    // would announce a folder three levels down as a top-level one — the missing ancestor
    // fabricated as an absence.
    const result = await recover('reachable', [ROOT], refusingReader());

    expect(result.folders.some((entry) => entry.id === reachable.id)).toBe(false);
  });
});

describe('F · an ancestor is not found', () => {
  it('degrades to a partial result without looping', async () => {
    const orphan = folder({ id: 'orphan', parentId: 'vanished', depth: 4 });
    const read = readerOver([orphan]);
    const result = await recover('orphan', [ROOT], read);

    expect(read.calls).toStrictEqual(['orphan', 'vanished']);
    expect(result.outcome).toBe('detached');
    expect(result.selected).toStrictEqual(orphan);
    expect(result.folders.map((entry) => entry.id)).toStrictEqual(['root']);
  });

  it('reports the selected folder as unknown when it is the one that is missing', async () => {
    const read = readerOver([]);
    const result = await recover('gone', [ROOT], read);

    expect(read.calls).toStrictEqual(['gone']);
    expect(result.outcome).toBe('unresolved');
    expect(result.selected).toBeNull();
    expect(result.folders.map((entry) => entry.id)).toStrictEqual(['root']);
  });
});

describe('G · the data contains a cycle', () => {
  it('terminates, and reads each identifier once', async () => {
    // `a → b → c → a`. Server data, so it cannot be assumed away; `folder-trail.ts` guards the
    // same shape for the same reason, and a hang here would be a page that never renders.
    const cyclic = [
      folder({ id: 'a', parentId: 'c' }),
      folder({ id: 'b', parentId: 'a' }),
      folder({ id: 'c', parentId: 'b' }),
    ];
    const read = readerOver(cyclic);
    const result = await recover('a', [ROOT], read);

    expect(read.calls).toStrictEqual(['a', 'c', 'b']);
    expect(result.reads).toBe(3);
    expect(result.outcome).toBe('detached');
    // Nothing merged: a cycle has no root to attach to.
    expect(result.folders.map((entry) => entry.id)).toStrictEqual(['root']);
  });

  it('terminates on the shortest cycle there is — a folder that is its own parent', async () => {
    const read = readerOver([folder({ id: 'self', parentId: 'self' })]);
    const result = await recover('self', [ROOT], read);

    expect(read.calls).toStrictEqual(['self']);
    expect(result.outcome).toBe('detached');
  });
});

describe('H · the chain is longer than a folder tree may be', () => {
  it('never reads more than the depth the API itself enforces', async () => {
    /*
     * `MAXIMUM_FOLDER_DEPTH` is the ceiling `checkFolderPlacement` applies to every create and
     * every move, so a chain longer than this cannot be built through the product. Reaching it
     * here means the data is wrong, and the answer to wrong data is to stop rather than to keep
     * asking.
     */
    const long = Array.from({ length: 200 }, (_, index) =>
      folder({ id: `n${String(index)}`, parentId: `n${String(index + 1)}` }),
    );
    const read = readerOver(long);
    const result = await recover('n0', [ROOT], read);

    expect(read.calls).toHaveLength(MAXIMUM_FOLDER_DEPTH);
    expect(result.reads).toBe(MAXIMUM_FOLDER_DEPTH);
    expect(result.outcome).toBe('detached');
  });

  it('states the ceiling as the API’s own number', () => {
    // Restated in the web application because it cannot import the API's module. If the two ever
    // disagree, this is the line that says which one moved.
    expect(MAXIMUM_FOLDER_DEPTH).toBe(32);
  });
});

describe('a folder belonging to another library', () => {
  it('is neither merged nor named', async () => {
    // `?libraryId=A&folderId=<in B>` is an inconsistent URL. Drawing B's structure inside A's rail
    // would be a stranger's tree; heading the page with B's folder would describe a place the list
    // below is not showing.
    const elsewhere = folder({ id: 'elsewhere', libraryId: 'lib-2', parentId: null, isRoot: true });
    const read = readerOver([elsewhere]);
    const result = await recover('elsewhere', [ROOT], read, 'lib-1');

    expect(result.outcome).toBe('unresolved');
    expect(result.selected).toBeNull();
    expect(result.folders.map((entry) => entry.id)).toStrictEqual(['root']);
  });
});

describe('the walk is sequential, because it has to be', () => {
  it('asks for a parent only after its child has named it', async () => {
    // Each response is what reveals the next identifier, so there is nothing to parallelise. This
    // asserts the ordering rather than a count, so a future "optimisation" that guessed at parents
    // fails here.
    const order: string[] = [];
    const rows = new Map(
      [
        folder({ id: 'x', parentId: 'y', depth: 3 }),
        folder({ id: 'y', parentId: 'root', depth: 2 }),
      ].map((entry) => [entry.id, entry]),
    );
    const read = vi.fn((id: string) => {
      order.push(id);
      const found = rows.get(id);
      return Promise.resolve(
        found === undefined ? failed<Folder>(ErrorCode.NOT_FOUND) : succeeded(found),
      );
    });

    await recover('x', [ROOT], read);

    expect(order).toStrictEqual(['x', 'y']);
  });
});
