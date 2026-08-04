import { describe, expect, it } from 'vitest';

import { MAX_COMPARED_PARAGRAPHS, compareTexts, splitParagraphs } from './text-diff';

describe('splitParagraphs', () => {
  it('splits on blank lines and on line breaks that start a new block', () => {
    expect(splitParagraphs('First.\n\nSecond.\nThird.')).toEqual(['First.', 'Second.', 'Third.']);
  });

  it('settles internal whitespace, because extraction is noisy about it', () => {
    expect(splitParagraphs('One   two\tthree  ')).toEqual(['One two three']);
  });
});

describe('compareTexts', () => {
  it('reports identical texts as identical', () => {
    const result = compareTexts('Same words.\n\nBoth sides.', 'Same words.\n\nBoth sides.');
    expect(result.identical).toBe(true);
    expect(result.changes.every((change) => change.kind === 'EQUAL')).toBe(true);
  });

  it('reports an added and a removed paragraph as themselves', () => {
    const result = compareTexts('Kept.\n\nRemoved.', 'Kept.\n\nAdded.');
    const kinds = result.changes.map((change) => change.kind);
    expect(kinds).toContain('EQUAL');
    // A removed paragraph immediately followed by an added one is one edited paragraph.
    expect(kinds).toContain('CHANGED');
  });

  it('pairs an edit into word-level spans, marking only what moved', () => {
    const result = compareTexts('The quality manual applies.', 'The quality policy applies.');
    const changed = result.changes.find((change) => change.kind === 'CHANGED');
    expect(changed).toBeDefined();
    expect(changed?.toWords?.filter((word) => word.changed).map((word) => word.text)).toEqual([
      'policy',
    ]);
    expect(changed?.fromWords?.filter((word) => word.changed).map((word) => word.text)).toEqual([
      'manual',
    ]);
  });

  it('keeps a genuinely new paragraph as ADDED when nothing was removed beside it', () => {
    const result = compareTexts('One.', 'One.\n\nTwo.');
    expect(result.changes.map((change) => change.kind)).toEqual(['EQUAL', 'ADDED']);
    expect(result.identical).toBe(false);
  });

  it('truncates above the cap and says so rather than diffing forever', () => {
    const many = Array.from(
      { length: MAX_COMPARED_PARAGRAPHS + 10 },
      (_, i) => `P${String(i)}.`,
    ).join('\n\n');
    const result = compareTexts(many, many);
    expect(result.truncated).toBe(true);
    // Truncation forfeits the claim of identity: what was not compared is not known equal.
    expect(result.identical).toBe(false);
  });
});
