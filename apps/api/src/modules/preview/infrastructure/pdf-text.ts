import type { RenderLimits } from '../../../ports/preview.port';
import { RenderFailedError } from '../../../ports/preview.port';

/**
 * PDF text extraction, through `pdfjs-dist`.
 *
 * The one renderer dependency this phase pulls in rather than writes out, and the trade is the
 * inverse of the PNG codec's: a PDF parser is cross-reference tables, object streams, fifteen
 * text encodings and a compressed-stream zoo — years of format, not two hundred lines — and
 * `pdfjs-dist` is pure JavaScript with no native binding, which is the property the air-gapped
 * installer actually cares about. What is *not* used is its rasteriser: drawing pages needs a
 * canvas, a canvas in Node is a native binding, and the browser already has a real one — so
 * pages are drawn client-side from the rendition, and the server reads only the text layer.
 */

export interface PdfTextPage {
  /** 1-based. */
  readonly page: number;
  readonly text: string;
}

export interface PdfText {
  readonly pageCount: number;
  /** Pages up to the limit; `pageCount` still says how many exist. */
  readonly pages: readonly PdfTextPage[];
}

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

let loaded: Promise<PdfJs> | null = null;

/**
 * `pdfjs-dist` v4 ships as ESM only, and this application compiles to CommonJS, where the
 * compiler lowers `import()` into a `require()`. On the Node this product pins (≥ 22) that
 * `require` loads the ES module natively; the `Function` indirection is the fallback for a
 * runtime where it does not, kept out of the compiler's reach so it stays a real dynamic
 * import. Both paths resolve the same module once.
 */
function loadPdfJs(): Promise<PdfJs> {
  loaded ??= (async () => {
    try {
      return await import('pdfjs-dist/legacy/build/pdf.mjs');
    } catch {
      // The whole point: a dynamic import the CommonJS compiler cannot lower into a require.
      // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call
      return new Function('return import("pdfjs-dist/legacy/build/pdf.mjs")')() as Promise<PdfJs>;
    }
  })();
  return loaded;
}

/** Page count and per-page text. Throws `RenderFailedError` for what cannot be parsed. */
export async function extractPdfText(bytes: Buffer, limits: RenderLimits): Promise<PdfText> {
  const pdfjs = await loadPdfJs();
  let document;
  try {
    document = await pdfjs.getDocument({
      // A copy, because pdfjs transfers the buffer to its worker and would detach ours.
      data: new Uint8Array(bytes),
      useSystemFonts: true,
      // The text layer needs no fonts drawn; skipping face loading keeps this headless-safe.
      disableFontFace: true,
      isEvalSupported: false,
    }).promise;
  } catch (error) {
    throw new RenderFailedError(
      error instanceof Error && error.name === 'PasswordException'
        ? 'The PDF is password-protected.'
        : 'The PDF could not be parsed.',
    );
  }

  try {
    const pageCount = document.numPages;
    const pages: PdfTextPage[] = [];
    for (let page = 1; page <= Math.min(pageCount, limits.maxPages); page += 1) {
      const content = await (await document.getPage(page)).getTextContent();
      const text = joinTextItems(content.items, limits.maxTextBytes);
      if (text.length > 0) {
        pages.push({ page, text });
      }
    }
    return { pageCount, pages };
  } finally {
    await document.destroy();
  }
}

/**
 * Text items joined the way a reader reads them: an item that ends a line contributes a break,
 * everything else a space. Capped in bytes, because "extracted text" is an artefact with a
 * ceiling, not a transcript at any cost.
 */
function joinTextItems(items: readonly unknown[], maxBytes: number): string {
  const pieces: string[] = [];
  let bytes = 0;
  for (const item of items) {
    if (typeof item !== 'object' || item === null || !('str' in item)) {
      continue;
    }
    const { str } = item as { str: string; hasEOL?: boolean };
    const piece = str + ((item as { hasEOL?: boolean }).hasEOL === true ? '\n' : ' ');
    bytes += Buffer.byteLength(piece, 'utf8');
    if (bytes > maxBytes) {
      break;
    }
    pieces.push(piece);
  }
  return pieces
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
