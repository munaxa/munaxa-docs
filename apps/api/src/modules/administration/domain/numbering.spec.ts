import { describe, expect, it } from 'vitest';

import { NumberSegmentKind, SequenceResetScope } from '@edms/domain';

import {
  type NumberingRuleShape,
  PREVIEW_SEQUENCE_VALUE,
  checkRule,
  formatNumber,
  scopeKeyFor,
} from './numbering';

/**
 * Golden samples and the rules that refuse a bad recipe.
 *
 * `09-numbering-architecture.md` §5 asks for exactly this: a pure formatter, unit-tested per segment
 * type, with golden samples per rule. A document number appears in printed copies and other systems,
 * so a formatter that is wrong is wrong on paper.
 */

const ASSIGNED_AT = new Date('2026-07-31T09:14:02.000Z');

function ruleFor(overrides: Partial<NumberingRuleShape> = {}): NumberingRuleShape {
  return {
    separator: '-',
    segments: [{ kind: NumberSegmentKind.SEQUENCE, padding: 4 }],
    resetScope: [SequenceResetScope.NEVER],
    ...overrides,
  };
}

describe('rendering a number', () => {
  it('renders the worked example from the architecture', () => {
    // `QMS-JO-AMM-QA-PROC-2026-0042`, the sample the architecture gives (§1).
    const rule = ruleFor({
      segments: [
        { kind: NumberSegmentKind.LITERAL, value: 'QMS' },
        { kind: NumberSegmentKind.ENTITY_CODE },
        { kind: NumberSegmentKind.BRANCH_CODE, optional: true },
        { kind: NumberSegmentKind.DEPARTMENT_CODE },
        { kind: NumberSegmentKind.DOCUMENT_TYPE_CODE },
        { kind: NumberSegmentKind.YEAR, digits: 4 },
        { kind: NumberSegmentKind.SEQUENCE, padding: 4 },
      ],
    });

    const { formatted, omitted } = formatNumber(
      rule,
      {
        entityCode: 'JO',
        branchCode: 'AMM',
        departmentCode: 'QA',
        documentTypeCode: 'PROC',
        assignedAt: ASSIGNED_AT,
      },
      42n,
    );

    expect(formatted).toBe('QMS-JO-AMM-QA-PROC-2026-0042');
    expect(omitted).toEqual([]);
  });

  it('drops an optional segment and its separator when it resolves empty', () => {
    const rule = ruleFor({
      segments: [
        { kind: NumberSegmentKind.ENTITY_CODE },
        { kind: NumberSegmentKind.BRANCH_CODE, optional: true },
        { kind: NumberSegmentKind.SEQUENCE, padding: 3 },
      ],
    });

    const { formatted, omitted } = formatNumber(
      rule,
      { entityCode: 'JO', assignedAt: ASSIGNED_AT },
      7n,
    );

    // Not `JO--007`. The separator goes with the segment, which is the whole meaning of optional.
    expect(formatted).toBe('JO-007');
    expect(omitted).toEqual([NumberSegmentKind.BRANCH_CODE]);
  });

  it('leaves a visible gap for a required segment that resolves empty', () => {
    const rule = ruleFor({
      segments: [
        { kind: NumberSegmentKind.ENTITY_CODE },
        { kind: NumberSegmentKind.BRANCH_CODE },
        { kind: NumberSegmentKind.SEQUENCE, padding: 3 },
      ],
    });

    const { formatted, omitted } = formatNumber(
      rule,
      { entityCode: 'JO', assignedAt: ASSIGNED_AT },
      7n,
    );

    // `JO--007` is the shape of a misconfiguration — a rule demanding a branch for a document with
    // none — and it is meant to look wrong. Silently shortening it would produce a plausible number
    // that somebody then prints.
    expect(formatted).toBe('JO--007');
    expect(omitted).toEqual([]);
  });

  it('pads the counter and never truncates it', () => {
    const rule = ruleFor({ segments: [{ kind: NumberSegmentKind.SEQUENCE, padding: 4 }] });

    expect(formatNumber(rule, { assignedAt: ASSIGNED_AT }, 7n).formatted).toBe('0007');
    // A series that outgrows its padding widens. Wrapping would re-issue a number, which is the one
    // thing numbering forbids.
    expect(formatNumber(rule, { assignedAt: ASSIGNED_AT }, 12_345n).formatted).toBe('12345');
  });

  it('takes the year and month from the assignment date', () => {
    const rule = ruleFor({
      segments: [
        { kind: NumberSegmentKind.YEAR, digits: 2 },
        { kind: NumberSegmentKind.MONTH },
        { kind: NumberSegmentKind.SEQUENCE, padding: 2 },
      ],
    });

    // July is `07`, not `7`: a number sorts as text wherever it is printed or pasted.
    expect(formatNumber(rule, { assignedAt: ASSIGNED_AT }, 3n).formatted).toBe('26-07-03');
  });

  it('joins with no separator when the rule says so', () => {
    const rule = ruleFor({
      separator: '',
      segments: [
        { kind: NumberSegmentKind.LITERAL, value: 'DOC' },
        { kind: NumberSegmentKind.SEQUENCE, padding: 5 },
      ],
    });

    expect(formatNumber(rule, { assignedAt: ASSIGNED_AT }, 9n).formatted).toBe('DOC00009');
  });

  it('renders a counter beyond what a number can hold', () => {
    // `next_value` is `bigint` in the database, and the formatter takes a `bigint` for exactly this
    // reason: a series past 2^53 must still render its own value rather than a rounded one.
    const rule = ruleFor({ segments: [{ kind: NumberSegmentKind.SEQUENCE, padding: 1 }] });
    expect(formatNumber(rule, { assignedAt: ASSIGNED_AT }, 9_007_199_254_740_993n).formatted).toBe(
      '9007199254740993',
    );
  });
});

describe('refusing a rule that cannot be issued from', () => {
  it('needs exactly one counter', () => {
    expect(
      checkRule(ruleFor({ segments: [{ kind: NumberSegmentKind.LITERAL, value: 'X' }] })),
    ).toContain('NO_SEQUENCE');
    expect(
      checkRule(
        ruleFor({
          segments: [
            { kind: NumberSegmentKind.SEQUENCE, padding: 3 },
            { kind: NumberSegmentKind.SEQUENCE, padding: 3 },
          ],
        }),
      ),
    ).toContain('MULTIPLE_SEQUENCES');
  });

  it('refuses two optional segments, because dropping either collides', () => {
    // `[ENTITY?, DEPT?, SEQ]`: entity "A" with no department renders `A-0001`, and no entity with
    // department "A" renders `A-0001`. Two different documents, one number.
    const rejections = checkRule(
      ruleFor({
        segments: [
          { kind: NumberSegmentKind.ENTITY_CODE, optional: true },
          { kind: NumberSegmentKind.DEPARTMENT_CODE, optional: true },
          { kind: NumberSegmentKind.SEQUENCE, padding: 4 },
        ],
      }),
    );
    expect(rejections).toContain('AMBIGUOUS_OPTIONAL_SEGMENTS');
  });

  it('allows exactly one optional segment', () => {
    // Which is the architecture's own sample: an optional branch code.
    expect(
      checkRule(
        ruleFor({
          segments: [
            { kind: NumberSegmentKind.ENTITY_CODE },
            { kind: NumberSegmentKind.BRANCH_CODE, optional: true },
            { kind: NumberSegmentKind.SEQUENCE, padding: 4 },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it('refuses an optional segment with no separator to drop', () => {
    // With nothing between the parts, there is nothing to remove *with* the segment: `A` + `B` and
    // `AB` are already the same string.
    expect(
      checkRule(
        ruleFor({
          separator: '',
          segments: [
            { kind: NumberSegmentKind.ENTITY_CODE },
            { kind: NumberSegmentKind.BRANCH_CODE, optional: true },
            { kind: NumberSegmentKind.SEQUENCE, padding: 4 },
          ],
        }),
      ),
    ).toContain('OPTIONAL_WITHOUT_SEPARATOR');
  });

  it('refuses a yearly reset with no year in the number', () => {
    // The counter restarts and nothing in the text distinguishes the two documents. The unique index
    // would catch it at assignment; catching it at configuration is the difference between a rule
    // that cannot be saved and a document that cannot be approved.
    expect(checkRule(ruleFor({ resetScope: [SequenceResetScope.YEARLY] }))).toContain(
      'RESET_SCOPE_WITHOUT_SEGMENT',
    );

    expect(
      checkRule(
        ruleFor({
          resetScope: [SequenceResetScope.YEARLY],
          segments: [
            { kind: NumberSegmentKind.YEAR, digits: 4 },
            { kind: NumberSegmentKind.SEQUENCE, padding: 4 },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it('refuses a monthly reset with no month in the number', () => {
    expect(
      checkRule(
        ruleFor({
          resetScope: [SequenceResetScope.MONTHLY],
          segments: [
            { kind: NumberSegmentKind.YEAR, digits: 4 },
            { kind: NumberSegmentKind.SEQUENCE, padding: 4 },
          ],
        }),
      ),
    ).toContain('RESET_SCOPE_WITHOUT_SEGMENT');
  });

  it('refuses “never” combined with anything, and a duplicated scope', () => {
    expect(
      checkRule(ruleFor({ resetScope: [SequenceResetScope.NEVER, SequenceResetScope.PER_ENTITY] })),
    ).toContain('RESET_SCOPE_NEVER_COMBINED');
    expect(
      checkRule(
        ruleFor({ resetScope: [SequenceResetScope.PER_ENTITY, SequenceResetScope.PER_ENTITY] }),
      ),
    ).toContain('RESET_SCOPE_DUPLICATED');
  });

  it('refuses monthly and yearly together', () => {
    // Monthly already restarts within a year; both describes one behaviour twice.
    expect(
      checkRule(
        ruleFor({
          resetScope: [SequenceResetScope.MONTHLY, SequenceResetScope.YEARLY],
          segments: [
            { kind: NumberSegmentKind.YEAR, digits: 4 },
            { kind: NumberSegmentKind.MONTH },
            { kind: NumberSegmentKind.SEQUENCE, padding: 4 },
          ],
        }),
      ),
    ).toContain('RESET_SCOPE_MONTHLY_AND_YEARLY');
  });

  it('refuses a gapless series that reserves at submission', () => {
    // Gapless is defined by not reserving early: a reservation that can be abandoned is a gap.
    expect(checkRule(ruleFor({ strictGapless: true, reserveOnSubmit: true }))).toContain(
      'GAPLESS_CANNOT_RESERVE',
    );
    expect(checkRule(ruleFor({ strictGapless: true, reserveOnSubmit: false }))).toEqual([]);
  });

  it('reports every reason, not the first', () => {
    const rejections = checkRule(
      ruleFor({
        separator: '',
        segments: [
          { kind: NumberSegmentKind.ENTITY_CODE, optional: true },
          { kind: NumberSegmentKind.BRANCH_CODE, optional: true },
        ],
        resetScope: [SequenceResetScope.YEARLY],
      }),
    );

    expect(rejections).toEqual(
      expect.arrayContaining([
        'NO_SEQUENCE',
        'AMBIGUOUS_OPTIONAL_SEGMENTS',
        'OPTIONAL_WITHOUT_SEPARATOR',
        'RESET_SCOPE_WITHOUT_SEGMENT',
      ]),
    );
  });

  it('refuses an empty rule outright, without piling on', () => {
    // Every other check would fire too, and a list of six reasons for "you have not built anything
    // yet" is noise rather than help.
    expect(checkRule(ruleFor({ segments: [] }))).toEqual(['EMPTY_RULE']);
  });
});

describe('the series a number is drawn from', () => {
  it('is one continuous series when the rule never resets', () => {
    const key = scopeKeyFor(ruleFor(), { assignedAt: ASSIGNED_AT });
    expect(key).toBe('ALL');
  });

  it('separates the series a reset scope names', () => {
    const rule = ruleFor({
      resetScope: [SequenceResetScope.YEARLY, SequenceResetScope.PER_ENTITY],
      segments: [
        { kind: NumberSegmentKind.YEAR, digits: 4 },
        { kind: NumberSegmentKind.SEQUENCE, padding: 4 },
      ],
    });

    const jordan = scopeKeyFor(rule, { entityCode: 'JO', assignedAt: ASSIGNED_AT });
    const egypt = scopeKeyFor(rule, { entityCode: 'EG', assignedAt: ASSIGNED_AT });
    const nextYear = scopeKeyFor(rule, {
      entityCode: 'JO',
      assignedAt: new Date('2027-01-02T00:00:00.000Z'),
    });

    expect(jordan).not.toBe(egypt);
    expect(jordan).not.toBe(nextYear);
  });

  it('does not depend on the order the reset scope was listed in', () => {
    // Otherwise reordering `[YEARLY, PER_ENTITY]` to `[PER_ENTITY, YEARLY]` — a change that means
    // nothing — would compute a different key and silently start a second series at 1 alongside the
    // one already in use.
    const segments = [
      { kind: NumberSegmentKind.YEAR, digits: 4 } as const,
      { kind: NumberSegmentKind.SEQUENCE, padding: 4 } as const,
    ];
    const context = { entityCode: 'JO', assignedAt: ASSIGNED_AT };

    expect(
      scopeKeyFor(
        ruleFor({
          resetScope: [SequenceResetScope.YEARLY, SequenceResetScope.PER_ENTITY],
          segments,
        }),
        context,
      ),
    ).toBe(
      scopeKeyFor(
        ruleFor({
          resetScope: [SequenceResetScope.PER_ENTITY, SequenceResetScope.YEARLY],
          segments,
        }),
        context,
      ),
    );
  });

  it('distinguishes a missing code from an empty one consistently', () => {
    // Both render as the same key, and that is correct: a document with no entity belongs to the
    // series for "no entity", and it must be the same series every time.
    const rule = ruleFor({ resetScope: [SequenceResetScope.PER_ENTITY] });
    expect(scopeKeyFor(rule, { assignedAt: ASSIGNED_AT })).toBe(
      scopeKeyFor(rule, { entityCode: '', assignedAt: ASSIGNED_AT }),
    );
  });
});

describe('previewing', () => {
  it('renders a counter that shows the padding off', () => {
    // A sample of `0001` looks the same at padding 4 as a sample of `1` does at padding 1.
    expect(PREVIEW_SEQUENCE_VALUE).toBeGreaterThan(9n);
  });
});
