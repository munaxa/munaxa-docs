import { describe, expect, it } from 'vitest';

import {
  FILE_FORMATS,
  SNIFF_BYTE_COUNT,
  SUPPORTED_MIME_TYPES,
  extensionOf,
  formatFor,
  isSupportedMimeType,
  normalizeMimeType,
  sniffFormat,
} from './file-formats';

/** The leading bytes of a file, padded so a short fixture is not mistaken for a truncated read. */
function leading(...bytes: number[]): Uint8Array {
  const buffer = new Uint8Array(32);
  buffer.set(bytes);
  return buffer;
}

const PDF = leading(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37);
const ZIP = leading(0x50, 0x4b, 0x03, 0x04);
const PNG = leading(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const DWG = leading(0x41, 0x43, 0x31, 0x30, 0x33, 0x32);
const TEXT = new TextEncoder().encode('Procedure QA-014, revision 3.\nSigned off 2026-05-02.\n');
const OOXML = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

describe('the format table', () => {
  it('covers every format the phase promised to support', () => {
    for (const mimeType of [
      'application/pdf',
      OOXML,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'image/png',
      'image/vnd.dwg',
      'application/zip',
      'text/plain',
    ]) {
      expect(isSupportedMimeType(mimeType)).toBe(true);
    }
  });

  it('names each MIME type once — two entries would make the allow-list order-dependent', () => {
    expect(new Set(SUPPORTED_MIME_TYPES).size).toBe(SUPPORTED_MIME_TYPES.length);
  });

  it('claims each extension for one format only', () => {
    const extensions = FILE_FORMATS.flatMap((format) => format.extensions);
    expect(new Set(extensions).size).toBe(extensions.length);
  });

  it('treats every OOXML format as a ZIP container, because that is what it is on disk', () => {
    for (const format of FILE_FORMATS) {
      const isOoxml = format.mimeType.includes('openxmlformats');
      if (isOoxml) {
        expect(format.zipContainer).toBe(true);
      }
    }
  });

  it('reads far enough for the deepest signature in the table', () => {
    const deepest = Math.max(
      ...FILE_FORMATS.flatMap((format) =>
        format.signatures.map((signature) => signature.offset + signature.bytes.length),
      ),
    );
    expect(SNIFF_BYTE_COUNT).toBeGreaterThanOrEqual(deepest);
  });
});

describe('normalizeMimeType', () => {
  it('drops the charset a browser attaches', () => {
    expect(normalizeMimeType('text/plain; charset=utf-8')).toBe('text/plain');
  });

  it('lower-cases, so one format is not stored under two spellings', () => {
    expect(normalizeMimeType('Application/PDF')).toBe('application/pdf');
  });

  it('resolves a decorated type against the table', () => {
    expect(formatFor('IMAGE/PNG ; foo=bar')?.family).toBe('IMAGE');
  });
});

describe('extensionOf', () => {
  it('lower-cases and keeps the dot', () => {
    expect(extensionOf('Specification.PDF')).toBe('.pdf');
  });

  it('answers nothing for a file with no extension', () => {
    expect(extensionOf('Makefile')).toBe('');
  });

  it('treats a leading dot as a hidden file rather than an extension', () => {
    expect(extensionOf('.gitignore')).toBe('');
  });
});

describe('sniffFormat', () => {
  it('accepts a declaration the bytes agree with', () => {
    expect(sniffFormat('application/pdf', PDF)?.mimeType).toBe('application/pdf');
  });

  it('refuses an executable renamed to a PDF', () => {
    // `MZ` — a Windows executable. The declaration says PDF; the bytes say otherwise, and nothing
    // in the table claims them.
    expect(sniffFormat('application/pdf', leading(0x4d, 0x5a, 0x90, 0x00))).toBeNull();
  });

  it('reports what the bytes were, not what was claimed, on a mismatch', () => {
    expect(sniffFormat('application/pdf', PNG)?.mimeType).toBe('image/png');
  });

  it('distinguishes a Word document from a ZIP by the declaration, since the bytes cannot', () => {
    expect(sniffFormat(OOXML, ZIP)?.mimeType).toBe(OOXML);
    expect(sniffFormat('application/zip', ZIP)?.mimeType).toBe('application/zip');
  });

  it('refuses a format this product does not store, however genuine the bytes are', () => {
    // A real ELF binary, declared as one. Sniffing agrees with the declaration and it is still
    // refused: the table is an allow-list, not a recogniser.
    expect(sniffFormat('application/x-executable', leading(0x7f, 0x45, 0x4c, 0x46))).toBeNull();
  });

  it('accepts text by exclusion, because text has no signature to match', () => {
    expect(sniffFormat('text/plain', TEXT)?.mimeType).toBe('text/plain');
  });

  it('refuses a PDF renamed to .txt rather than storing it as text', () => {
    expect(sniffFormat('text/plain', PDF)?.mimeType).toBe('application/pdf');
  });

  it('refuses binary rubbish declared as text', () => {
    expect(sniffFormat('text/plain', leading(0x00, 0x01, 0x02, 0x00))).toBeNull();
  });

  it('recognises a DWG by its version marker', () => {
    expect(sniffFormat('image/vnd.dwg', DWG)?.family).toBe('DRAWING');
  });

  it('needs the RIFF subtype for WebP, not merely the container', () => {
    const riff = leading(0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50);
    const audio = leading(0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45);
    expect(sniffFormat('image/webp', riff)?.mimeType).toBe('image/webp');
    expect(sniffFormat('image/webp', audio)).toBeNull();
  });

  it('refuses a truncated read rather than guessing from what arrived', () => {
    expect(sniffFormat('application/pdf', new Uint8Array([0x25, 0x50]))).toBeNull();
  });
});
