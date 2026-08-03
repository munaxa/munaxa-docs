import { describe, expect, it } from 'vitest';

import { isUsableCode, normalizeCode } from '@edms/domain';

import {
  MAXIMUM_DEPTH,
  ancestorIdsOf,
  checkPlacement,
  depthOf,
  idsInPath,
  isAtOrBelow,
  pathFor,
  rewriteSubtree,
  subtreePattern,
} from './scope-tree';

const A = 'aaaaaaaa-0000-7000-8000-000000000001';
const B = 'bbbbbbbb-0000-7000-8000-000000000002';
const C = 'cccccccc-0000-7000-8000-000000000003';

describe('paths', () => {
  it('puts a root at its own identifier', () => {
    expect(pathFor(null, A)).toBe(A);
    expect(depthOf(pathFor(null, A))).toBe(1);
  });

  it('appends to the parent, ancestors first', () => {
    const parent = pathFor(null, A);
    const child = pathFor(parent, B);

    expect(child).toBe(`${A}.${B}`);
    expect(idsInPath(child)).toEqual([A, B]);
    expect(ancestorIdsOf(child)).toEqual([A]);
  });

  it('reports no ancestors for a root', () => {
    expect(ancestorIdsOf(pathFor(null, A))).toEqual([]);
  });
});

describe('containment', () => {
  const parent = `${A}.${B}`;

  it('counts a node as at-or-below itself', () => {
    expect(isAtOrBelow(parent, parent)).toBe(true);
  });

  it('recognises a descendant', () => {
    expect(isAtOrBelow(`${parent}.${C}`, parent)).toBe(true);
  });

  it('does not mistake a shared prefix for ancestry', () => {
    // The separator is what makes this safe. Without it `a.bc` is "under" `a.b`, and an ACL
    // granted on one department would silently reach another.
    expect(isAtOrBelow(`${A}.${B}x`, parent)).toBe(false);
    expect(isAtOrBelow(`${A}.${B}${C}`, parent)).toBe(false);
  });

  it('does not treat an ancestor as a descendant', () => {
    expect(isAtOrBelow(A, parent)).toBe(false);
  });

  it('builds a subtree pattern that ends at the separator', () => {
    expect(subtreePattern(parent)).toBe(`${parent}.%`);
  });
});

describe('placement', () => {
  const base = { nodeId: C, nodePath: `${A}.${C}`, entityId: 'entity-1', parentEntityId: 'entity-1' };

  it('accepts a root, which has no parent to check', () => {
    expect(
      checkPlacement({ ...base, parentId: null, parentPath: null, parentEntityId: null }),
    ).toEqual([]);
  });

  it('accepts an ordinary child', () => {
    expect(checkPlacement({ ...base, parentId: A, parentPath: A })).toEqual([]);
  });

  it('refuses a node as its own parent', () => {
    expect(checkPlacement({ ...base, parentId: C, parentPath: `${A}.${C}` })).toContain(
      'PARENT_IS_SELF',
    );
  });

  it('refuses a move under its own descendant', () => {
    // The cycle case. Allowing it produces a path containing the node twice and a walk that
    // never terminates — corrupt the moment it commits, and expensive to discover later.
    expect(
      checkPlacement({ ...base, parentId: B, parentPath: `${A}.${C}.${B}` }),
    ).toContain('PARENT_IS_DESCENDANT');
  });

  it('refuses a parent in another entity', () => {
    // Otherwise the chain the resolver walks crosses a legal boundary halfway up.
    expect(
      checkPlacement({ ...base, parentId: A, parentPath: A, parentEntityId: 'entity-2' }),
    ).toContain('PARENT_IN_ANOTHER_ENTITY');
  });

  it('refuses nesting past the maximum depth', () => {
    const deep = Array.from({ length: MAXIMUM_DEPTH }, (_, index) => `d${index}`).join('.');

    expect(checkPlacement({ ...base, parentId: A, parentPath: deep })).toContain('TOO_DEEP');
  });

  it('allows nesting up to the maximum', () => {
    const atLimit = Array.from({ length: MAXIMUM_DEPTH - 1 }, (_, index) => `d${index}`).join('.');

    expect(checkPlacement({ ...base, parentId: A, parentPath: atLimit })).toEqual([]);
  });

  it('reports every reason at once', () => {
    const rejections = checkPlacement({
      ...base,
      parentId: C,
      parentPath: `${A}.${C}`,
      parentEntityId: 'entity-2',
    });

    expect(rejections).toEqual(expect.arrayContaining(['PARENT_IS_SELF', 'PARENT_IN_ANOTHER_ENTITY']));
  });
});

describe('moving a subtree', () => {
  it('rewrites every descendant onto the new root', () => {
    const moved = rewriteSubtree(
      [
        { id: C, path: `${A}.${B}.${C}` },
        { id: 'grandchild', path: `${A}.${B}.${C}.grandchild` },
      ],
      `${A}.${B}`,
      `${A}`,
    );

    expect(moved).toEqual([
      { id: C, path: `${A}.${C}` },
      { id: 'grandchild', path: `${A}.${C}.grandchild` },
    ]);
  });

  it('preserves depth below the moved node', () => {
    const [moved] = rewriteSubtree([{ id: C, path: `${A}.${B}.${C}` }], `${A}.${B}`, `${A}.x.y`);

    expect(depthOf(moved!.path)).toBe(4);
  });
});

describe('codes', () => {
  it('accepts what survives a photocopier and a phone call', () => {
    expect(isUsableCode('QA')).toBe(true);
    expect(isUsableCode('QA-DOC')).toBe(true);
    expect(isUsableCode('A1')).toBe(true);
  });

  it('refuses what a document number could not carry', () => {
    expect(isUsableCode('')).toBe(false);
    expect(isUsableCode('-LEADING')).toBe(false);
    expect(isUsableCode('HAS SPACE')).toBe(false);
    expect(isUsableCode('SLASH/ES')).toBe(false);
    expect(isUsableCode('A'.repeat(17))).toBe(false);
  });

  it('compares case-insensitively, because people type these', () => {
    expect(normalizeCode(' qa ')).toBe('QA');
    expect(normalizeCode('Qa')).toBe(normalizeCode('qA'));
  });
});
