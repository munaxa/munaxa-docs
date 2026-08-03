import { describe, expect, it } from 'vitest';

import { equalsIgnoreCase, sanitizeFilename, squish } from './text';

describe('sanitizeFilename', () => {
  it('strips path traversal and control characters', () => {
    // Separators become underscores and the leading dots are dropped, so nothing that
    // reaches a filesystem or a Content-Disposition header can still traverse.
    expect(sanitizeFilename('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(sanitizeFilename(`quality${String.fromCharCode(9)}manual.pdf`)).toBe(
      'qualitymanual.pdf',
    );
  });

  it('never returns an empty or dot-leading name', () => {
    expect(sanitizeFilename('...')).toBe('download');
    expect(sanitizeFilename('   ')).toBe('download');
  });

  it('bounds the length', () => {
    expect(sanitizeFilename('a'.repeat(500))).toHaveLength(200);
  });
});

describe('text helpers', () => {
  it('squishes whitespace', () => {
    expect(squish('  Quality   Manual \n rev 2 ')).toBe('Quality Manual rev 2');
  });

  it('compares codes case-insensitively', () => {
    expect(equalsIgnoreCase('QMS-PR', 'qms-pr')).toBe(true);
    expect(equalsIgnoreCase('QMS-PR', 'QMS-WI')).toBe(false);
  });
});
