/**
 * The scope tree's rules: what may be a parent, and how deep the tree may go.
 *
 * The path *arithmetic* — how a materialised path is built, read and rewritten — is not here. It
 * moved to [`@edms/domain`](../../../../../../packages/domain/src/tree.ts) when folders and
 * categories turned out to need the identical answers, for the reason `isUsableCode` lives there:
 * three implementations of "is A under B" would be three answers to the question that decides who
 * can see what. The shared names are re-exported at the bottom, so callers inside this module have
 * one import exactly as they did before.
 *
 * What stays here is what is true of *this* tree and no other: the depth ceiling, and the rule
 * that a department's ancestors belong to its own entity.
 *
 * The tree the ACL resolver walks is TENANT → COMPANY → ENTITY → DEPARTMENT, with departments
 * nesting inside departments (`packages/domain/src/scope.ts`). A branch is a location, not a
 * level: permission does not flow through one.
 */

import { checkTreePlacement, depthOf } from '@edms/domain';

/**
 * How deep departments may nest.
 *
 * Not an arbitrary limit: every ACL resolution walks this chain, and a path is rebuilt for the
 * whole subtree on a move. A tree deeper than this is almost always a modelling mistake — a
 * department per person — and the cost of discovering that in production is a query that
 * degrades for everybody.
 */
export const MAXIMUM_DEPTH = 10;

export type TreeRejection =
  'TOO_DEEP' | 'PARENT_IS_SELF' | 'PARENT_IS_DESCENDANT' | 'PARENT_IN_ANOTHER_ENTITY';

/**
 * Whether a node may be created or moved under a parent.
 *
 * The cycle and depth checks are the shared ones — a node cannot be its own parent, and it cannot
 * move under one of its own descendants. The entity check is this tree's own: a department's
 * ancestors must all belong to the same entity, or the chain the ACL resolver walks would cross a
 * legal boundary halfway up.
 */
export function checkPlacement(input: {
  readonly nodeId: string | null;
  readonly nodePath: string | null;
  readonly parentId: string | null;
  readonly parentPath: string | null;
  readonly entityId: string;
  readonly parentEntityId: string | null;
}): readonly TreeRejection[] {
  const rejections: TreeRejection[] = [
    ...checkTreePlacement({
      nodeId: input.nodeId,
      nodePath: input.nodePath,
      parentId: input.parentId,
      parentPath: input.parentPath,
      maximumDepth: MAXIMUM_DEPTH,
    }),
  ];

  if (input.parentId === null) {
    // A root department: only its own depth is in question, and it is 1.
    return rejections;
  }

  if (input.parentEntityId !== null && input.parentEntityId !== input.entityId) {
    rejections.push('PARENT_IN_ANOTHER_ENTITY');
  }

  return rejections;
}

/**
 * Whether a whole subtree still fits under a new parent.
 *
 * A move has to measure the deepest leaf, not the node being moved: relocating a three-deep branch
 * under a department at depth 8 would put its leaves at 11, and `checkPlacement` alone would allow
 * it — it only ever sees the branch's own new depth.
 */
export function subtreeFitsUnder(parentPath: string | null, subtreeHeight: number): boolean {
  return (parentPath === null ? 0 : depthOf(parentPath)) + subtreeHeight <= MAXIMUM_DEPTH;
}

/**
 * The shared path arithmetic and the code rules, re-exported.
 *
 * `isUsableCode` and `normalizeCode` are in `@edms/domain` because Organisation validates a code
 * on the way in and Numbering renders it on the way out; the tree helpers are there because three
 * trees share them. Both are re-exported so callers inside this module have one import.
 */
export {
  PATH_SEPARATOR,
  ancestorIdsOf,
  depthOf,
  idsInPath,
  isAtOrBelow,
  isUsableCode,
  normalizeCode,
  pathFor,
  relativeDepthOf,
  rewriteSubtree,
  subtreePattern,
  subtreePrefix,
} from '@edms/domain';
