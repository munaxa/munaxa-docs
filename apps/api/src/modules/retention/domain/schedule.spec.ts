import { describe, expect, it } from 'vitest';

import { Disposition, RetentionScheduleState, RetentionTrigger } from '@edms/domain';

import {
  DispositionOutcome,
  addMonths,
  cancelledByRestore,
  decideDisposition,
  proposeSchedule,
} from './schedule';

const policy = {
  id: 'policy-1',
  trigger: RetentionTrigger.ON_PUBLISH,
  periodMonths: 84,
  disposition: Disposition.PURGE,
  reviewRequired: false,
};

describe('addMonths', () => {
  it('keeps the day of the month', () => {
    expect(addMonths(new Date('2026-01-15T09:00:00Z'), 12).toISOString()).toBe(
      '2027-01-15T09:00:00.000Z',
    );
  });

  it('clamps to the last day of a shorter target month rather than rolling into the next', () => {
    // `setUTCMonth` alone turns 31 January + 1 month into 3 March, which would make the period
    // longer than the policy says for four days of every month.
    expect(addMonths(new Date('2026-01-31T00:00:00Z'), 1).toISOString()).toBe(
      '2026-02-28T00:00:00.000Z',
    );
    expect(addMonths(new Date('2024-01-31T00:00:00Z'), 1).toISOString()).toBe(
      '2024-02-29T00:00:00.000Z',
    );
  });
});

describe('proposeSchedule', () => {
  it('schedules on the policy’s own trigger and on no other', () => {
    const at = new Date('2026-01-01T00:00:00Z');
    const published = proposeSchedule({
      trigger: RetentionTrigger.ON_PUBLISH,
      at,
      policy,
      documentNumber: 'QMS-0001',
      recycleBinDays: 30,
    });
    expect(published?.dueAt.toISOString()).toBe('2033-01-01T00:00:00.000Z');
    expect(published?.policyId).toBe('policy-1');

    expect(
      proposeSchedule({
        trigger: RetentionTrigger.ON_SUPERSEDE,
        at,
        policy,
        documentNumber: 'QMS-0001',
        recycleBinDays: 30,
      }),
    ).toBeNull();
  });

  it('writes no schedule for a record kept forever', () => {
    expect(
      proposeSchedule({
        trigger: RetentionTrigger.ON_PUBLISH,
        at: new Date('2026-01-01T00:00:00Z'),
        policy: { ...policy, disposition: Disposition.RETAIN_FOREVER },
        documentNumber: 'QMS-0001',
        recycleBinDays: 30,
      }),
    ).toBeNull();
  });

  it('always requires review before a purge, whatever the policy ticked', () => {
    const proposal = proposeSchedule({
      trigger: RetentionTrigger.ON_PUBLISH,
      at: new Date('2026-01-01T00:00:00Z'),
      policy: { ...policy, reviewRequired: false },
      documentNumber: 'QMS-0001',
      recycleBinDays: 30,
    });
    expect(proposal?.reviewRequired).toBe(true);
  });

  it('gives an unnumbered deleted draft the recycle-bin window as its period', () => {
    const proposal = proposeSchedule({
      trigger: RetentionTrigger.ON_DELETE,
      at: new Date('2026-01-01T00:00:00Z'),
      policy: null,
      documentNumber: null,
      recycleBinDays: 30,
    });
    expect(proposal?.dueAt.toISOString()).toBe('2026-01-31T00:00:00.000Z');
    expect(proposal?.disposition).toBe(Disposition.PURGE);
    expect(proposal?.reviewRequired).toBe(false);
    expect(proposal?.policyId).toBeNull();
  });

  it('never puts a numbered document on the recycle-bin clock', () => {
    // A number means it was approved. Its frozen policy decides, however long ago it was deleted.
    expect(
      proposeSchedule({
        trigger: RetentionTrigger.ON_DELETE,
        at: new Date('2026-01-01T00:00:00Z'),
        policy: null,
        documentNumber: 'QMS-0001',
        recycleBinDays: 30,
      }),
    ).toBeNull();
  });
});

describe('decideDisposition', () => {
  const due = {
    disposition: Disposition.PURGE,
    state: RetentionScheduleState.PENDING,
    reviewRequired: false,
    held: false,
  };

  it('refuses a held document before it considers anything else', () => {
    expect(decideDisposition({ ...due, held: true })).toBe(DispositionOutcome.BLOCKED);
    expect(decideDisposition({ ...due, held: true, reviewRequired: true })).toBe(
      DispositionOutcome.BLOCKED,
    );
  });

  it('sends a schedule needing review to review once, then executes it', () => {
    expect(decideDisposition({ ...due, reviewRequired: true })).toBe(DispositionOutcome.REVIEW);
    expect(
      decideDisposition({
        ...due,
        reviewRequired: true,
        state: RetentionScheduleState.IN_REVIEW,
      }),
    ).toBe(DispositionOutcome.PURGE);
  });

  it('never destroys on a disposition the policy no longer names', () => {
    expect(decideDisposition({ ...due, disposition: Disposition.RETAIN_FOREVER })).toBe(
      DispositionOutcome.REVIEW,
    );
  });
});

describe('cancelledByRestore', () => {
  it('withdraws only what a delete created', () => {
    expect(cancelledByRestore(RetentionTrigger.ON_DELETE)).toBe(true);
    // Otherwise deleting and restoring a published record would reset its retention period.
    expect(cancelledByRestore(RetentionTrigger.ON_PUBLISH)).toBe(false);
  });
});
