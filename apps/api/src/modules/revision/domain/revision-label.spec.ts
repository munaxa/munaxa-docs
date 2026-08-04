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
  it('treats every ordinal as a minor of major one until something is approved', () => {
    // Phase 3 only creates ordinal zero. What increments a major is Phase 6's decision, and until
    // it is made a draft series is what this shows: 1.0, 1.1, 1.2.
    expect(revisionLabelFor(0, RevisionLabelStyle.MAJOR_MINOR)).toBe('1.0');
    expect(revisionLabelFor(3, RevisionLabelStyle.MAJOR_MINOR)).toBe('1.3');
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
