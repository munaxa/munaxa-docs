import { PreviewArtifactKind, formatFor } from '@edms/domain';

import type {
  RenderInput,
  RenderResult,
  RenderedArtifact,
  Renderer,
} from '../../../ports/preview.port';
import type { OfficeConverter } from '../application/office-converter.port';
import {
  type ExtractedText,
  extractDocxText,
  extractPptxText,
  extractXlsxText,
} from '../domain/ooxml';
import type { ZipLimits } from '../domain/zip';
import { extractPdfText } from './pdf-text';

const OOXML_WORD = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const OOXML_SHEET = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const OOXML_SLIDES = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const LEGACY_WORD = 'application/msword';
const LEGACY_SHEET = 'application/vnd.ms-excel';
const LEGACY_SLIDES = 'application/vnd.ms-powerpoint';

/**
 * The Office renderer: Word, Excel, PowerPoint — modern and legacy.
 *
 * Two halves, degrading independently:
 *
 * - **Text** is a parse, not a layout job: every OOXML document is a ZIP of XML whose text
 *   lives in specification-fixed tags (`domain/ooxml.ts`), so extraction needs no engine and
 *   works in every deployment. Search, in-document search and comparison get their words even
 *   where no converter is installed.
 * - **Pages** need a layout engine, which is the `OfficeConverter` deployment decision. With
 *   one, the file becomes a PDF rendition and the rendition's own text layer supersedes the raw
 *   parse — it is the same words, paginated. Without one, there is no rendition, `pageCount`
 *   stays null, and the viewer shows the extracted text.
 *
 * The legacy OLE2 formats have no XML to parse, so they are claimed only when a converter
 * exists to read them; otherwise they land on 14 §7's unsupported-format row, which is the
 * honest answer for a binary format only an office suite can open.
 */
export class OfficeRenderer implements Renderer {
  readonly key = 'munaxa-office';
  readonly version = '1.0.0';

  constructor(private readonly converter: OfficeConverter) {}

  supports(mimeType: string): boolean {
    if ([OOXML_WORD, OOXML_SHEET, OOXML_SLIDES].includes(mimeType)) {
      return true;
    }
    return (
      [LEGACY_WORD, LEGACY_SHEET, LEGACY_SLIDES].includes(mimeType) && this.converter.available
    );
  }

  async render(input: RenderInput): Promise<RenderResult> {
    const zipLimits: ZipLimits = {
      maxEntries: input.limits.maxArchiveEntries,
      maxExpansionRatio: input.limits.maxArchiveExpansionRatio,
      maxEntryBytes: input.limits.maxOutputBytes,
    };

    if (!this.converter.available) {
      // Text-only, honestly. Only OOXML reaches here — `supports` refused the legacy formats.
      const text = extractOoxml(input.mimeType, input.bytes, zipLimits);
      return { artifacts: textArtifacts(text, input.limits.maxTextBytes), pageCount: null };
    }

    const rendition = await this.converter.convertToPdf(input.bytes, extensionFor(input.mimeType), {
      timeoutMs: input.limits.timeoutMs,
      maxOutputBytes: input.limits.maxOutputBytes,
    });
    // The rendition's text layer is the extraction: the same words the raw parse would find,
    // but paginated the way the reader will see them — which is what page-anchored search
    // and "jump to page" need.
    const extracted = await extractPdfText(rendition, input.limits);
    const artifacts: RenderedArtifact[] = [
      {
        kind: PreviewArtifactKind.PDF,
        page: null,
        content: { bytes: rendition, mimeType: 'application/pdf' },
      },
      ...extracted.pages.map((page) => ({
        kind: PreviewArtifactKind.TEXT,
        page: page.page,
        content: { bytes: Buffer.from(page.text, 'utf8'), mimeType: 'text/plain' },
      })),
    ];
    if (extracted.pages.length === 0) {
      // A converted document whose PDF has no text layer (a sheet of charts, a deck of
      // pictures) still deserves the raw parse when there is one.
      const fallback = isOoxml(input.mimeType)
        ? extractOoxml(input.mimeType, input.bytes, zipLimits)
        : [];
      artifacts.push(...textArtifacts(fallback, input.limits.maxTextBytes));
    }
    return { artifacts, pageCount: extracted.pageCount };
  }
}

function isOoxml(mimeType: string): boolean {
  return [OOXML_WORD, OOXML_SHEET, OOXML_SLIDES].includes(mimeType);
}

function extractOoxml(
  mimeType: string,
  bytes: Buffer,
  limits: ZipLimits,
): readonly ExtractedText[] {
  switch (mimeType) {
    case OOXML_WORD:
      return extractDocxText(bytes, limits);
    case OOXML_SHEET:
      return extractXlsxText(bytes, limits);
    case OOXML_SLIDES:
      return extractPptxText(bytes, limits);
    default:
      return [];
  }
}

function textArtifacts(text: readonly ExtractedText[], maxTextBytes: number): RenderedArtifact[] {
  return text.map((entry) => ({
    kind: PreviewArtifactKind.TEXT,
    page: entry.page,
    content: {
      bytes: capUtf8(Buffer.from(entry.text, 'utf8'), maxTextBytes),
      mimeType: 'text/plain',
    },
  }));
}

function capUtf8(bytes: Buffer, maxBytes: number): Buffer {
  if (bytes.length <= maxBytes) {
    return bytes;
  }
  // Cut on a codepoint boundary: a truncated multi-byte sequence would corrupt the artefact.
  let end = maxBytes;
  while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) {
    end -= 1;
  }
  return bytes.subarray(0, end);
}

/** The engine's input extension, from the sniffed type — never from the uploaded filename. */
function extensionFor(mimeType: string): string {
  const extension = formatFor(mimeType)?.extensions[0];
  if (extension === undefined) {
    throw new Error(`No extension is known for ${mimeType}.`);
  }
  return extension;
}
