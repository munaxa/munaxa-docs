import type { PreviewArtifactKindKey } from '@edms/domain';

/**
 * Preview rendering.
 *
 * Renderers are independent plugins registered against the formats they handle, so adding
 * DWG support is a new renderer and nothing else
 * (`docs/architecture/14-preview-architecture.md`). A renderer knows nothing about documents,
 * permissions or tenants: it is handed bytes and limits, and it answers with bytes. Fetching
 * the source through a presigned URL and storing what comes back are the orchestrator's job —
 * which is what keeps a renderer incapable of holding storage credentials, per 14 §5's
 * least-privilege row, rather than merely told not to.
 *
 * The Phase 0.5 sketch of this port had renderers exchanging storage *keys*; that shape would
 * have required every renderer to reach storage itself, which is the opposite of the sandbox
 * table. Replaced by the byte contract the phase actually runs — the same procedure as the
 * revision module's drifted skeleton ports in Phase 6.
 */
export const PREVIEW_PORT = Symbol('PreviewPort');
export const RENDERER_REGISTRY = Symbol('RendererRegistry');

export interface RenderLimits {
  /** Wall-clock budget for one render. Exceeded means a failed artefact, never a stuck worker. */
  readonly timeoutMs: number;
  /** Ceiling on any single produced artefact. */
  readonly maxOutputBytes: number;
  /** Pages beyond this are not rendered; the result says how many exist. */
  readonly maxPages: number;
  /** Ceiling on one extracted-text artefact, in bytes of UTF-8. */
  readonly maxTextBytes: number;
  /** Archive entry count and expansion caps: a zip bomb fails the job, not the worker. */
  readonly maxArchiveEntries: number;
  readonly maxArchiveExpansionRatio: number;
  /** Ceiling on decoded raster size, before allocation. */
  readonly maxPixels: number;
}

export interface RenderInput {
  /** The source bytes, fetched by the orchestrator through a presigned URL for this one blob. */
  readonly bytes: Buffer;
  /** The *sniffed* MIME type, never the declared one. */
  readonly mimeType: string;
  readonly limits: RenderLimits;
}

/**
 * What one artefact is made of.
 *
 * `'SOURCE'` means the artefact *is* the source blob — a PDF's own rendition, an image serving
 * as its own single page. The orchestrator records a reference to the existing blob instead of
 * storing a copy, which under content addressing would be refused as a duplicate anyway.
 */
export type RenderedContent = { readonly bytes: Buffer; readonly mimeType: string } | 'SOURCE';

export interface RenderedArtifact {
  readonly kind: PreviewArtifactKindKey;
  /** Null for an artefact that is not per page — a thumbnail, unpaginated text, the rendition. */
  readonly page: number | null;
  readonly content: RenderedContent;
}

export interface RenderResult {
  readonly artifacts: readonly RenderedArtifact[];
  /**
   * Pages the source has, when the format has pages at all. Null for formats without
   * pagination (plain text, an unconverted spreadsheet).
   */
  readonly pageCount: number | null;
}

/** Thrown by a renderer that understood the format and could not honestly render it. */
export class RenderFailedError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'RenderFailedError';
  }
}

export interface Renderer {
  /** Recorded on every artefact it produces, with the version, so an upgrade knows its own. */
  readonly key: string;
  readonly version: string;
  supports(mimeType: string): boolean;
  render(input: RenderInput): Promise<RenderResult>;
}

/** Dispatches to the renderer that claims the format. The choice is per file, not per deployment. */
export interface RendererRegistry {
  register(renderer: Renderer): void;
  resolve(mimeType: string): Renderer | null;
  readonly supportedMimeTypes: readonly string[];
}

export interface PreviewPort {
  canRender(mimeType: string): boolean;
  /** Dispatches through the registry. Null when no renderer claims the format. */
  render(
    input: RenderInput,
  ): Promise<(RenderResult & { renderer: string; version: string }) | null>;
}
