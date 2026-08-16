import { describe, expect, it } from 'vitest';

import { folder } from '../../test/fixtures';
import { folderTrail } from './folder-trail';

/**
 * The breadcrumb's ancestry, which is the half of "where am I" the crumb never carried.
 *
 * Every case here is one the running product can actually produce. The two that look defensive are
 * the two worth having: `documents/page.tsx` fetches folders at the API's maximum page size of 100,
 * so a genuinely missing ancestor is a library with 101 folders rather than a corrupted database;
 * and a `parentId` cycle is the difference between a wrong breadcrumb and a hung render.
 */
const root = folder({
  id: 'root',
  parentId: null,
  name: 'Quality Management',
  isRoot: true,
  depth: 1,
  childCount: 3,
});
const quality = folder({ id: 'quality', parentId: 'root', name: 'Quality', depth: 2 });
const sop = folder({ id: 'sop', parentId: 'quality', name: 'SOP', depth: 3, childCount: 0 });

const names = (trail: readonly { name: string }[]): string[] => trail.map((node) => node.name);

describe('folderTrail', () => {
  it('is empty when no folder is selected', () => {
    expect(folderTrail([root, quality, sop], null)).toStrictEqual([]);
  });

  it('is empty when the selected folder is not in the list', () => {
    // Not an error: the caller renders a shorter breadcrumb rather than a wrong one.
    expect(folderTrail([root, quality], 'sop')).toStrictEqual([]);
  });

  it('is the folder itself at the root', () => {
    expect(names(folderTrail([root, quality, sop], 'root'))).toStrictEqual(['Quality Management']);
  });

  it('reads root first, however the folders arrive', () => {
    // Deliberately unsorted. The walk follows `parentId`, so the input order must not matter — and
    // the API returns folders in path order, which is not this order.
    expect(names(folderTrail([sop, root, quality], 'sop'))).toStrictEqual([
      'Quality Management',
      'Quality',
      'SOP',
    ]);
  });

  it('stops where the chain breaks rather than inventing the rest', () => {
    /*
     * `quality` is absent — the 101st folder in a library fetched a hundred at a time. The trail
     * that can be established is the one that gets rendered: "SOP" alone is true, and a crumb
     * claiming SOP sits directly under the library root would not be.
     */
    expect(names(folderTrail([root, sop], 'sop'))).toStrictEqual(['SOP']);
  });

  it('terminates on a parentId cycle instead of hanging the render', () => {
    const a = folder({ id: 'a', parentId: 'b', name: 'A' });
    const b = folder({ id: 'b', parentId: 'a', name: 'B' });
    // Without the `seen` guard this call never returns, and the failure a reader sees is a blank
    // page rather than a wrong breadcrumb.
    expect(names(folderTrail([a, b], 'a'))).toStrictEqual(['B', 'A']);
  });
});
