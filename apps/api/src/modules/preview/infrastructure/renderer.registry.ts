import { Injectable } from '@nestjs/common';

import { SUPPORTED_MIME_TYPES, normalizeMimeType } from '@edms/domain';

import type {
  PreviewPort,
  RenderInput,
  RenderResult,
  Renderer,
  RendererRegistry,
} from '../../../ports/preview.port';

/**
 * The registry `RENDERER_REGISTRY` declared in Phase 0.5 and this phase finally binds.
 *
 * Deliberately dumb: renderers register, formats resolve, first claim wins in registration
 * order. Everything interesting — what a format becomes, what an engine costs, what a
 * deployment carries — lives in the plugins, which is the whole point of the seam: adding DWG
 * support is one class and one registration, and a failing renderer degrades only its own
 * formats (`docs/architecture/14-preview-architecture.md` §2).
 *
 * What has **no** renderer, and why, is as deliberate as what has:
 *
 * - **DWG/CAD** — every real engine is either proprietary (ODA) or a native toolchain, and
 *   both are exactly the dependency an air-gapped on-premise installer meets badly, for a
 *   format whose fidelity errors are the kind an engineer acts on. 14 §7's unsupported-format
 *   row — no preview, download offered where permitted, the UI saying so — is the designed
 *   behaviour, not a gap.
 * - **TIFF** — browsers do not display it and decoding it server-side is a codec to own; OCR
 *   reads it directly, so it becomes searchable without becoming a picture.
 * - **ZIP** — an archive is a container, not a document; listing its contents is a feature
 *   nobody has asked for and rendering one is meaningless.
 */
@Injectable()
export class DefaultRendererRegistry implements RendererRegistry {
  private readonly renderers: Renderer[] = [];

  register(renderer: Renderer): void {
    this.renderers.push(renderer);
  }

  resolve(mimeType: string): Renderer | null {
    const normalized = normalizeMimeType(mimeType);
    return this.renderers.find((renderer) => renderer.supports(normalized)) ?? null;
  }

  get supportedMimeTypes(): readonly string[] {
    // The stored-format catalogue, filtered by asking the plugins — so a converter-dependent
    // claim (the legacy Office formats) is answered by the renderer that knows, not by a list
    // somebody keeps beside it.
    return SUPPORTED_MIME_TYPES.filter((mimeType) => this.resolve(mimeType) !== null);
  }
}

/** The bound `PreviewPort`: the registry, dispatching per file — never per deployment. */
@Injectable()
export class RegistryPreviewAdapter implements PreviewPort {
  constructor(private readonly registry: DefaultRendererRegistry) {}

  canRender(mimeType: string): boolean {
    return this.registry.resolve(mimeType) !== null;
  }

  async render(
    input: RenderInput,
  ): Promise<(RenderResult & { renderer: string; version: string }) | null> {
    const renderer = this.registry.resolve(input.mimeType);
    if (renderer === null) {
      return null;
    }
    const result = await renderer.render(input);
    return { ...result, renderer: renderer.key, version: renderer.version };
  }
}
