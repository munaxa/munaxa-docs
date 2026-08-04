import { PreviewArtifactKind } from '@edms/domain';

import type { RenderInput, RenderResult, Renderer } from '../../../ports/preview.port';

/**
 * The text renderer: the format that already is its extraction.
 *
 * One `TEXT` artefact, normalised to UTF-8 with Unix line endings and capped — the viewer
 * renders it directly, in-document search searches it, and comparison diffs it. No `PDF`
 * rendition, deliberately: laying text out into pages means line-wrapping, font metrics and —
 * in a product whose OCR ships `ara+eng` — Arabic shaping, none of which `pdf-lib`'s standard
 * fonts do. A rendition that garbles Arabic text is worse than no rendition; the viewer's own
 * text pane, which is the browser's shaping engine, is the honest one. `pageCount` is null
 * because plain text has no pages until something lays it out.
 */
export class TextRenderer implements Renderer {
  readonly key = 'munaxa-text';
  readonly version = '1.0.0';

  supports(mimeType: string): boolean {
    return mimeType === 'text/plain' || mimeType === 'text/csv';
  }

  render(input: RenderInput): Promise<RenderResult> {
    const text = normalise(input.bytes, input.limits.maxTextBytes);
    return Promise.resolve({
      artifacts: [
        {
          kind: PreviewArtifactKind.TEXT,
          page: null,
          content: { bytes: Buffer.from(text, 'utf8'), mimeType: 'text/plain' },
        },
      ],
      pageCount: null,
    });
  }
}

function normalise(bytes: Buffer, maxBytes: number): string {
  const capped = bytes.length > maxBytes ? bytes.subarray(0, maxBytes) : bytes;
  // A UTF-8 BOM is metadata about the encoding, not the first character of the document, and a
  // replacement character from a split multi-byte tail at the cap is noise, not content.
  return capped
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .replace(/�+$/, '')
    .replace(/\r\n?/g, '\n');
}
