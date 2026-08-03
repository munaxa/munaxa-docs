import { describe, expect, it } from 'vitest';

import { deriveCode, isUsableCode, normalizeCode } from './scope';

describe('deriveCode', () => {
  it('takes an organisation short name as it stands when it already fits', () => {
    expect(deriveCode('acme', 'HQ')).toBe('ACME');
    expect(deriveCode('acme-group', 'HQ')).toBe('ACME-GROUP');
  });

  it('truncates a name too long to print on a document', () => {
    // A slug is a URL identifier and may be long and descriptive. A code is read aloud and typed
    // back in. Refusing to provision an organisation over that mismatch would be the tail
    // wagging the dog — it is a default, and an administrator renames it.
    expect(deriveCode('international-widgets-corporation', 'HQ')).toBe('INTERNATIONAL-WI');
  });

  it('does not leave a trailing hyphen behind after truncating', () => {
    // 'ABCDEFGHIJKLMNO-' would otherwise come back looking like an unfinished code.
    expect(deriveCode('abcdefghijklmno-pqr', 'HQ')).toBe('ABCDEFGHIJKLMNO');
  });

  it('drops what a code cannot carry', () => {
    expect(deriveCode('acme corp.', 'HQ')).toBe('ACMECORP');
    expect(deriveCode('-leading', 'HQ')).toBe('LEADING');
  });

  it('falls back when nothing usable survives', () => {
    expect(deriveCode('', 'HQ')).toBe('HQ');
    expect(deriveCode('---', 'HQ')).toBe('HQ');
    expect(deriveCode('日本語', 'HQ')).toBe('HQ');
  });

  it('always produces something a code check accepts', () => {
    for (const candidate of ['', '---', 'ok', 'a'.repeat(40), '!!!', '9-lives']) {
      expect(isUsableCode(deriveCode(candidate, 'HQ'))).toBe(true);
    }
  });

  it('produces a code already in normal form', () => {
    const code = deriveCode('Acme Group', 'HQ');
    expect(normalizeCode(code)).toBe(code);
  });
});
