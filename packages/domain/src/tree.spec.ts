import { describe, expect, it } from 'vitest';

import {
  PATH_SEPARATOR,
  ancestorIdsOf,
  checkTreePlacement,
  depthOf,
  idsInPath,
  isAtOrBelow,
  pathFor,
  relativeDepthOf,
  rewriteSubtree,
  subtreePattern,
  subtreePrefix,
} from './tree';

/**
 * Three trees share this arithmetic — departments, folders, categories — and one of them decides
 * who can read what. So these are the cases that would be a security defect rather than a bug, and
 * they are asserted exhaustively because being pure is what makes that possible.
 */

describe('building a path', () => {
  it('puts ancestors first and the node last', () => {
    expect(pathFor(null, 'a')).toBe('a');
    expect(pathFor('a', 'b')).toBe('a.b');
    expect(pathFor('a.b', 'c')).toBe('a.b.c');
  });

  it('treats an empty parent path as no parent', () => {
    // A caller reading a root's parent path out of a database gets '' as easily as null, and a
    // path of '.a' would make the node a child of a node with no identifier.
    expect(pathFor('', 'a')).toBe('a');
  });
});

describe('reading a path', () => {
  it('names the identifiers in order', () => {
    expect(idsInPath('a.b.c')).toEqual(['a', 'b', 'c']);
  });

  it('gives the ancestors nearest last, and nothing for a root', () => {
    expect(ancestorIdsOf('a.b.c')).toEqual(['a', 'b']);
    expect(ancestorIdsOf('a')).toEqual([]);
  });

  it('ignores empty segments rather than counting them as depth', () => {
    // A malformed path must not read as deeper than it is, or the depth ceiling can be evaded by
    // writing one.
    expect(depthOf('a..b')).toBe(2);
    expect(depthOf('')).toBe(0);
  });
});

describe('containment', () => {
  it('counts a node as at or below itself', () => {
    // "At or below" is what an ACL grant means: a grant on a folder applies to that folder.
    expect(isAtOrBelow('a.b', 'a.b')).toBe(true);
  });

  it('counts a real descendant', () => {
    expect(isAtOrBelow('a.b.c', 'a.b')).toBe(true);
    expect(isAtOrBelow('a.b.c.d', 'a')).toBe(true);
  });

  it('does not count an ancestor as a descendant', () => {
    expect(isAtOrBelow('a.b', 'a.b.c')).toBe(false);
  });

  it('does not count a sibling', () => {
    expect(isAtOrBelow('a.c', 'a.b')).toBe(false);
  });

  it('refuses a bare prefix that is not separated', () => {
    // The single most important case here. Without the separator check, `a.bc` is "under" `a.b`,
    // and an ACL granted on one node silently reaches another whose identifier merely starts with
    // the same characters.
    expect(isAtOrBelow('a.bc', 'a.b')).toBe(false);
    expect(isAtOrBelow('ab', 'a')).toBe(false);
  });

  it('builds a subtree pattern and prefix that agree with each other', () => {
    expect(subtreePattern('a.b')).toBe(`a.b${PATH_SEPARATOR}%`);
    // The prefix is the pattern without its wildcard — the form a `startsWith` query wants. If
    // these two ever disagree, the SQL and the pure check would answer differently.
    expect(subtreePrefix('a.b')).toBe(subtreePattern('a.b').slice(0, -1));
  });
});

describe('placement', () => {
  const deep = { maximumDepth: 3 };

  it('allows a root whatever the ceiling', () => {
    expect(
      checkTreePlacement({ nodeId: 'a', nodePath: 'a', parentId: null, parentPath: null, ...deep }),
    ).toEqual([]);
  });

  it('allows an ordinary child', () => {
    expect(
      checkTreePlacement({ nodeId: null, nodePath: null, parentId: 'a', parentPath: 'a', ...deep }),
    ).toEqual([]);
  });

  it('refuses a node as its own parent', () => {
    expect(
      checkTreePlacement({ nodeId: 'a', nodePath: 'a', parentId: 'a', parentPath: 'a', ...deep }),
    ).toContain('PARENT_IS_SELF');
  });

  it('refuses a move under the node’s own descendant', () => {
    // Both of these produce a path containing the node twice and a walk that never terminates.
    expect(
      checkTreePlacement({
        nodeId: 'b',
        nodePath: 'a.b',
        parentId: 'c',
        parentPath: 'a.b.c',
        ...deep,
      }),
    ).toContain('PARENT_IS_DESCENDANT');
  });

  it('refuses a child that would breach the ceiling', () => {
    expect(
      checkTreePlacement({
        nodeId: null,
        nodePath: null,
        parentId: 'c',
        parentPath: 'a.b.c',
        ...deep,
      }),
    ).toContain('TOO_DEEP');
  });

  it('allows a child exactly at the ceiling', () => {
    // Off-by-one in the other direction: a limit of 3 must permit a node at depth 3.
    expect(
      checkTreePlacement({
        nodeId: null,
        nodePath: null,
        parentId: 'b',
        parentPath: 'a.b',
        ...deep,
      }),
    ).toEqual([]);
  });

  it('reports every reason, not the first', () => {
    // An administrator fixing one problem and hitting the next is a worse experience than being
    // told both, and the caller renders a list.
    const rejections = checkTreePlacement({
      nodeId: 'c',
      nodePath: 'a.b.c',
      parentId: 'c',
      parentPath: 'a.b.c',
      maximumDepth: 3,
    });
    expect(rejections).toEqual(
      expect.arrayContaining(['PARENT_IS_SELF', 'PARENT_IS_DESCENDANT', 'TOO_DEEP']),
    );
  });
});

describe('rewriting a subtree after a move', () => {
  it('re-roots every descendant', () => {
    const moved = rewriteSubtree(
      [
        { id: 'b', path: 'a.b' },
        { id: 'c', path: 'a.b.c' },
        { id: 'd', path: 'a.b.c.d' },
      ],
      'a.b',
      'x.y.b',
    );

    expect(moved).toEqual([
      { id: 'b', path: 'x.y.b' },
      { id: 'c', path: 'x.y.b.c' },
      { id: 'd', path: 'x.y.b.c.d' },
    ]);
  });

  it('re-roots to the top level', () => {
    expect(rewriteSubtree([{ id: 'b', path: 'a.b' }], 'a.b', 'b')).toEqual([
      { id: 'b', path: 'b' },
    ]);
  });

  it('leaves relative depth unchanged', () => {
    // A move relocates a subtree; it never reshapes it. If this changed, the ceiling check made
    // before the move would be measuring a different tree from the one written after it.
    const before = [
      { id: 'b', path: 'a.b' },
      { id: 'c', path: 'a.b.c' },
    ];
    const after = rewriteSubtree(before, 'a.b', 'x.b');

    expect(relativeDepthOf(after, 'x.b')).toBe(relativeDepthOf(before, 'a.b'));
  });
});

describe('measuring a subtree', () => {
  it('counts the root alone as one', () => {
    expect(relativeDepthOf([{ path: 'a.b' }], 'a.b')).toBe(1);
  });

  it('counts the deepest leaf, not the number of nodes', () => {
    // The number that matters for a ceiling check is the height. A wide, shallow subtree fits
    // where a narrow, deep one does not.
    expect(
      relativeDepthOf(
        [{ path: 'a.b' }, { path: 'a.b.c' }, { path: 'a.b.d' }, { path: 'a.b.c.e' }],
        'a.b',
      ),
    ).toBe(3);
  });

  it('is one for an empty subtree, so a caller never gets zero', () => {
    // A subtree read that returned nothing — a node deleted between two queries — must not make
    // the ceiling arithmetic think the branch has no height and let a too-deep move through.
    expect(relativeDepthOf([], 'a.b')).toBe(1);
  });
});
