import { VersionConflictError } from '../errors/application-errors';

/**
 * Optimistic locking, said once.
 *
 * Two administrators editing the same document type is ordinary, and the failure it must not
 * produce is the silent one: the second save overwriting fields the first changed, with both
 * screens showing success. The `version` column makes the second writer lose loudly
 * (`05-database-design.md` §6).
 */

/**
 * Checks the version the caller loaded against the one the row now holds.
 *
 * `expected` is optional because `If-Match` is optional on the wire, and that is a deliberate
 * asymmetry rather than an oversight: a client that does not participate in optimistic locking —
 * a script, a migration tool — should not be forced to read before every write. A client that
 * *does* send a version gets the guarantee. The endpoints that must not be used blindly are the
 * ones that call `requireVersion` instead.
 */
export function checkVersion(expected: number | undefined, actual: number): void {
  if (expected !== undefined && expected !== actual) {
    throw new VersionConflictError(expected, actual);
  }
}

/**
 * The same check, where skipping it is not an option.
 *
 * Used where a blind write would destroy something a reload would have shown the caller: editing
 * a workflow version's stages, changing a role's permission set, moving a subtree. In each of
 * those the previous value is not recoverable from the new one.
 */
export function requireVersion(expected: number | undefined, actual: number): void {
  if (expected === undefined) {
    // Reported as a conflict rather than a validation failure, because that is what it is: the
    // caller is writing over a state they have not seen. The detail names both numbers, and the
    // absent one is reported as -1 so a client can tell "I sent nothing" from "I sent 3".
    throw new VersionConflictError(-1, actual);
  }
  checkVersion(expected, actual);
}

/**
 * The number a row moves to after a write.
 *
 * Trivial, and here anyway: `version + 1` written at eighteen call sites is eighteen places to
 * write `version` and mean `version + 1`, and the resulting off-by-one presents as a phantom
 * conflict on the *next* save rather than as a failure on this one.
 */
export function nextVersion(current: number): number {
  return current + 1;
}
