import { describe, expect, it } from 'vitest';

import { ConditionOperator } from '@edms/domain';

import { type DocumentFacts, type FactValue, evaluateCondition } from './conditions';

/**
 * The expression language, which a tenant authors and the engine runs inside the transaction that
 * approves their documents.
 *
 * Most of these assertions are about what the evaluator refuses to do. That is the point: the
 * language is closed, the facts are gathered in advance by code that knows what it is fetching, and
 * the evaluator does a lookup and a comparison. What it cannot do is as load-bearing as what it can.
 */

function facts(entries: Record<string, FactValue>): DocumentFacts {
  return new Map(Object.entries(entries));
}

describe('evaluateCondition', () => {
  it('compares equal values without coercing them', () => {
    const context = facts({ 'confidentiality.rank': 3, 'documentType.code': 'PROC' });

    expect(
      evaluateCondition(
        { field: 'documentType.code', op: ConditionOperator.EQUALS, value: 'PROC' },
        context,
      ),
    ).toBe(true);
    // `'3' == 3` is true in JavaScript and is never what somebody comparing a rank meant. A rank
    // typed into a form as text must not pass a comparison it should have failed.
    expect(
      evaluateCondition(
        { field: 'confidentiality.rank', op: ConditionOperator.EQUALS, value: '3' },
        context,
      ),
    ).toBe(false);
  });

  it('orders numbers and refuses to order strings', () => {
    const context = facts({ 'confidentiality.rank': 3, 'documentType.code': 'PROC' });

    expect(
      evaluateCondition(
        { field: 'confidentiality.rank', op: ConditionOperator.GREATER_OR_EQUAL, value: 3 },
        context,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { field: 'confidentiality.rank', op: ConditionOperator.GREATER_THAN, value: 3 },
        context,
      ),
    ).toBe(false);
    // `'10' < '9'` is true as a string comparison and false as anything a person meant. Ordering is
    // offered over numbers only, so this is false rather than accidentally true.
    expect(
      evaluateCondition(
        { field: 'documentType.code', op: ConditionOperator.LESS_THAN, value: 'QQQQ' },
        context,
      ),
    ).toBe(false);
  });

  it('treats an unresolvable fact as false rather than as an error or a match', () => {
    const context = facts({ 'documentType.code': 'PROC' });

    // A condition naming a metadata field this document's type does not carry is a stage that does
    // not apply. Throwing would stall an approval in front of an author who cannot fix a
    // definition; returning true would run a control the definition scoped away.
    expect(
      evaluateCondition(
        { field: 'metadata.contractValue', op: ConditionOperator.GREATER_THAN, value: 0 },
        context,
      ),
    ).toBe(false);
    expect(
      evaluateCondition(
        { field: 'metadata.contractValue', op: ConditionOperator.NOT_EQUALS, value: 'x' },
        context,
      ),
    ).toBe(false);
  });

  it('does not make a null fact unequal to everything', () => {
    const context = facts({ 'department.code': null });

    // "Department is not QA" must not route a document with no department at all. `!=` is not the
    // negation of `=` where absence is involved, and pretending otherwise is how a stage scoped to
    // one department ends up running on documents belonging to none.
    expect(
      evaluateCondition(
        { field: 'department.code', op: ConditionOperator.NOT_EQUALS, value: 'QA' },
        context,
      ),
    ).toBe(false);
  });

  it('reads membership and containment', () => {
    const context = facts({
      'documentType.code': 'PROC',
      'metadata.tags': ['safety', 'iso'],
      title: 'Annual safety procedure',
    });

    expect(
      evaluateCondition(
        { field: 'documentType.code', op: ConditionOperator.IN, value: ['PROC', 'WI'] },
        context,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { field: 'metadata.tags', op: ConditionOperator.CONTAINS, value: 'iso' },
        context,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { field: 'metadata.tags', op: ConditionOperator.IN, value: ['iso', 'quality'] },
        context,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { field: 'title', op: ConditionOperator.CONTAINS, value: 'safety' },
        context,
      ),
    ).toBe(true);
  });

  it('compares multi-select values as sets rather than as ordered lists', () => {
    // The order options were ticked in is not a fact about the document.
    const context = facts({ 'metadata.tags': ['iso', 'safety'] });
    expect(
      evaluateCondition(
        { field: 'metadata.tags', op: ConditionOperator.EQUALS, value: ['safety', 'iso'] },
        context,
      ),
    ).toBe(true);
  });

  it('cannot reach anything that was not put in front of it', () => {
    const context = facts({ 'documentType.code': 'PROC' });

    // The facts are a `Map`, so a condition naming a property of `Object.prototype` finds nothing
    // rather than finding the prototype. This is the assertion that a plain object would fail, and
    // it is why the fact set is a `Map` and the evaluator does no path walking at all.
    for (const field of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(
        evaluateCondition({ field, op: ConditionOperator.EQUALS, value: 'anything' }, context),
      ).toBe(false);
    }
  });
});
