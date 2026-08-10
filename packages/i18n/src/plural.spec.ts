import { describe, expect, it } from 'vitest';

import { ar } from './catalogues/ar';
import { en } from './catalogues/en';
import { isPluralMessage, plural, selectPluralForm } from './plural';
import { type PluralKey, translate, translatorFor } from './translate';

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

describe('the Arabic category boundaries a reviewer has to write against', () => {
  /**
   * Phase 7.4A — the numbers, verified against the runtime rather than described from memory.
   *
   * A reviewer completing the 23 Arabic messages needs to know which numbers land in which form,
   * and two of these are counter-intuitive enough to be worth pinning: **103 is `few`**, not
   * `other` — the rule reads the last two digits, so 103, 1003 and 10 003 all take the same form as
   * 3 — and **100, 101 and 102 are `other`** while 111 is `many`. Somebody writing a `few` form for
   * "three to ten" would be writing it for 103 as well without this on the record.
   */
  const CATEGORIES: readonly (readonly [number, Intl.LDMLPluralRule])[] = [
    [0, 'zero'],
    [1, 'one'],
    [2, 'two'],
    [3, 'few'],
    [4, 'few'],
    [5, 'few'],
    [6, 'few'],
    [10, 'few'],
    [103, 'few'],
    [11, 'many'],
    [12, 'many'],
    [99, 'many'],
    [111, 'many'],
    [100, 'other'],
    [101, 'other'],
    [102, 'other'],
  ];

  it.each(CATEGORIES)('ar: %i → %s', (count, expected) => {
    expect(new Intl.PluralRules('ar').select(count)).toBe(expected);
  });

  it('every Arabic message answers in every category', () => {
    /*
     * Written in Phase 7.4A to guard the *pending* state — when all 23 answered every category from
     * one `other` form, this asserted that none of them could render a key or an empty string.
     *
     * Phase 7.4C completed the forms, and the digit assertion this test used to carry had to go:
     * the approved policy prints **no digit in the `two` form**, because the Arabic dual already
     * means two. So `صفان` legitimately fails "contains 2". The rule it was reaching for now lives
     * where it belongs — "the dual carries no digit, and every other form carries one", asserted
     * across every plural key rather than one. What survives here is what this test was always
     * really for: nothing renders a key or an empty string, at any count.
     */
    for (const [count] of CATEGORIES) {
      const rendered = translate('ar', 'admin.grid.rowCount', { count });
      expect(rendered.length, `at ${String(count)}`).toBeGreaterThan(0);
      expect(rendered, `at ${String(count)}`).not.toBe('admin.grid.rowCount');
    }
  });
});

/** Every plural key in the catalogue, discovered rather than listed, so a new one cannot escape. */
const PLURAL_KEYS: readonly PluralKey[] = (() => {
  const keys: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (typeof node !== 'object' || node === null) {
      return;
    }
    if (isPluralMessage(node)) {
      keys.push(path);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      walk(value, path === '' ? key : `${path}.${key}`);
    }
  };
  walk(en, '');
  return keys as PluralKey[];
})();

describe('the Arabic plural forms, as rendered', () => {
  /**
   * Wording assertions — Phase 7.4C, and the point of the phase.
   *
   * Category selection was already proved against `Intl.PluralRules`; what these assert is the
   * **Arabic that reaches a reader**. The policy is one table applied 23 times: digit + plural for
   * `zero` and `few`, digit + singular for `one` and `other`, digit + singular accusative (تمييز)
   * for `many`, and — the one that needed a product decision — a **bare dual for `two`, with no
   * digit**, because the dual already means two.
   */
  const ROW_FORMS: readonly (readonly [number, string])[] = [
    [0, '0 صفوف'],
    [1, '1 صف'],
    [2, 'صفان'],
    [3, '3 صفوف'],
    [5, '5 صفوف'],
    [10, '10 صفوف'],
    [11, '11 صفًا'],
    [12, '12 صفًا'],
    [99, '99 صفًا'],
    [100, '100 صف'],
    [103, '103 صفوف'],
    [111, '111 صفًا'],
  ];

  it.each(ROW_FORMS)('admin.grid.rowCount at %i reads %s', (count, expected) => {
    expect(translate('ar', 'admin.grid.rowCount', { count })).toBe(expected);
  });

  it('reports.rowCount counts rows exactly as the grid does', () => {
    // Phase 7.3 found these two rendering the same noun two different ways — `صفًا` on one screen,
    // `صف` on the other, at the same count. One policy, one result, asserted rather than hoped for.
    for (const [count] of ROW_FORMS) {
      expect(translate('ar', 'reports.rowCount', { count })).toBe(
        translate('ar', 'admin.grid.rowCount', { count }),
      );
    }
  });

  it('the dual carries no digit, and every other form carries one', () => {
    // The policy's one deliberate omission, enforced across all 23 rather than trusted.
    for (const key of PLURAL_KEYS) {
      const two = translate('ar', key, { count: 2 });
      if (key === 'bulk.bar.selected') {
        continue;
      }
      expect(two, `${key} at two`).not.toContain('2');
      for (const count of [1, 3, 11, 100]) {
        expect(translate('ar', key, { count }), `${key} at ${String(count)}`).toContain(
          String(count),
        );
      }
    }
  });

  it.each([
    ['audit.export.events', 1, '1 حدث'],
    ['audit.export.events', 2, 'حدثان'],
    ['audit.export.events', 3, '3 أحداث'],
    ['audit.export.events', 11, '11 حدثًا'],
    ['dashboard.admin.blobs', 2, 'ملفان'],
    ['dashboard.admin.blobs', 11, '11 ملفًا'],
    ['admin.approvalGroups.memberCount', 2, 'شخصان'],
    ['admin.calendars.holidayCount', 2, 'عطلتان'],
    ['delegations.useCount', 2, 'قراران'],
    ['preview.matches', 2, 'نتيجتان'],
    ['preview.matches', 3, '3 نتائج'],
    ['notifications.unreadCount', 1, '1 إشعار غير مقروء'],
    ['notifications.unreadCount', 2, 'إشعاران غير مقروءين'],
    ['notifications.unreadCount', 3, '3 إشعارات غير مقروءة'],
    ['notifications.unreadCount', 11, '11 إشعارًا غير مقروء'],
    ['dashboard.admin.unreferenced', 2, 'ملفان بلا مرجع'],
  ] as const)('%s at %i reads %s', (key, count, expected) => {
    expect(translate('ar', key, { count })).toBe(expected);
  });

  it('sentence-embedded messages move their pronouns and verbs with the count', () => {
    // Agreement past the noun. A count does not only change a word in Arabic; it changes what the
    // rest of the sentence points at.
    expect(translate('ar', 'admin.roles.inUseByMembers', { count: 1 })).toContain('عنه أولًا');
    expect(translate('ar', 'admin.roles.inUseByMembers', { count: 2 })).toContain('عنهما أولًا');
    expect(translate('ar', 'admin.roles.inUseByMembers', { count: 5 })).toContain('عنهم أولًا');

    expect(translate('ar', 'admin.list.inUseByTypes', { count: 1 })).toContain('عدّله أولًا');
    expect(translate('ar', 'admin.list.inUseByTypes', { count: 2 })).toContain('عدّلهما أولًا');
    expect(translate('ar', 'admin.list.inUseByTypes', { count: 5 })).toContain('عدّلها أولًا');
  });

  it('the bulk results agree with وثيقة, which is what the product calls a document', () => {
    expect(translate('ar', 'bulk.result.refusedHint', { count: 1 })).toContain('رُفِضت 1 وثيقة');
    expect(translate('ar', 'bulk.result.refusedHint', { count: 2 })).toContain('رُفِضت وثيقتان');
    expect(translate('ar', 'bulk.result.blockedHint', { count: 3 })).toContain('مُنِعت 3 وثائق');
    expect(translate('ar', 'bulk.result.failedHint', { count: 11 })).toContain('أخفقت 11 وثيقةً');
  });

  it('bulk.bar.selected stays invariant, by decision', () => {
    // The generic selection bar. `ResourceList` serves the document library and every
    // administration screen, so it cannot know the noun — the label/value form is the approved
    // answer, and it is the same string at every count.
    for (const count of [0, 1, 2, 3, 11, 100]) {
      expect(translate('ar', 'bulk.bar.selected', { count })).toBe(`المحدَّد: ${String(count)}`);
    }
  });

  it('every Arabic form is real text — no key, no empty string, no English left behind', () => {
    for (const key of PLURAL_KEYS) {
      for (const count of [0, 1, 2, 3, 5, 10, 11, 12, 99, 100, 103, 111]) {
        const rendered = translate('ar', key, { count });
        expect(rendered.length, `${key} at ${String(count)}`).toBeGreaterThan(0);
        expect(rendered, `${key} at ${String(count)}`).not.toBe(key);
        expect(rendered, `${key} at ${String(count)}`).toMatch(/[\u0600-\u06FF]/);
        expect(rendered, `${key} at ${String(count)}`).not.toContain('{count}');
      }
    }
  });

  it('no interpolation variable is lost beside the count', () => {
    const rendered = translate('ar', 'admin.settings.searchRebuildSummary', {
      count: 5,
      startedAt: 'اليوم',
    });
    expect(rendered).toContain('اليوم');
    expect(rendered).not.toContain('{startedAt}');
  });
});

describe('the Arabic plural review, as a tripwire', () => {
  /**
   * §13's regression guard, retargeted for Phase 7.4C.
   *
   * Before this phase the number was 23 — every Arabic message answering all six categories from a
   * single `other`. It is now **1**: `bulk.bar.selected`, invariant by product decision because the
   * component it lives in cannot know what it is counting.
   *
   * The guard still points both ways. If it rises, a message lost its forms. If it falls, the one
   * remaining invariant was given agreement it was decided not to have.
   */
  const INVARIANT_BY_DECISION = 1;

  function singleFormPlurals(catalogue: unknown): string[] {
    const found: string[] = [];
    const walkPlurals = (node: unknown, path: string): void => {
      if (typeof node !== 'object' || node === null) {
        return;
      }
      if (isPluralMessage(node)) {
        const forms = Object.entries(node)
          .filter(([, value]) => typeof value === 'string')
          .map(([key]) => key);
        if (forms.length === 1) {
          found.push(path);
        }
        return;
      }
      for (const [key, value] of Object.entries(node)) {
        walkPlurals(value, path === '' ? key : `${path}.${key}`);
      }
    };
    walkPlurals(catalogue, '');
    return found;
  }

  it('exactly one Arabic message is invariant, and it is the one that was decided to be', () => {
    expect(singleFormPlurals(ar)).toStrictEqual(['bulk.bar.selected']);
    expect(singleFormPlurals(ar)).toHaveLength(INVARIANT_BY_DECISION);
  });

  it('English has no message left answering every category from one form', () => {
    expect(singleFormPlurals(en)).toStrictEqual([]);
  });
});
