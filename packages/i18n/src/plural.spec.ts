import { describe, expect, it } from 'vitest';

import { ar } from './catalogues/ar';
import { en } from './catalogues/en';
import { isPluralMessage, plural, selectPluralForm } from './plural';
import { translate, translatorFor } from './translate';

/**
 * The plural engine — Phase 7.4.
 *
 * These are behaviour tests against `Intl.PluralRules`, not a re-implementation of it. The point is
 * not to assert that Arabic has six categories — the runtime owns that — but that this product
 * *reaches* the runtime's answer, falls back honestly when a message cannot answer, and never
 * renders a key or an empty string to somebody counting something.
 */

const SIX = plural({
  zero: 'zero form',
  one: 'one form',
  two: 'two form',
  few: 'few form',
  many: 'many form',
  other: 'other form',
});

describe('English selects between two forms', () => {
  it.each([
    [0, 'other form'],
    [1, 'one form'],
    [2, 'other form'],
  ])('%i → %s', (count, expected) => {
    expect(selectPluralForm('en', SIX, count)).toBe(expected);
  });
});

describe('Arabic selects across all six', () => {
  /*
   * The numbers are the ones the CLDR rules for `ar` actually split on: 0 is its own category, 1 and
   * 2 are their own, 3–10 are `few`, 11–99 are `many`, and 100 falls to `other`. Asserted here so a
   * future change to this file cannot quietly collapse Arabic back to two forms without a failure.
   */
  it.each([
    [0, 'zero form'],
    [1, 'one form'],
    [2, 'two form'],
    [3, 'few form'],
    [5, 'few form'],
    [11, 'many form'],
    [100, 'other form'],
  ])('%i → %s', (count, expected) => {
    expect(selectPluralForm('ar', SIX, count)).toBe(expected);
  });
});

describe('what happens when a form is missing', () => {
  it('falls back to other when the locale asks for a category the message lacks', () => {
    // An English-authored message rendered in Arabic: `ar` selects `few` for 3, and there is no
    // `few` here. `other` is the only honest answer, and it is a sentence rather than a key.
    const twoForms = plural({ one: 'one form', other: 'other form' });
    expect(selectPluralForm('ar', twoForms, 3)).toBe('other form');
  });

  it('falls back to other for a count that is not a number', () => {
    expect(selectPluralForm('en', SIX, Number.NaN)).toBe('other form');
    expect(selectPluralForm('en', SIX, Number.POSITIVE_INFINITY)).toBe('other form');
  });

  it('passes negative and fractional counts to the locale rather than clamping them', () => {
    /*
     * Asserted so that the *absence* of clamping is deliberate and visible — and the expectations
     * here are the runtime's, checked against it rather than assumed.
     *
     * The first draft of this test asserted `other` for `-1`, on the reasoning that a negative
     * count is not "one of something". `Intl.PluralRules('en')` disagrees: English cardinal rules
     * select on the absolute value, so `-1` is `one` and `-2` is `other`. The test was wrong, not
     * the engine, and it is corrected rather than the engine bent to it. Fractions do fall to
     * `other`: `1.5` is neither singular nor a whole plural in English.
     */
    expect(selectPluralForm('en', SIX, -1)).toBe('one form');
    expect(selectPluralForm('en', SIX, -2)).toBe('other form');
    expect(selectPluralForm('en', SIX, 1.5)).toBe('other form');
    expect(selectPluralForm('en', SIX, 0.5)).toBe('other form');
  });
});

describe('translate, over plural messages', () => {
  it('selects the form and interpolates the count into it', () => {
    expect(translate('en', 'admin.grid.rowCount', { count: 1 })).toBe('1 row');
    expect(translate('en', 'admin.grid.rowCount', { count: 0 })).toBe('0 rows');
    expect(translate('en', 'admin.grid.rowCount', { count: 7 })).toBe('7 rows');
  });

  it('interpolates the other values beside the count', () => {
    expect(
      translate('en', 'admin.settings.searchRebuildSummary', {
        count: 1,
        startedAt: 'today',
      }),
    ).toBe('1 document indexed, started today.');
  });

  it('answers in Arabic through the same call', () => {
    // The *mechanism* is what this asserts: Arabic reaches a form and renders a sentence. Whether
    // that sentence is well-formed Arabic is a review question, recorded in the phase report.
    const one = translate('ar', 'admin.grid.rowCount', { count: 1 });
    const many = translate('ar', 'admin.grid.rowCount', { count: 11 });
    expect(one).toContain('1');
    expect(many).toContain('11');
    expect(one).not.toBe('admin.grid.rowCount');
  });

  it('keeps working for plain messages', () => {
    expect(translate('en', 'state.retry')).toBe('Try again');
  });

  it('renders the key rather than an empty string when a message does not exist', () => {
    // @ts-expect-error — the point of the test is the runtime behaviour behind the type.
    expect(translate('en', 'no.such.message', { count: 2 })).toBe('no.such.message');
  });
});

describe('a bound translator carries the plural overload', () => {
  it('selects for the locale it was bound to', () => {
    const t = translatorFor('en');
    expect(t('admin.grid.rowCount', { count: 1 })).toBe('1 row');
    expect(t('state.retry')).toBe('Try again');
  });
});

describe('the catalogue no longer hedges around plurals', () => {
  /**
   * A guard on the *data*, not on a rendering.
   *
   * The three hedges Phase 7.3 found — `row(s)`, `person/people`, and a bare plural noun that is
   * wrong at one — are what a catalogue reaches for when it has no plural mechanism. Now that it has
   * one, their reappearance means somebody added a counted string without using it, and a review
   * will not reliably catch that. This will.
   */
  function walk(
    node: unknown,
    path: string,
    visit: (path: string, value: string, fromPlural: boolean) => void,
    fromPlural = false,
  ): void {
    if (typeof node === 'string') {
      visit(path, node, fromPlural);
      return;
    }
    if (typeof node !== 'object' || node === null) {
      return;
    }
    /*
     * A plural message is a leaf here, exactly as it is to `translate` — its forms are the message,
     * not a group of messages. The first draft of this walker descended into them and reported
     * `auth.mfaEnrolledHint.one` as an unmigrated counted string, which is the opposite of the
     * truth. Corrected rather than the assertion loosened to accommodate it.
     */
    if (isPluralMessage(node)) {
      for (const value of Object.values(node)) {
        if (typeof value === 'string') {
          visit(path, value, true);
        }
      }
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      walk(value, path === '' ? key : `${path}.${key}`, visit, fromPlural);
    }
  }

  it.each([
    ['en', en],
    ['ar', ar],
  ])('%s carries no parenthetical or slashed plural hedge', (_locale, catalogue) => {
    const offenders: string[] = [];
    walk(catalogue, '', (path, value) => {
      if (/\(s\)|person\/people|\(es\)/.test(value)) {
        offenders.push(`${path}: ${value}`);
      }
    });
    expect(offenders).toStrictEqual([]);
  });

  it('every message interpolating {count} is a plural message', () => {
    // The other half of the guard: a *new* counted string that never becomes a `plural()` call is
    // exactly the regression this phase exists to prevent, and it would otherwise look fine.
    // The three ratio messages are the documented exceptions — see the phase report, §4.
    const RATIOS = new Set(['admin.list.count', 'recycleBin.count']);
    const TOTAL_DRIVEN = new Set([
      'search.resultsCount',
      'audit.resultsCount',
      'audit.showingRecent',
    ]);
    const plain: string[] = [];
    walk(en, '', (path, value, fromPlural) => {
      if (
        !fromPlural &&
        value.includes('{count}') &&
        !RATIOS.has(path) &&
        !TOTAL_DRIVEN.has(path)
      ) {
        plain.push(path);
      }
    });
    expect(plain).toStrictEqual([]);
  });
});
