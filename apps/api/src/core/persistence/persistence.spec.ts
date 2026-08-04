import { describe, expect, it } from 'vitest';

import { ErrorCode } from '@edms/domain';
import { DEFAULT_PAGE_SIZE } from '@edms/utils';

import { aRequestContext } from '../../testing/factories';
import { runWithContext } from '../tenancy/tenant-context';
import {
  deletedCondition,
  escapeLikeTerm,
  orderByFor,
  pageArgs,
  searchConditions,
} from './listing';
import { checkVersion, nextVersion, requireVersion } from './optimistic-lock';
import { RecordStamps } from './record-stamps';

/**
 * The pieces every administered resource shares, tested where the shared-ness is the risk: a
 * mistake here is a mistake in eighteen places at once, and each of these functions has a wrong
 * implementation that looks right and passes a test that is not looking for it.
 */

/** A clock that does not advance, so "the same instant" is falsifiable rather than merely likely. */
function frozenClockAt(iso: string) {
  const instant = new Date(iso);
  return {
    now: () => new Date(instant),
    timestamp: () => 0,
    elapsedMs: () => 0,
  };
}

describe('record stamps', () => {
  it('gives a new row one instant, not two', () => {
    // The defect this exists to prevent: two `new Date()` calls a millisecond apart, leaving a
    // row whose created_at and updated_at disagree about when it was created. Nothing fails, and
    // "was this ever edited?" becomes unanswerable.
    const stamps = new RecordStamps(frozenClockAt('2026-03-01T10:00:00.000Z'));
    const context = aRequestContext();

    const creation = runWithContext(context, () => stamps.creation());

    expect(creation.createdAt.toISOString()).toBe('2026-03-01T10:00:00.000Z');
    expect(creation.updatedAt).toEqual(creation.createdAt);
    expect(creation.createdBy).toBe(context.userId);
    expect(creation.updatedBy).toBe(context.userId);
  });

  it('moves the change stamps when something is deleted', () => {
    // A delete is a change to the row. A recycle bin sorted by "last changed" that ignored
    // deletions would put the thing you just deleted at the bottom of the list.
    const stamps = new RecordStamps(frozenClockAt('2026-03-01T10:00:00.000Z'));
    const context = aRequestContext();

    const deletion = runWithContext(context, () => stamps.deletion());

    expect(deletion.deletedAt).toEqual(deletion.updatedAt);
    expect(deletion.deletedBy).toBe(context.userId);
    expect(deletion.updatedBy).toBe(context.userId);
  });

  it('clears both delete columns on restore', () => {
    // Clearing one and not the other leaves a row that is live by one query and deleted by
    // another, depending on which column that query happens to filter on.
    const stamps = new RecordStamps(frozenClockAt('2026-03-01T10:00:00.000Z'));

    const restoration = runWithContext(aRequestContext(), () => stamps.restoration());

    expect(restoration.deletedAt).toBeNull();
    expect(restoration.deletedBy).toBeNull();
  });

  it('records the system as the actor when nobody is acting', () => {
    // Provisioning writes the first rows before any user exists. Null is the truth, and it is why
    // every actor column is nullable.
    const stamps = new RecordStamps(frozenClockAt('2026-03-01T10:00:00.000Z'));

    const creation = runWithContext(aRequestContext({ userId: null }), () => stamps.creation());

    expect(creation.createdBy).toBeNull();
  });

  it('takes identifiers from the same clock, so a frozen clock gives ordered ids', () => {
    // `uuidv7()` defaults to `Date.now()`, which is exactly the hidden clock read that injecting a
    // clock is meant to remove. A v7 identifier encodes its timestamp in the first 48 bits, so
    // ids minted from one frozen instant share that prefix.
    const stamps = new RecordStamps(frozenClockAt('2026-03-01T10:00:00.000Z'));

    const first = runWithContext(aRequestContext(), () => stamps.nextId());
    const second = runWithContext(aRequestContext(), () => stamps.nextId());

    expect(first.slice(0, 13)).toBe(second.slice(0, 13));
    expect(first).not.toBe(second);
  });

  it('refuses to stamp outside a request context', () => {
    // Better to fail than to write a row attributed to nobody because the context was missing
    // rather than because the system genuinely acted alone.
    const stamps = new RecordStamps(frozenClockAt('2026-03-01T10:00:00.000Z'));

    try {
      stamps.creation();
      expect.unreachable('stamping without a context must fail');
    } catch (error) {
      expect(error).toMatchObject({ code: ErrorCode.UNAUTHENTICATED });
    }
  });
});

describe('optimistic locking', () => {
  it('passes when the versions agree', () => {
    expect(() => checkVersion(3, 3)).not.toThrow();
  });

  it('rejects a stale version, naming both numbers', () => {
    try {
      checkVersion(2, 5);
      expect.unreachable('a stale version must be rejected');
    } catch (error) {
      expect(error).toMatchObject({
        code: ErrorCode.VERSION_CONFLICT,
        details: { expectedVersion: 2, actualVersion: 5 },
      });
    }
  });

  it('lets a caller who sent no version through, on endpoints that allow it', () => {
    // `If-Match` is optional on the wire, so a script that does not read before writing is not
    // forced to. The endpoints where that would destroy something use `requireVersion`.
    expect(() => checkVersion(undefined, 5)).not.toThrow();
  });

  it('rejects a missing version where one is required', () => {
    // Reported as a conflict rather than a validation failure, because that is what it is: writing
    // over a state the caller has not seen.
    try {
      requireVersion(undefined, 5);
      expect.unreachable('a required version must be demanded');
    } catch (error) {
      expect(error).toMatchObject({
        code: ErrorCode.VERSION_CONFLICT,
        details: { expectedVersion: -1, actualVersion: 5 },
      });
    }
  });

  it('advances by exactly one', () => {
    // Writing `version` where `version + 1` was meant presents as a phantom conflict on the *next*
    // save, which is a long way from the line that caused it.
    expect(nextVersion(1)).toBe(2);
  });
});

describe('the recycle-bin filter', () => {
  it('asks for live rows by default', () => {
    expect(deletedCondition('live')).toBeNull();
  });

  it('asks for only deleted rows, so a recycle bin can be paged', () => {
    // Not "everything, filtered afterwards". Fetch-then-filter makes `total` a lie and the page
    // boundaries wrong.
    expect(deletedCondition('deleted')).toEqual({ not: null });
  });

  it('constrains nothing for “all”', () => {
    // `undefined` is how Prisma spells "no condition", so the call site needs no branch.
    expect(deletedCondition('all')).toBeUndefined();
  });
});

describe('search conditions', () => {
  it('matches any of the named columns, case-insensitively', () => {
    expect(searchConditions('qa', ['name', 'code'])).toEqual([
      { name: { contains: 'qa', mode: 'insensitive' } },
      { code: { contains: 'qa', mode: 'insensitive' } },
    ]);
  });

  it('escapes wildcard characters, because Prisma does not', () => {
    // `contains` is parameterised — no injection — but the parameter is interpolated into a LIKE
    // pattern, where `%` and `_` keep their meaning. Unescaped, `?search=%` matches every row and
    // `?search=50%` matches "50" followed by anything. Both are wrong answers, given silently.
    expect(searchConditions('100%', ['name'])).toEqual([
      { name: { contains: '100\\%', mode: 'insensitive' } },
    ]);
    expect(searchConditions('a_b', ['name'])).toEqual([
      { name: { contains: 'a\\_b', mode: 'insensitive' } },
    ]);
  });

  it('escapes the backslash before the characters it escapes with', () => {
    // Order is load-bearing: escaping `%` first and `\` afterwards would double the backslashes
    // this function had just introduced, and `100\%` would become a search for `100\\%`.
    expect(escapeLikeTerm('a\\b')).toBe('a\\\\b');
    expect(escapeLikeTerm('50%\\')).toBe('50\\%\\\\');
  });

  it('constrains nothing when there is no term', () => {
    expect(searchConditions(undefined, ['name'])).toBeUndefined();
    expect(searchConditions('', ['name'])).toBeUndefined();
  });

  it('constrains nothing when there is nothing to search', () => {
    // An empty `OR` array matches *no rows* in Prisma, so returning one would turn a search on a
    // resource with no text columns into an empty list rather than an unfiltered one.
    expect(searchConditions('qa', [])).toBeUndefined();
  });
});

describe('ordering', () => {
  it('sorts by the requested field', () => {
    expect(orderByFor('name', 'asc', 'createdAt')).toEqual([{ name: 'asc' }, { id: 'asc' }]);
  });

  it('falls back to the endpoint’s default field', () => {
    expect(orderByFor(undefined, 'desc', 'createdAt')).toEqual([
      { createdAt: 'desc' },
      { id: 'desc' },
    ]);
  });

  it('always appends a stable tiebreak', () => {
    // Two rows with the same name can otherwise come back in either order on either page, so a
    // row is silently shown twice or skipped as the user pages. The second key removes the
    // ambiguity, and `id` is a v7 uuid so it is creation order rather than noise.
    const [, tiebreak] = orderByFor('name', 'asc', 'createdAt');
    expect(tiebreak).toEqual({ id: 'asc' });
  });
});

describe('paging arguments', () => {
  it('turns page one into no offset', () => {
    expect(pageArgs({ page: 1, pageSize: DEFAULT_PAGE_SIZE })).toEqual({
      skip: 0,
      take: DEFAULT_PAGE_SIZE,
    });
  });

  it('offsets by whole pages', () => {
    expect(pageArgs({ page: 3, pageSize: 20 })).toEqual({ skip: 40, take: 20 });
  });
});
