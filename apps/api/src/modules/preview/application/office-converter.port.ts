/**
 * The office-to-PDF converter — the one external tool the preview pipeline may use.
 *
 * Converting a Word, Excel or PowerPoint file into pages requires a layout engine, and a layout
 * engine for those formats is an office suite: nothing hand-writable, nothing pure. That makes
 * it a deployment decision, taken the way every other external capability here is taken —
 * `OFFICE_DRIVER`, validated at boot, `NONE` degrading honestly: Office documents still get
 * their text extracted (that is a parse, not a layout job) and the viewer shows text; what they
 * do not get is a paginated rendition. The same posture as `OCR_DRIVER=NONE` and
 * `AV_DRIVER=NONE` — a deployment without the tool loses the capability, never the honesty.
 */
export const OFFICE_CONVERTER = Symbol('OfficeConverter');

export interface OfficeConversionLimits {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface OfficeConverter {
  /** Whether a real engine is configured. False means renderers degrade to text-only. */
  readonly available: boolean;
  /**
   * The source bytes as a PDF.
   *
   * `extension` names the input format for the engine (with the dot, e.g. `.docx`), derived
   * from the sniffed MIME type — never from the uploaded filename.
   */
  convertToPdf(bytes: Buffer, extension: string, limits: OfficeConversionLimits): Promise<Buffer>;
}
