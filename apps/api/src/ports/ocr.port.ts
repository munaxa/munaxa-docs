/**
 * Text extraction from images and scanned pages, feeding the search index
 * (`docs/architecture/12-search-architecture.md`).
 *
 * OCR is slow and runs in its own queue lane. The port is a request/response over bytes the
 * orchestrator fetched through a presigned URL for that one blob — an engine adapter holds no
 * storage credentials, the same least-privilege row every renderer sits under
 * (`14-preview-architecture.md` §5). The Phase 0.5 sketch passed a storage key instead; that
 * shape would have required every engine to reach storage itself, and is replaced the same way
 * the preview port's was.
 */
export const OCR_PORT = Symbol('OcrPort');

export interface OcrRequest {
  readonly bytes: Buffer;
  /** The *sniffed* MIME type. */
  readonly mimeType: string;
  /** In the engine's own syntax, e.g. `ara+eng` for Tesseract. */
  readonly languages: string;
  readonly timeoutMs: number;
  /** Ceiling on the extracted text, in bytes of UTF-8. */
  readonly maxTextBytes: number;
}

export interface OcrResult {
  readonly text: string;
  readonly language: string;
  /** 0–1. Low confidence is recorded, not hidden: it explains a poor search result later. */
  readonly confidence: number;
  readonly engine: string;
  readonly engineVersion: string;
}

export interface OcrPort {
  readonly engine: string;
  supports(mimeType: string): boolean;
  extract(request: OcrRequest): Promise<OcrResult>;
}
