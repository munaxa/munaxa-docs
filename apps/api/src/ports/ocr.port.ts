/**
 * Text extraction from images and scanned pages, feeding the search index
 * (`docs/architecture/12-search-architecture.md`).
 *
 * OCR is slow and runs in its own queue lane. The port is therefore a request/response over
 * bytes already in storage — never over an upload in flight.
 */
export const OCR_PORT = Symbol('OcrPort');

export interface OcrRequest {
  readonly storageKey: string;
  readonly mimeType: string;
  /** BCP-47 hints; the engine may detect something else and say so in the result. */
  readonly languageHints: readonly string[];
  readonly maxPages: number;
  readonly timeoutMs: number;
}

export interface OcrResult {
  readonly text: string;
  readonly language: string;
  /** 0–1. Low confidence is recorded, not hidden: it explains a poor search result later. */
  readonly confidence: number;
  readonly pageCount: number;
  readonly engine: string;
  readonly engineVersion: string;
}

export interface OcrPort {
  readonly engine: string;
  supports(mimeType: string): boolean;
  extract(request: OcrRequest): Promise<OcrResult>;
}
