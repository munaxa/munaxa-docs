import { type ActionResult, succeeded } from '../../lib/admin/action-result';

/**
 * The fields a form actually changed.
 *
 * Every update endpoint in Administration is a `PATCH` whose meaning is "change what I name", and
 * naming a field that did not change is not harmless: it bumps the record's version, invalidating
 * anybody else's `If-Match`, and it writes an audit event describing a change that did not happen.
 * An audit trail full of no-op edits is an audit trail nobody reads.
 *
 * Comparison is by value, through `JSON.stringify` for anything that is not a primitive. That is
 * enough here and its limit is worth stating: it compares *order* as well as content, so reordering
 * a list counts as a change. For these forms that is correct — the order of a role's permissions is
 * not meaningful, but the order of a numbering rule's segments and a workflow's stages is exactly
 * what they mean.
 */
export function changedFields<TBody extends Record<string, unknown>>(
  current: Readonly<Record<string, unknown>>,
  next: TBody,
): Partial<TBody> {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(next)) {
    if (!same(current[key], value)) {
      patch[key] = value;
    }
  }
  return patch as Partial<TBody>;
}

/** Whether a computed patch would ask the server for nothing. */
export function isEmptyPatch(patch: Readonly<Record<string, unknown>>): boolean {
  return Object.keys(patch).length === 0;
}

/**
 * The answer to a save that changed nothing.
 *
 * Reported as success rather than sent, because it *is* the state the administrator asked for. The
 * alternative is a request the API correctly refuses with "name at least one field to change", which
 * reads as a failure to somebody who simply pressed Save twice.
 */
export function unchanged(): Promise<ActionResult<null>> {
  return Promise.resolve(succeeded(null));
}

function same(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }
  return JSON.stringify(left) === JSON.stringify(right);
}
