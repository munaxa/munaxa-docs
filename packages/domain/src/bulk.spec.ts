import { describe, expect, it } from 'vitest';

import {
  ALL_BULK_OPERATION_KINDS,
  BulkItemOutcome,
  BulkOperationKind,
  EMPTY_TALLY,
  bulkSizeVerdict,
  countOutcome,
  normaliseTargets,
  tallyIsConsistent,
} from './bulk';

describe('bulk operation vocabulary', () => {
  it('names one kind per operation the phase builds', () => {
    expect(ALL_BULK_OPERATION_KINDS).toHaveLength(5);
    expect(ALL_BULK_OPERATION_KINDS).toContain(BulkOperationKind.RESTORE);
  });
});

describe('countOutcome', () => {
  it('keeps requested equal to the sum of the four outcomes', () => {
    const tally = [
      BulkItemOutcome.APPLIED,
      BulkItemOutcome.APPLIED,
      BulkItemOutcome.REFUSED,
      BulkItemOutcome.BLOCKED,
      BulkItemOutcome.FAILED,
    ].reduce(countOutcome, EMPTY_TALLY);

    expect(tally).toEqual({ requested: 5, applied: 2, refused: 1, blocked: 1, failed: 1 });
    expect(tallyIsConsistent(tally)).toBe(true);
  });

  // The invariant is what makes a silent skip detectable: an object that reached no branch would
  // leave `requested` ahead of the sum, and that is the defect this phase exists to prevent.
  it('detects a tally that lost an object', () => {
    expect(tallyIsConsistent({ ...EMPTY_TALLY, requested: 3, applied: 2 })).toBe(false);
  });
});

describe('normaliseTargets', () => {
  it('removes the duplicate a re-rendered selection sends twice', () => {
    expect(normaliseTargets(['b', 'a', 'b'])).toEqual(['a', 'b']);
  });

  // Sorted, so two callers editing overlapping sets take row locks in one order and queue rather
  // than deadlock. Asserting the order is what keeps somebody from "simplifying" it to a Set spread.
  it('orders them, so concurrent bulk writes cannot deadlock on each other', () => {
    expect(normaliseTargets(['c', 'a', 'b'])).toEqual(['a', 'b', 'c']);
  });

  it('answers empty for an empty selection rather than inventing one', () => {
    expect(normaliseTargets([])).toEqual([]);
  });
});

describe('bulkSizeVerdict', () => {
  it('accepts a request inside the ceiling', () => {
    expect(bulkSizeVerdict(50, 5_000)).toBe('OK');
    expect(bulkSizeVerdict(5_000, 5_000)).toBe('OK');
  });

  it('refuses one over it', () => {
    expect(bulkSizeVerdict(5_001, 5_000)).toBe('TOO_MANY');
  });

  // An empty selection is a client defect, not a successful operation over nothing. Returning OK
  // here would write an audited operation row that did nothing and report it as a success.
  it('distinguishes an empty selection from a valid one', () => {
    expect(bulkSizeVerdict(0, 5_000)).toBe('EMPTY');
  });
});
