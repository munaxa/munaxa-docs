import { PDFDocument, PDFName, PDFNumber, PDFRawStream } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { extractReadableImages } from './pdf-images';

const LIMITS = { maxImages: 8, maxImageBytes: 1_000_000 };

/**
 * A PDF whose page carries one image XObject, built at the object level.
 *
 * Deliberately not `PDFDocument.embedJpg`, which needs a real JPEG to parse: what is under test is
 * the *structure walk* — finding the resource dictionary, reading `/XObject`, checking `/Subtype`
 * and `/Filter`, and copying the stream out untouched. Handing it bytes it must return verbatim is
 * a stronger assertion than handing it a JPEG and hoping, because it proves nothing decoded them.
 */
async function pdfWithImage(options: {
  readonly filter: string | readonly string[];
  readonly subtype?: string;
  readonly bytes: Buffer;
  readonly pages?: number;
}): Promise<Buffer> {
  const document = await PDFDocument.create();
  const pages = options.pages ?? 1;
  for (let index = 0; index < pages; index += 1) {
    const page = document.addPage([200, 200]);
    const context = document.context;
    // `/DCTDecode` in PDF syntax is the name `DCTDecode`; `PDFName.of` adds the slash back.
    const names = typeof options.filter === 'string' ? [options.filter] : options.filter;
    const asName = (name: string): PDFName => PDFName.of(name.slice(1));
    const filter =
      typeof options.filter === 'string' ? asName(options.filter) : context.obj(names.map(asName));
    const dictionary = context.obj({
      Type: 'XObject',
      Subtype: options.subtype ?? 'Image',
      Width: PDFNumber.of(10),
      Height: PDFNumber.of(10),
      ColorSpace: 'DeviceRGB',
      BitsPerComponent: PDFNumber.of(8),
    });
    dictionary.set(PDFName.of('Filter'), filter);
    dictionary.set(PDFName.of('Length'), PDFNumber.of(options.bytes.length));
    const stream = PDFRawStream.of(dictionary, new Uint8Array(options.bytes));
    page.node.setXObject(PDFName.of(`Im${String(index)}`), context.register(stream));
  }
  return Buffer.from(await document.save());
}

describe('extractReadableImages', () => {
  // The case the whole file exists for: a scanner's page image, taken out byte for byte, with no
  // decoding at all — which is what makes this reachable without a rasteriser or a new dependency.
  it('lifts a DCTDecode page image verbatim', async () => {
    const scan = Buffer.from('pretend-jpeg-bytes-from-a-scanner', 'utf8');
    const images = await extractReadableImages(
      await pdfWithImage({ filter: '/DCTDecode', bytes: scan }),
      LIMITS,
    );

    expect(images).toHaveLength(1);
    expect(images[0]?.mimeType).toBe('image/jpeg');
    expect(images[0]?.page).toBe(1);
    expect(images[0]?.bytes.equals(scan)).toBe(true);
  });

  // A producer may write `/Filter [/DCTDecode]`. A check that only handled the name form would
  // silently skip a real proportion of scanner output, which would look exactly like "this PDF has
  // no images".
  it('accepts the array form of the filter', async () => {
    const images = await extractReadableImages(
      await pdfWithImage({ filter: ['/DCTDecode'], bytes: Buffer.from('jpeg') }),
      LIMITS,
    );
    expect(images).toHaveLength(1);
  });

  // A chain means the bytes are not a JPEG until the outer filter is undone, and undoing it would
  // be decoding — the line this file does not cross.
  it('skips a filter chain rather than handing out bytes that are not a file', async () => {
    const images = await extractReadableImages(
      await pdfWithImage({ filter: ['/FlateDecode', '/DCTDecode'], bytes: Buffer.from('x') }),
      LIMITS,
    );
    expect(images).toEqual([]);
  });

  // The honest half of the discharge: fax-derived and JPEG 2000 scans are raw samples that would
  // need a codec written around them, which is the trade Phase 3 refused for JPEG thumbnails.
  it.each(['/CCITTFaxDecode', '/JPXDecode', '/FlateDecode'])(
    'does not claim to read %s',
    async (filter) => {
      const images = await extractReadableImages(
        await pdfWithImage({ filter, bytes: Buffer.from('samples') }),
        LIMITS,
      );
      expect(images).toEqual([]);
    },
  );

  it('ignores an XObject that is a form rather than an image', async () => {
    const images = await extractReadableImages(
      await pdfWithImage({ filter: '/DCTDecode', subtype: 'Form', bytes: Buffer.from('x') }),
      LIMITS,
    );
    expect(images).toEqual([]);
  });

  it('reads one image per page, in page order', async () => {
    const images = await extractReadableImages(
      await pdfWithImage({ filter: '/DCTDecode', bytes: Buffer.from('page'), pages: 3 }),
      LIMITS,
    );
    expect(images.map((image) => image.page)).toEqual([1, 2, 3]);
  });

  // A hostile PDF declaring thousands of image XObjects is an attack on the slow lane, not a
  // document — the same reasoning `zip.ts` gives for its entry cap.
  it('stops at the image cap', async () => {
    const images = await extractReadableImages(
      await pdfWithImage({ filter: '/DCTDecode', bytes: Buffer.from('page'), pages: 5 }),
      { ...LIMITS, maxImages: 2 },
    );
    expect(images).toHaveLength(2);
  });

  // One oversized page image in a fifty-page scan should cost that page's text, not the whole read.
  it('skips an image over the byte cap without refusing the document', async () => {
    const images = await extractReadableImages(
      await pdfWithImage({ filter: '/DCTDecode', bytes: Buffer.alloc(64, 1) }),
      { ...LIMITS, maxImageBytes: 16 },
    );
    expect(images).toEqual([]);
  });

  // Bytes that are not a PDF answer empty rather than throwing: the caller's next move is the same
  // one it had before this function existed, and an exception here would fail an OCR job that has
  // nothing wrong with it.
  it('answers nothing for bytes that are not a PDF', async () => {
    expect(await extractReadableImages(Buffer.from('not a pdf'), LIMITS)).toEqual([]);
  });
});
