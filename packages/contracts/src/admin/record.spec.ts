import { describe, expect, it } from 'vitest';

import { isUsableCode } from '@edms/domain';

import { codeSchema, configurationKeySchema } from './record';

/**
 * Two definitions of one rule are a defect unless something checks they agree.
 *
 * `isUsableCode` is the domain's answer and `codeSchema` is the wire's, and they exist separately
 * for a real reason: the browser validates a form without importing a validator, and the API
 * validates a body without trusting one. The duplication is only safe while it is asserted, so
 * this walks the cases that actually differ between a regular expression and a rule — the
 * boundaries, the separators, and the length.
 */
describe('a code means the same thing on the wire as it does in the domain', () => {
  const cases = [
    'QA',
    'qa',
    'HQ',
    'A',
    '0',
    'QMS-2',
    'A-B-C',
    'ABCDEFGHIJKLMNOP',
    'ABCDEFGHIJKLMNOPQ',
    '-QA',
    'QA-',
    'Q A',
    'Q_A',
    'Q.A',
    'Q/A',
    '',
    ' QA ',
    'QÁ',
  ];

  for (const candidate of cases) {
    it(`agrees on ${JSON.stringify(candidate)}`, () => {
      expect(codeSchema.safeParse(candidate).success).toBe(isUsableCode(candidate));
    });
  }

  it('trims before judging, so a pasted code with spaces is accepted as the code it names', () => {
    // Both sides trim: `isUsableCode` inside the pattern test, the schema before it. A form that
    // rejected " QA " while the API accepted it would be a validation gap in the user's favour,
    // which is still a gap.
    expect(codeSchema.parse('  QA  ')).toBe('QA');
  });

  it('does not fold case, because a code is stored as it was typed', () => {
    // Codes are *compared* case-insensitively — that is the partial unique index on `lower(code)`
    // — but they are printed on documents as the tenant wrote them.
    expect(codeSchema.parse('qa')).toBe('qa');
  });
});

describe('a configuration key', () => {
  it('accepts the dotted lower-case form the product stores', () => {
    expect(configurationKeySchema.parse('quality.procedure')).toBe('quality.procedure');
    expect(configurationKeySchema.parse('quality-procedure')).toBe('quality-procedure');
  });

  it('refuses a key that differs from another only by case', () => {
    // Two keys that differ only by case are one key to every human reading a report and two to
    // the database. Refusing upper-case outright removes the question.
    expect(configurationKeySchema.safeParse('Quality.Procedure').success).toBe(false);
  });

  it('refuses a trailing or doubled separator, which reads as an unfinished key', () => {
    expect(configurationKeySchema.safeParse('quality.').success).toBe(false);
    expect(configurationKeySchema.safeParse('quality..procedure').success).toBe(false);
    expect(configurationKeySchema.safeParse('.quality').success).toBe(false);
  });
});
