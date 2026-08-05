/**
 * Bulk operations, as vocabulary — Phase 16.
 *
 * Five operations sit behind one shape, and the shape is the decision. A bulk operation in this
 * product is **N single-object decisions that happen to have been asked for together**, never one
 * decision applied to N objects: `08-permission-model.md` §7 forbids fetch-then-filter for exactly
 * the reason that makes the shortcut tempting here, and a bulk implementation that resolved reach
 * once and then wrote to a list of client-supplied identifiers would be fetch-then-filter wearing
 * a new hat — worse, because it writes.
 *
 * So the vocabulary carries an outcome **per object**, and there is no representation of "the
 * operation succeeded" that does not name what each object did. A caller who selected forty
 * documents and reached thirty-eight of them gets thirty-eight applied, two refused, and the
 * reason for each — rather than a silent thirty-eight, which is the failure mode that makes
 * somebody believe they archived a folder they did not.
 *
 * Pure, so the API, the worker and the browser all speak it: the web client renders the per-object
 * outcomes from the same union the consumer writes.
 */

/** What is being done, in bulk. One kind per row so the record is queryable by act. */
export const BulkOperationKind = {
  /** N already-uploaded files become N documents in one folder. */
  UPLOAD: 'UPLOAD',
  /** N documents take the same metadata change. */
  METADATA: 'METADATA',
  /** N approval tasks are decided the same way. */
  APPROVAL: 'APPROVAL',
  /** N deleted documents come back, each reversing exactly one delete. */
  RESTORE: 'RESTORE',
  /** N documents' bytes leave, as one package with a manifest. */
  EXPORT: 'EXPORT',
} as const;

export type BulkOperationKindKey = (typeof BulkOperationKind)[keyof typeof BulkOperationKind];

export const ALL_BULK_OPERATION_KINDS: readonly BulkOperationKindKey[] = Object.freeze(
  Object.values(BulkOperationKind),
);

/**
 * Where the operation as a whole has got to.
 *
 * Deliberately the same four names as `ReportExportState` and `AuditExportState`, and deliberately
 * a third type rather than a shared one — for the reason Phase 15 wrote down when it declined to
 * share the second: three tables with three lifecycles that agree today, and a fifth state added
 * for one of them must not silently appear in the others' columns.
 *
 * `COMPLETED` here means *the operation ran to the end*, not *every object succeeded*. An
 * operation over forty documents that refused two is `COMPLETED` with a `refused` count of two,
 * because the refusals are the answer rather than a failure to produce one. `FAILED` is reserved
 * for the operation itself not finishing — the lane died, the tenant's database went away — which
 * is the only case where the per-object outcomes are incomplete and a caller must not read the
 * counts as final.
 */
export const BulkOperationState = {
  REQUESTED: 'REQUESTED',
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
} as const;

export type BulkOperationStateKey = (typeof BulkOperationState)[keyof typeof BulkOperationState];

/**
 * What one object did.
 *
 * Four outcomes rather than a boolean, because "it did not happen" has three distinct causes and
 * an operator needs to tell them apart. `REFUSED` is a permission answer — the caller could not
 * have done this to this object singly. `BLOCKED` is a rule answer — they could have, and
 * something about the object said no (a legal hold, a version that moved, a document already
 * live). `FAILED` is neither: something broke.
 *
 * The distinction is not cosmetic. A screenful of `REFUSED` means somebody selected across a
 * boundary they cannot see through and the product behaved correctly; a screenful of `BLOCKED`
 * means a matter is on hold and somebody should be told; a screenful of `FAILED` is an incident.
 * Collapsing them into "42 of 50 succeeded" makes all three look the same.
 */
export const BulkItemOutcome = {
  APPLIED: 'APPLIED',
  /** The caller does not reach this object. Their reach was resolved for *this* object. */
  REFUSED: 'REFUSED',
  /** Reachable, and a rule said no — `LEGAL_HOLD`, a version conflict, an illegal transition. */
  BLOCKED: 'BLOCKED',
  FAILED: 'FAILED',
} as const;

export type BulkItemOutcomeKey = (typeof BulkItemOutcome)[keyof typeof BulkItemOutcome];

/** The tally an operation row carries and a summary notification renders. */
export interface BulkTally {
  readonly requested: number;
  readonly applied: number;
  readonly refused: number;
  readonly blocked: number;
  readonly failed: number;
}

export const EMPTY_TALLY: BulkTally = Object.freeze({
  requested: 0,
  applied: 0,
  refused: 0,
  blocked: 0,
  failed: 0,
});

/**
 * Counts one outcome into a tally.
 *
 * `requested` moves with every outcome, so `requested` always equals the sum of the other four —
 * an invariant `tallyIsConsistent` states and the unit test asserts. A tally where they disagree
 * means an object was dropped between the request and the record, which is precisely the silent
 * skip this phase exists to make impossible.
 */
export function countOutcome(tally: BulkTally, outcome: BulkItemOutcomeKey): BulkTally {
  return {
    requested: tally.requested + 1,
    applied: tally.applied + (outcome === BulkItemOutcome.APPLIED ? 1 : 0),
    refused: tally.refused + (outcome === BulkItemOutcome.REFUSED ? 1 : 0),
    blocked: tally.blocked + (outcome === BulkItemOutcome.BLOCKED ? 1 : 0),
    failed: tally.failed + (outcome === BulkItemOutcome.FAILED ? 1 : 0),
  };
}

export function tallyIsConsistent(tally: BulkTally): boolean {
  return tally.requested === tally.applied + tally.refused + tally.blocked + tally.failed;
}

/**
 * De-duplicates and orders the identifiers a request named.
 *
 * A client that sends the same document twice — a drag-select over a list that re-rendered, a
 * retried request concatenated to the first — must not have it acted on twice. For a metadata edit
 * that is merely wasteful; for a restore it is a second `RESTORED` audit row for one act, and for
 * an approval it is a decision attempted against a task the first pass already closed.
 *
 * Sorted as well as de-duplicated, and that is the part worth stating: two callers bulk-editing
 * overlapping sets take row locks in the same order, so they queue rather than deadlock. Unsorted
 * input is how a bulk update deadlocks under exactly the concurrency it was built for.
 */
export function normaliseTargets(ids: readonly string[]): readonly string[] {
  return [...new Set(ids)].sort();
}

/**
 * Whether a request is within the tenant's ceiling.
 *
 * Its own function rather than a comparison at the call site, because five call sites compare it
 * and the interesting case is the one a reviewer skips: an *empty* selection. Zero objects is not
 * a valid bulk operation — it produces an audited operation row that did nothing, and a caller who
 * sent it has a client bug they should be told about rather than a success they should believe.
 */
export function bulkSizeVerdict(count: number, maxObjects: number): 'OK' | 'EMPTY' | 'TOO_MANY' {
  if (count === 0) {
    return 'EMPTY';
  }
  return count > maxObjects ? 'TOO_MANY' : 'OK';
}
