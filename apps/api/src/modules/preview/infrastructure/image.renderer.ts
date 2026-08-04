import { PDFDocument } from 'pdf-lib';

import { PreviewArtifactKind } from '@edms/domain';

import type {
  RenderInput,
  RenderResult,
  RenderedArtifact,
  Renderer,
} from '../../../ports/preview.port';
import { RenderFailedError } from '../../../ports/preview.port';
import { decodePng, encodePng } from '../domain/png';
import { downscale, thumbnailSizeFor } from '../domain/thumbnail';

const PASSTHROUGH = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'];
const EMBEDDABLE = ['image/png', 'image/jpeg'];

/**
 * The image renderer: one page, and the browser already knows how to draw it.
 *
 * The single `PAGE_IMAGE` is the source blob itself — declared `'SOURCE'`, no transcode: every
 * format here is one browsers render natively, and re-encoding pixels that already display
 * would cost a decoder per format for nothing. PNG and JPEG additionally get a `PDF` rendition
 * (the bytes embedded in a one-page PDF via `pdf-lib`, which parses only the two formats the
 * PDF spec itself carries), because the rendition is what watermarking stamps and what print
 * serves. A PNG also gets its `THUMBNAIL` through the Phase 3 codec, so a check-in draws one
 * the same way an upload does.
 *
 * TIFF is deliberately not claimed: browsers do not display it, decoding it server-side is a
 * codec this product would have to own, and a wrong preview is worse than 14 §7's honest
 * unsupported-format row. A configured OCR engine reads TIFF directly, so a scanned TIFF still
 * becomes searchable text — it just has no picture in the viewer.
 */
export class ImageRenderer implements Renderer {
  readonly key = 'munaxa-image';
  readonly version = '1.0.0';

  supports(mimeType: string): boolean {
    return PASSTHROUGH.includes(mimeType);
  }

  async render(input: RenderInput): Promise<RenderResult> {
    const artifacts: RenderedArtifact[] = [
      { kind: PreviewArtifactKind.PAGE_IMAGE, page: 1, content: 'SOURCE' },
    ];

    if (EMBEDDABLE.includes(input.mimeType)) {
      artifacts.push({
        kind: PreviewArtifactKind.PDF,
        page: null,
        content: { bytes: await embedInPdf(input), mimeType: 'application/pdf' },
      });
    }

    if (input.mimeType === 'image/png') {
      const decoded = decodePng(input.bytes);
      if (decoded !== null) {
        artifacts.push({
          kind: PreviewArtifactKind.THUMBNAIL,
          page: null,
          content: {
            bytes: encodePng(downscale(decoded, thumbnailSizeFor(decoded.width, decoded.height))),
            mimeType: 'image/png',
          },
        });
      }
    }

    return { artifacts, pageCount: 1 };
  }
}

/** The image as a one-page PDF sized to it — what watermarking stamps and print serves. */
async function embedInPdf(input: RenderInput): Promise<Buffer> {
  const document = await PDFDocument.create();
  let image;
  try {
    // A copy, not the Buffer: a pooled Buffer sits at an offset inside a shared ArrayBuffer,
    // and pdf-lib reads its DataView from the ArrayBuffer's start.
    const bytes = new Uint8Array(input.bytes);
    image =
      input.mimeType === 'image/png'
        ? await document.embedPng(bytes)
        : await document.embedJpg(bytes);
  } catch {
    throw new RenderFailedError('The image could not be embedded in a rendition.');
  }
  if (image.width * image.height > input.limits.maxPixels) {
    throw new RenderFailedError(
      `The image is ${String(image.width)}×${String(image.height)}; the pixel cap is ${String(input.limits.maxPixels)}.`,
    );
  }
  const page = document.addPage([image.width, image.height]);
  page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
  const bytes = Buffer.from(await document.save());
  if (bytes.length > input.limits.maxOutputBytes) {
    throw new RenderFailedError(
      `The rendition is ${String(bytes.length)} bytes; the cap is ${String(input.limits.maxOutputBytes)}.`,
    );
  }
  return bytes;
}
