import { describe, expect, it } from 'vitest';

import { RevisionLabelStyle } from '@edms/domain';

import { revisionLabelFor } from './revision-label';

describe('the numeric style', () => {
  it('calls the first issue Original rather than R0', () => {
    // `R0` reads as a mistake to everybody outside the database, and the architecture's own
    // diagram calls it Original.
    expect(revisionLabelFor(0, RevisionLabelStyle.NUMERIC)).toBe('Original');
  });

  it('numbers everything after it', () => {
    expect(revisionLabelFor(1, RevisionLabelStyle.NUMERIC)).toBe('R1');
    expect(revisionLabelFor(12, RevisionLabelStyle.NUMERIC)).toBe('R12');
  });
});

describe('the alphabetic style', () => {
  it('starts at A', () => {
    expect(revisionLabelFor(0, RevisionLabelStyle.ALPHABETIC)).toBe('A');
    expect(revisionLabelFor(25, RevisionLabelStyle.ALPHABETIC)).toBe('Z');
  });

  it('goes Z, AA, AB — not Z, BA', () => {
    // Spreadsheet column lettering, not base-26: there is no zero digit. Getting this wrong looks
    // right for twenty-six revisions and then collides.
    expect(revisionLabelFor(26, RevisionLabelStyle.ALPHABETIC)).toBe('AA');
    expect(revisionLabelFor(27, RevisionLabelStyle.ALPHABETIC)).toBe('AB');
    expect(revisionLabelFor(51, RevisionLabelStyle.ALPHABETIC)).toBe('AZ');
    expect(revisionLabelFor(52, RevisionLabelStyle.ALPHABETIC)).toBe('BA');
  });

  it('never produces the same label for two ordinals', () => {
    const seen = new Set<string>();
    for (let ordinal = 0; ordinal < 2000; ordinal += 1) {
      seen.add(revisionLabelFor(ordinal, RevisionLabelStyle.ALPHABETIC));
    }
    expect(seen.size).toBe(2000);
  });

  it('reaches three letters where it should', () => {
    expect(revisionLabelFor(701, RevisionLabelStyle.ALPHABETIC)).toBe('ZZ');
    expect(revisionLabelFor(702, RevisionLabelStyle.ALPHABETIC)).toBe('AAA');
  });
});

describe('the major/minor style', () => {
  it('calls the first issue 1.0', () => {
    expect(revisionLabelFor(0, RevisionLabelStyle.MAJOR_MINOR)).toBe('1.0');
  });

  it('increments the major at publication and the minor per draft since', () => {
    // Phase 6's decision, made: publication increments the major. The first draft after the
    // original publishes is 2.0; if that draft is discarded and re-checked-in, its replacement
    // is 2.1 — and the ordinal underneath stays contiguous either way.
    expect(
      revisionLabelFor(1, RevisionLabelStyle.MAJOR_MINOR, { published: 1, sinceLastPublished: 0 }),
    ).toBe('2.0');
    expect(
      revisionLabelFor(2, RevisionLabelStyle.MAJOR_MINOR, { published: 1, sinceLastPublished: 1 }),
    ).toBe('2.1');
    expect(
      revisionLabelFor(3, RevisionLabelStyle.MAJOR_MINOR, { published: 2, sinceLastPublished: 0 }),
    ).toBe('3.0');
  });

  it('refuses a lineage that does not count whole revisions', () => {
    expect(() =>
      revisionLabelFor(1, RevisionLabelStyle.MAJOR_MINOR, {
        published: -1,
        sinceLastPublished: 0,
      }),
    ).toThrow();
    expect(() =>
      revisionLabelFor(1, RevisionLabelStyle.MAJOR_MINOR, {
        published: 0,
        sinceLastPublished: 1.5,
      }),
    ).toThrow();
  });
});

describe('every style', () => {
  it('refuses an ordinal that is not a revision number', () => {
    for (const style of Object.values(RevisionLabelStyle)) {
      expect(() => revisionLabelFor(-1, style)).toThrow();
      expect(() => revisionLabelFor(1.5, style)).toThrow();
    }
  });
});
