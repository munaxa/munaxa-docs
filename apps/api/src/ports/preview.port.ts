import type { PreviewArtifactKindKey } from '@edms/domain';

/**
 * Preview rendering.
 *
 * Renderers are independent plugins registered against the formats they handle, so adding
 * DWG support is a new renderer and nothing else
 * (`docs/architecture/14-preview-architecture.md`). Every renderer runs sandboxed: no
 * database credentials, no network egress, macros disabled, and CPU, memory and time caps.
 */
export const PREVIEW_PORT = Symbol('PreviewPort');
export const RENDERER_REGISTRY = Symbol('RendererRegistry');

export interface RenderRequest {
  readonly sourceKey: string;
  readonly mimeType: string;
  readonly kinds: readonly PreviewArtifactKindKey[];
  /** Rendering the first page fast matters more than rendering all of them. */
  readonly pages: { readonly from: number; readonly to: number };
  readonly limits: RenderLimits;
}

export interface RenderLimits {
  readonly timeoutMs: number;
  readonly maxMemoryMb: number;
  readonly maxOutputBytes: number;
  /** Archive depth, entry count and expansion ratio caps: a zip bomb fails the job, not the worker. */
  readonly maxArchiveDepth: number;
}

export interface RenderedArtifact {
  readonly kind: PreviewArtifactKindKey;
  readonly page: number | null;
  readonly storageKey: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
}

export interface RenderResult {
  readonly artifacts: readonly RenderedArtifact[];
  readonly pageCount: number;
  readonly renderer: string;
  readonly rendererVersion: string;
}

export interface Renderer {
  readonly name: string;
  readonly version: string;
  supports(mimeType: string): boolean;
  render(request: RenderRequest): Promise<RenderResult>;
}

/** Dispatches to the renderer that claims the format. Always the bound implementation of
 *  `PreviewPort`: the choice of renderer is made per file, not per deployment. */
export interface RendererRegistry {
  register(renderer: Renderer): void;
  resolve(mimeType: string): Renderer | null;
  readonly supportedMimeTypes: readonly string[];
}

export interface PreviewPort {
  canRender(mimeType: string): boolean;
  render(request: RenderRequest): Promise<RenderResult>;
}
