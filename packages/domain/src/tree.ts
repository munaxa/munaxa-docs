/**
 * Materialised-path arithmetic — how ancestry is written down, read back, and kept honest.
 *
 * Three trees in this product store their ancestry the same way, and they must agree about it to
 * the character: departments (the scope chain the ACL resolver walks), folders (the tree below a
 * library) and categories (business classification). Each has its own rules about *what may be a
 * parent* — a department's ancestors must share its entity, a folder's must share its library, a
 * root folder may have none at all — and none of them has its own rules about what a path *is*.
 *
 * So the shape lives here, in the pure package, for the reason `isUsableCode` does: more than one
 * module needs the same answer, and a second implementation of "is A under B" is a second answer
 * to a question that decides who can see what.
 *
 * Everything here is arithmetic on strings and arrays. Being pure is what lets it be tested
 * exhaustively without a database, which matters more than usual for code whose failure mode is a
 * permission reaching a node it was never granted on.
 */

/** Separates ancestors in a path. A UUID contains no dot, so nothing needs escaping. */
export const PATH_SEPARATOR = '.';

/** Why a node may not sit where it was asked to. Tree-shaped reasons only. */
export type TreePlacementRejection = 'TOO_DEEP' | 'PARENT_IS_SELF' | 'PARENT_IS_DESCENDANT';

/**
 * The path of a node, given its parent's path.
 *
 * Ancestors first, the node itself last, so a prefix comparison answers "is A under B" and an
 * ordinary index serves it. A root's path is just its own identifier.
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
 * The separator matters: without it, `a.bc` would count as a descendant of `a.b`. Prefix matching
 * on identifiers is only safe when the boundary is checked too — and the consequence of getting it
 * wrong is an ACL granted on one node reaching another.
 */
export function isAtOrBelow(candidatePath: string, ancestorPath: string): boolean {
  return (
    candidatePath === ancestorPath || candidatePath.startsWith(`${ancestorPath}${PATH_SEPARATOR}`)
  );
}

/**
 * The `LIKE` pattern matching a node and everything under it.
 *
 * `%` is the only wildcard here and paths are UUIDs and dots, so there is nothing to escape — but
 * the caller must still pass this as a bound parameter, never concatenate it.
 */
export function subtreePattern(path: string): string {
  return `${path}${PATH_SEPARATOR}%`;
}

/** The literal prefix a descendant's path begins with — the pattern without its wildcard. */
export function subtreePrefix(path: string): string {
  return `${path}${PATH_SEPARATOR}`;
}

/**
 * The cycle and depth checks every tree shares.
 *
 * The two cycle cases are the ones that matter: a node cannot be its own parent, and it cannot
 * move under one of its own descendants. Either produces a path containing the node twice and a
 * walk that never terminates — cheap to refuse here, and expensive to discover afterwards,
 * because by then the tree is already corrupt.
 *
 * A caller adds its own rules on top; this deliberately knows nothing about entities, libraries or
 * what may be a root.
 */
export function checkTreePlacement(input: {
  /** Null when creating: there is no node yet to be its own ancestor. */
  readonly nodeId: string | null;
  readonly nodePath: string | null;
  /** Null for a root. */
  readonly parentId: string | null;
  readonly parentPath: string | null;
  readonly maximumDepth: number;
}): readonly TreePlacementRejection[] {
  const rejections: TreePlacementRejection[] = [];

  if (input.parentId === null) {
    // A root: its own depth is 1, which no ceiling forbids.
    return rejections;
  }

  if (input.nodeId !== null && input.parentId === input.nodeId) {
    rejections.push('PARENT_IS_SELF');
  }

  if (
    input.nodePath !== null &&
    input.parentPath !== null &&
    isAtOrBelow(input.parentPath, input.nodePath)
  ) {
    rejections.push('PARENT_IS_DESCENDANT');
  }

  if (input.parentPath !== null && depthOf(input.parentPath) + 1 > input.maximumDepth) {
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
 * The deepest node in a subtree, measured from the subtree's own root.
 *
 * A move has to check the *whole* subtree against the ceiling, not just the node being moved:
 * dragging a three-deep branch under a node at depth 30 puts its leaves at 33, and checking only
 * the branch's own new depth would let that through.
 */
export function relativeDepthOf(
  descendants: readonly { readonly path: string }[],
  rootPath: string,
): number {
  const rootDepth = depthOf(rootPath);
  return descendants.reduce(
    (deepest, node) => Math.max(deepest, depthOf(node.path) - rootDepth + 1),
    1,
  );
}
