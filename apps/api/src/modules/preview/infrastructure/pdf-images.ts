import { PDFDict, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';

/**
 * Lifting the rasters a scanner already put in a PDF, so an image-only PDF can be OCR-read.
 *
 * ## The limit this discharges, and the one it does not
 *
 * Phase 7's limits table has four rows this phase owns, and three of them share one blocker:
 *
 * > *An image-only PDF is not OCR-read.* Tesseract reads rasters; rasterising PDF pages is the job
 * > the server deliberately does not do.
 *
 * That blocker is real and is unchanged. Rendering a PDF *page* — compositing its text, vectors and
 * images into pixels — needs a canvas, a canvas in Node is a native binding, and the lockfile
 * cannot gain one. `pdfjs-dist` is already a dependency and is not a way around it: it parses
 * perfectly well and has nothing to draw onto.
 *
 * **But rasterising the page was never what an image-only PDF needed.** A scanned document is
 * typically one full-page image XObject per page, and for the overwhelmingly common encoding —
 * `/DCTDecode`, which every document scanner and every "print to PDF" of a photograph produces —
 * **the stream's raw bytes are a JPEG file**. Not a JPEG-like encoding; the actual bytes, which
 * Tesseract already reads. So the work is a walk of the page's resource dictionary and a copy,
 * with no decoding, no compositing and no dependency.
 *
 * What this therefore is: a partial discharge, stated as one. A born-digital PDF with a text layer
 * never reaches OCR anyway (Phase 7's forty-character threshold decides). A scanned PDF whose pages
 * are JPEG is now read. A scanned PDF whose pages are `/CCITTFaxDecode` (fax-derived TIFF-style
 * bilevel) or `/JPXDecode` (JPEG 2000) is **not**, because those are raw sample data that would
 * need a codec and a container written around them before Tesseract could open them — which is the
 * hand-written-decoder trade Phase 3 refused for JPEG thumbnails, and refusing it again here is
 * consistency rather than laziness. `/FlateDecode` images are in the same position.
 *
 * ## Why the limits below are the ones that matter
 *
 * Everything here runs on bytes an untrusted party uploaded, in the slow lane, behind the antivirus
 * gate. The caps are the same shape as `zip.ts`'s and for the same reason: a hostile PDF declaring
 * ten thousand image XObjects is an attack on the OCR lane, not a document.
 */

export interface PdfImageLimits {
  /** The most images taken from one document. A scanner produces one per page. */
  readonly maxImages: number;
  /** Ceiling on one image's stream. Larger ones are skipped rather than refusing the document. */
  readonly maxImageBytes: number;
}

export interface ExtractedPdfImage {
  /** The page this came from, one-based — so a low-confidence read can name where it was. */
  readonly page: number;
  readonly mimeType: string;
  readonly bytes: Buffer;
}

/**
 * Every directly-readable raster in a PDF, page by page.
 *
 * Answers an empty array for a PDF with no image XObjects, for one whose images are all in
 * encodings Tesseract cannot open, and for bytes that do not parse as a PDF at all. An empty answer
 * is not an error: the caller's next move is the same as it was before this function existed —
 * record that OCR found nothing and leave the render state honest about it.
 */
export async function extractReadableImages(
  pdf: Buffer,
  limits: PdfImageLimits,
): Promise<readonly ExtractedPdfImage[]> {
  let document: PDFDocument;
  try {
    // `ignoreEncryption`, like the watermark's load: a PDF with an owner password but no user
    // password is readable and common, and refusing it would mean refusing to OCR a whole class of
    // documents the product already previews.
    document = await PDFDocument.load(pdf, { ignoreEncryption: true, updateMetadata: false });
  } catch {
    return [];
  }

  const found: ExtractedPdfImage[] = [];
  const pages = document.getPages();

  for (let index = 0; index < pages.length && found.length < limits.maxImages; index += 1) {
    const page = pages[index];
    if (page === undefined) {
      continue;
    }
    // `getInheritableAttribute` rather than `Resources()`: a page may inherit its resource
    // dictionary from an ancestor `Pages` node, and a scanner that emits one shared resource
    // dictionary for the whole document is exactly the producer this function exists for.
    const resources = page.node.getInheritableAttribute(PDFName.of('Resources'));
    const dictionary = document.context.lookupMaybe(resources, PDFDict);
    if (dictionary === undefined) {
      continue;
    }
    const xObjects = document.context.lookupMaybe(dictionary.get(PDFName.of('XObject')), PDFDict);
    if (xObjects === undefined) {
      continue;
    }

    for (const key of xObjects.keys()) {
      if (found.length >= limits.maxImages) {
        break;
      }
      // `lookup` rather than `lookupMaybe`: the typed overload does not accept `PDFRawStream`,
      // and an `instanceof` after a plain lookup narrows exactly as well while also covering the
      // case of an XObject written inline rather than as a reference.
      const stream = document.context.lookup(xObjects.get(key));
      if (!(stream instanceof PDFRawStream)) {
        continue;
      }
      const image = readableImage(stream, limits.maxImageBytes);
      if (image !== null) {
        found.push({ page: index + 1, mimeType: image.mimeType, bytes: image.bytes });
      }
    }
  }

  return found;
}

/**
 * One XObject, if it is a raster in an encoding an OCR engine opens directly.
 *
 * The `/Filter` entry decides, and it may be a name or an array — a PDF producer is free to write
 * `/Filter [/DCTDecode]`, and a check that only handled the name form would silently skip a real
 * proportion of scanner output. Where the filter is a *chain* (`[/FlateDecode /DCTDecode]`) the
 * bytes are not a JPEG until the outer filter is undone, so it is skipped: undoing it here would be
 * decoding, which is the line this file does not cross.
 */
function readableImage(
  stream: PDFRawStream,
  maxBytes: number,
): { readonly mimeType: string; readonly bytes: Buffer } | null {
  const dictionary = stream.dict;
  const subtype = dictionary.get(PDFName.of('Subtype'));
  if (!(subtype instanceof PDFName) || subtype.asString() !== '/Image') {
    return null;
  }
  const filter = dictionary.get(PDFName.of('Filter'));
  const names = filterNames(filter);
  if (names.length !== 1) {
    // No filter at all is raw samples; a chain needs decoding. Neither is a file Tesseract opens.
    return null;
  }
  const mimeType = DIRECTLY_READABLE[names[0] ?? ''];
  if (mimeType === undefined) {
    return null;
  }
  const bytes = Buffer.from(stream.getContents());
  if (bytes.length === 0 || bytes.length > maxBytes) {
    // Skipped rather than refusing the document: one oversized page image in a fifty-page scan
    // should cost that page's text, not the whole read.
    return null;
  }
  return { mimeType, bytes };
}

/**
 * The filter names on a stream, in order.
 *
 * A `PDFArray` has no iterator in this version, so it is walked by index — `asArray()` exists but
 * returns the raw objects, which is what is wanted here anyway.
 */
function filterNames(filter: unknown): readonly string[] {
  if (filter instanceof PDFName) {
    return [filter.asString()];
  }
  if (filter !== null && typeof filter === 'object' && 'asArray' in filter) {
    const entries = (filter as { asArray: () => readonly unknown[] }).asArray();
    return entries
      .filter((entry): entry is PDFName => entry instanceof PDFName)
      .map((entry) => entry.asString());
  }
  return [];
}

/**
 * The one PDF image filter whose stream bytes are already a file an OCR engine opens.
 *
 * `/DCTDecode` *is* JPEG — the stream is the JFIF file, byte for byte, which is why this whole
 * function is a copy rather than a codec. `/JPXDecode` (JPEG 2000) is deliberately absent: the
 * bytes are a real JP2 file and Tesseract's Leptonica does not read one in any build this product
 * can assume, so claiming it would produce empty reads that look like blank pages.
 */
const DIRECTLY_READABLE: Readonly<Record<string, string>> = Object.freeze({
  '/DCTDecode': 'image/jpeg',
});
