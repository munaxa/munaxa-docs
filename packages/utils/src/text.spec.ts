import { describe, expect, it } from 'vitest';

import { contentDisposition, equalsIgnoreCase, sanitizeFilename, squish } from './text';

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

/** What an RFC 6266 client makes of the header: `filename*` when present, else `filename`. */
function chosenName(header: string): string {
  const extended = /;\s*filename\*=UTF-8''([^;]*)/u.exec(header);
  if (extended?.[1] !== undefined) {
    return decodeURIComponent(extended[1]);
  }
  return /;\s*filename="([^"]*)"/u.exec(header)?.[1] ?? '';
}

/** The ASCII fallback an older client reads. */
function fallbackName(header: string): string {
  return /;\s*filename="([^"]*)"/u.exec(header)?.[1] ?? '';
}

describe('contentDisposition (RFC 6266 / RFC 8187)', () => {
  it('sends a plain ASCII name as filename="…" alone', () => {
    expect(contentDisposition('attachment', 'QA-014 rev 2.pdf')).toBe(
      'attachment; filename="QA-014 rev 2.pdf"',
    );
    expect(contentDisposition('inline', 'notes.txt')).toBe('inline; filename="notes.txt"');
  });

  it.each([
    ['Arabic', 'تقرير الربع الأول.pdf', 'download.pdf'],
    ['accented', 'Résumé café.docx', 'Resume cafe.docx'],
    ['mixed', 'Résumé تقرير.txt', 'Resume _.txt'],
    ['a percent sign', '50% complete.xlsx', '50_ complete.xlsx'],
  ])('sends a %s name in filename* and a readable ASCII fallback', (_case, name, fallback) => {
    const header = contentDisposition('attachment', name);
    expect(header).toMatch(
      /^attachment; filename="[^"]*"; filename\*=UTF-8''[A-Za-z0-9%!#$&+\-.^_`|~]+$/u,
    );
    expect(chosenName(header)).toBe(name);
    expect(fallbackName(header)).toBe(fallback);
  });

  it('percent-encodes the UTF-8 bytes exactly', () => {
    expect(contentDisposition('attachment', 'é.txt')).toBe(
      `attachment; filename="e.txt"; filename*=UTF-8''%C3%A9.txt`,
    );
  });

  it('keeps quotes and backslashes out of the quoted fallback', () => {
    const header = contentDisposition('attachment', 'say "hi"\\there.txt');
    expect(fallbackName(header)).not.toMatch(/["\\]/u);
    expect(header.split('"')).toHaveLength(3);
  });

  it('cannot be made to end the header or add another one', () => {
    for (const hostile of [
      'a.pdf\r\nSet-Cookie: x=1',
      'a.pdf\nContent-Type: text/html',
      `a.pdf${String.fromCharCode(0)}.exe`,
      'a.pdf"; filename="evil.exe',
      "a.pdf; filename*=UTF-8''evil.exe",
    ]) {
      const header = contentDisposition('attachment', hostile);
      expect(header).not.toMatch(/[\r\n\0]/u);
      // One quoted fallback and at most one extended value, whatever the name contained.
      expect(header.match(/filename="/gu)).toHaveLength(1);
      expect((header.match(/filename\*=/gu) ?? []).length).toBeLessThanOrEqual(1);
      expect(chosenName(header)).not.toMatch(/[\r\n\0/\\]/u);
    }
  });

  it('removes path separators and bidirectional overrides that disguise an extension', () => {
    expect(chosenName(contentDisposition('attachment', '../../etc/passwd'))).toBe('_.._etc_passwd');
    const disguised = contentDisposition('attachment', `invoice${'\u202E'}fdp.exe`);
    expect(chosenName(disguised)).toBe('invoicefdp.exe');
    expect(disguised).not.toContain('%E2%80%AE');
  });

  it('never produces an empty or unencodable name', () => {
    expect(contentDisposition('attachment', '...')).toBe('attachment; filename="download"');
    const lone = contentDisposition('attachment', `bad${'\uD800'}.pdf`);
    expect(chosenName(lone)).toBe('bad.pdf');
    expect(chosenName(contentDisposition('attachment', '🙂'))).toBe('🙂');
  });
});
