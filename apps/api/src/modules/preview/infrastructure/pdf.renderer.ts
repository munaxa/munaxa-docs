import { PreviewArtifactKind } from '@edms/domain';

import type {
  RenderInput,
  RenderResult,
  RenderedArtifact,
  Renderer,
} from '../../../ports/preview.port';
import { extractPdfText } from './pdf-text';

/**
 * The PDF renderer: the format that is already its own rendition.
 *
 * Two artefacts come out. The `PDF` rendition is the source itself — declared `'SOURCE'`, so
 * the orchestrator references the existing blob rather than storing a byte-identical copy the
 * content-addressed store would refuse as a duplicate anyway. The `TEXT` artefacts are the text
 * layer, per page, for search, in-document search and revision comparison. A scanned PDF has no
 * text layer; producing no `TEXT` artefact is what routes it to OCR
 * (`docs/architecture/14-preview-architecture.md` §6).
 *
 * Pages are drawn in the browser from the rendition, not here: rasterising server-side needs a
 * canvas, a canvas in Node is a native binding, and the client already has a real one.
 */
export class PdfRenderer implements Renderer {
  readonly key = 'munaxa-pdf';
  readonly version = '1.0.0';

  supports(mimeType: string): boolean {
    return mimeType === 'application/pdf';
  }

  async render(input: RenderInput): Promise<RenderResult> {
    const extracted = await extractPdfText(input.bytes, input.limits);
    const artifacts: RenderedArtifact[] = [
      { kind: PreviewArtifactKind.PDF, page: null, content: 'SOURCE' },
      ...extracted.pages.map((page) => ({
        kind: PreviewArtifactKind.TEXT,
        page: page.page,
        content: { bytes: Buffer.from(page.text, 'utf8'), mimeType: 'text/plain' },
      })),
    ];
    return { artifacts, pageCount: extracted.pageCount };
  }
}
