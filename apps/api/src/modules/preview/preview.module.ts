import { Module } from '@nestjs/common';

import { DOCUMENT_THUMBNAILER } from '../document/application/thumbnail.port';
import { StorageModule } from '../storage/storage.module';
import { ThumbnailService } from './application/thumbnail.service';

/**
 * Preview — What does it look like, without downloading it?
 *
 * **Owns:** PreviewArtifact, thumbnails, OcrResult
 * **Depends on:** Storage
 *
 * `RENDERER_REGISTRY` — renderers are plugins, registered per format. Still unbound, and correctly
 * so: Phase 3 owns the **upload-time thumbnail only**, and a registry with one entry that is not a
 * plugin would be a registry shaped by its single caller. Phase 7 builds it, along with the
 * sandboxed renderers a PDF, an Office document and a DWG each need.
 *
 * What Phase 3 does build is the artefact table and one producer for it, so a document uploaded
 * today has a thumbnail and Phase 7 inherits a schema rather than a migration.
 *
 * `DOCUMENT_THUMBNAILER` is declared in `document/application/thumbnail.port.ts` and implemented
 * here — the same inversion `RevisionModule` uses, and for the same reason: Preview depends on
 * Storage and on nothing above it, so Document declares what it needs and this module satisfies it.
 * The port's whole contract is that it never fails a document, which is why it returns nothing.
 */
@Module({
  imports: [StorageModule],
  providers: [{ provide: DOCUMENT_THUMBNAILER, useClass: ThumbnailService }],
  exports: [DOCUMENT_THUMBNAILER],
})
export class PreviewModule {}
