import { type TreePlacementRejection, checkTreePlacement } from '@edms/domain';

/**
 * The category tree's own rule: how deep it may nest.
 *
 * The path arithmetic is shared — `@edms/domain`'s `tree.ts`, the same code departments and folders
 * use — because "is A under B" must mean the same thing in all three. What differs is the ceiling and
 * what may be a parent, and for categories the answer to the second is "any other category": a
 * classification tree crosses folders and entities by design, which is exactly what makes it useful
 * alongside them (`03-domain-model.md` §3).
 */

/**
 * How deep categories may nest.
 *
 * Shallower than folders (32) and deeper than departments (10), and both comparisons are deliberate.
 * A category tree is a *browsing* structure a person navigates by reading labels, and past half a
 * dozen levels nobody can hold the path in their head — but classification schemes published by
 * standards bodies routinely run to five or six, so the ceiling has to clear those comfortably.
 */
export const MAXIMUM_CATEGORY_DEPTH = 8;

export type CategoryRejection = TreePlacementRejection;

/** Whether a category may be created or moved under a parent. Cycles and depth; nothing else. */
export function checkCategoryPlacement(input: {
  readonly nodeId: string | null;
  readonly nodePath: string | null;
  readonly parentId: string | null;
  readonly parentPath: string | null;
}): readonly CategoryRejection[] {
  return checkTreePlacement({ ...input, maximumDepth: MAXIMUM_CATEGORY_DEPTH });
}
