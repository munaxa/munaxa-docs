/**
 * The scope tree's rules: how a materialised path is built, read, and kept honest.
 *
 * Pure by construction. Everything here is arithmetic on strings and arrays, which is what
 * lets the invariants below be tested exhaustively without a database — and they are the
 * invariants that decide who can see what, so that matters.
 *
 * The tree the ACL resolver walks is TENANT → COMPANY → ENTITY → DEPARTMENT, with departments
 * nesting inside departments (`packages/domain/src/scope.ts`). A branch is a location, not a
 * level: permission does not flow through one.
 */

/** Separates ancestors in a path. A UUID contains no dot, so nothing needs escaping. */
export const PATH_SEPARATOR = '.';

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
  | 'TOO_DEEP'
  | 'PARENT_IS_SELF'
  | 'PARENT_IS_DESCENDANT'
  | 'PARENT_IN_ANOTHER_ENTITY';

/**
 * The path of a node, given its parent's path.
 *
 * Ancestors first, the node itself last, so a prefix comparison answers "is A under B" and an
 * ordinary index serves it. A root department's path is just its own identifier.
 */
export function pathFor(parentPath: string | null, id: string): string {
  return parentPath ? `${parentPath}${PATH_SEPARATOR}${id}` : id;
}

/** The identifiers in a path, ancestors first, the node itself last. */
export function idsInPath(path: string): readonly string[] {
  return path.split(PATH_SEPARATOR).filter((segment) => segment.length > 0);
}

/** Ancestors only, nearest last. Empty for a root. */
export function ancestorIdsOf(path: string): readonly string[] {
  return idsInPath(path).slice(0, -1);
}

export function depthOf(path: string): number {
  return idsInPath(path).length;
}

/**
 * Whether `candidate` sits at or below `ancestor`.
 *
 * The separator matters: without it, `a.bc` would count as a descendant of `a.b`. Prefix
 * matching on identifiers is only safe when the boundary is checked too.
 */
export function isAtOrBelow(candidatePath: string, ancestorPath: string): boolean {
  return (
    candidatePath === ancestorPath ||
    candidatePath.startsWith(`${ancestorPath}${PATH_SEPARATOR}`)
  );
}

/**
 * The `LIKE` pattern matching a node and everything under it.
 *
 * `%` is the only wildcard here and paths are UUIDs and dots, so there is nothing to escape —
 * but the caller must still pass this as a bound parameter, never concatenate it.
 */
export function subtreePattern(path: string): string {
  return `${path}${PATH_SEPARATOR}%`;
}

/**
 * Whether a node may be created or moved under a parent.
 *
 * The two that matter are cycles. A node cannot be its own parent, and it cannot be moved
 * under one of its own descendants — either would produce a path that contains the node twice
 * and a walk that never terminates. Both are cheap to check here and expensive to discover
 * afterwards, because the tree is already corrupt by then.
 */
export function checkPlacement(input: {
  readonly nodeId: string | null;
  readonly nodePath: string | null;
  readonly parentId: string | null;
  readonly parentPath: string | null;
  readonly entityId: string;
  readonly parentEntityId: string | null;
}): readonly TreeRejection[] {
  const rejections: TreeRejection[] = [];

  if (input.parentId === null) {
    // A root department: only its own depth is in question, and it is 1.
    return rejections;
  }

  if (input.nodeId !== null && input.parentId === input.nodeId) {
    rejections.push('PARENT_IS_SELF');
  }

  if (input.nodePath !== null && input.parentPath !== null && isAtOrBelow(input.parentPath, input.nodePath)) {
    rejections.push('PARENT_IS_DESCENDANT');
  }

  if (input.parentEntityId !== null && input.parentEntityId !== input.entityId) {
    // A department's ancestors must all belong to the same entity, or the chain the ACL
    // resolver walks would cross a legal boundary halfway up.
    rejections.push('PARENT_IN_ANOTHER_ENTITY');
  }

  if (input.parentPath !== null && depthOf(input.parentPath) + 1 > MAXIMUM_DEPTH) {
    rejections.push('TOO_DEEP');
  }

  return rejections;
}

/**
 * The paths a subtree takes after its root moves.
 *
 * Returned rather than applied, so the caller writes them in one statement inside its own
 * transaction: a move that updates half a subtree leaves a tree in which some nodes are
 * unreachable and others are reachable twice.
 */
export function rewriteSubtree(
  descendants: readonly { readonly id: string; readonly path: string }[],
  fromPath: string,
  toPath: string,
): readonly { readonly id: string; readonly path: string }[] {
  return descendants.map((node) => ({
    id: node.id,
    path: `${toPath}${node.path.slice(fromPath.length)}`,
  }));
}

/**
 * The code rules live in `@edms/domain`, because more than one module needs the same answer —
 * Organisation validates a code on the way in, Numbering renders it on the way out. Re-exported
 * so callers inside this module have one import.
 */
export { isUsableCode, normalizeCode } from '@edms/domain';
