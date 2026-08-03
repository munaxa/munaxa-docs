import { Module } from '@nestjs/common';

/**
 * Preview — What does it look like, without downloading it?
 *
 * **Owns:** PreviewArtifact, thumbnails, OcrResult
 * **Depends on:** Storage
 *
 * `RENDERER_REGISTRY` — renderers are plugins, registered per format.
 *
 * Phase 0.5 establishes this module's contracts: the repository and service interfaces in
 * `application/`, and the event contracts in `domain/events.ts`. The entities, use cases,
 * Prisma repositories and controllers that satisfy them are built by the phase that owns
 * this capability — see `README.md` in this folder.
 */
@Module({})
export class PreviewModule {}
