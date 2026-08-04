import { Module } from '@nestjs/common';

import { type AppConfig, APP_CONFIG } from '../../core/config';
import { PREVIEW_PORT, RENDERER_REGISTRY } from '../../ports/preview.port';
import { DOCUMENT_THUMBNAILER } from '../document/application/thumbnail.port';
import { StorageModule } from '../storage/storage.module';
import { OFFICE_CONVERTER, type OfficeConverter } from './application/office-converter.port';
import { PreviewOcrService } from './application/ocr.service';
import {
  OCR_RESULT_REPOSITORY,
  PREVIEW_ARTIFACT_REPOSITORY,
  PREVIEW_RENDER_REPOSITORY,
} from './application/ports';
import { PreviewQueryService } from './application/preview-query.service';
import { PreviewRenderService } from './application/render.service';
import { ThumbnailService } from './application/thumbnail.service';
import { LibreOfficeConverter, NoOfficeConverter } from './infrastructure/libreoffice.converter';
import { ImageRenderer } from './infrastructure/image.renderer';
import { OfficeRenderer } from './infrastructure/office.renderer';
import { PdfRenderer } from './infrastructure/pdf.renderer';
import {
  DefaultRendererRegistry,
  RegistryPreviewAdapter,
} from './infrastructure/renderer.registry';
import { TextRenderer } from './infrastructure/text.renderer';
import { PreviewConsumer } from './infrastructure/preview.consumer';
import {
  PrismaOcrResultRepository,
  PrismaPreviewArtifactRepository,
  PrismaPreviewRenderRepository,
} from './infrastructure/prisma-preview.repository';
import { PreviewStreamController } from './presentation/preview-stream.controller';

/**
 * Preview — What does it look like, without downloading it?
 *
 * **Owns:** PreviewArtifact, PreviewRender, OcrResult, thumbnails, the renderer plugins
 * **Depends on:** Storage
 *
 * `RENDERER_REGISTRY` — declared in Phase 0.5, deliberately unbound through Phase 3 ("a
 * registry with one entry that is not a plugin would be a registry shaped by its single
 * caller") — binds **here**, in Phase 7, with four genuinely independent plugins: PDF, Office,
 * Image, Text. Each claims its formats and knows nothing about documents, permissions or
 * tenants; adding DWG support is one class and one line in the factory below. The registry is
 * this module's to bind because the plugins are this module's to own — "binds in core" has
 * meant that in this contract since the seam was declared.
 *
 * The async half: `PreviewConsumer` subscribes the two lanes the queue catalogue has carried
 * since Phase 0.5 — `documents.preview` (fast) and `documents.ocr` (slow, separated by cost so
 * OCR cannot starve rendering) — and the outbox dispatcher now routes `document.created` and
 * the `revision.*` events onto the first. `preview.rendered`, `preview.failed` and
 * `preview.ocr-completed`, declared in Phase 0.5, are finally published.
 *
 * The serving half: `PreviewQueryService` answers *what exists and how to present it* for the
 * document module, which owns *whether* (permission → state → confidentiality); the stream
 * controller is where an issued URL is redeemed and where a watermark is burned in.
 *
 * `DOCUMENT_THUMBNAILER` remains bound here — the same inversion as before, unchanged.
 */
@Module({
  imports: [StorageModule],
  controllers: [PreviewStreamController],
  providers: [
    { provide: DOCUMENT_THUMBNAILER, useClass: ThumbnailService },
    {
      provide: OFFICE_CONVERTER,
      useFactory: (config: AppConfig): OfficeConverter =>
        config.providers.office === 'LIBREOFFICE'
          ? new LibreOfficeConverter(config.office.libreofficePath)
          : new NoOfficeConverter(),
      inject: [APP_CONFIG],
    },
    {
      provide: RENDERER_REGISTRY,
      useFactory: (converter: OfficeConverter): DefaultRendererRegistry => {
        const registry = new DefaultRendererRegistry();
        registry.register(new PdfRenderer());
        registry.register(new OfficeRenderer(converter));
        registry.register(new ImageRenderer());
        registry.register(new TextRenderer());
        return registry;
      },
      inject: [OFFICE_CONVERTER],
    },
    {
      provide: PREVIEW_PORT,
      useFactory: (registry: DefaultRendererRegistry) => new RegistryPreviewAdapter(registry),
      inject: [RENDERER_REGISTRY],
    },
    { provide: PREVIEW_ARTIFACT_REPOSITORY, useClass: PrismaPreviewArtifactRepository },
    { provide: PREVIEW_RENDER_REPOSITORY, useClass: PrismaPreviewRenderRepository },
    { provide: OCR_RESULT_REPOSITORY, useClass: PrismaOcrResultRepository },
    PreviewRenderService,
    PreviewOcrService,
    PreviewQueryService,
    PreviewConsumer,
  ],
  exports: [DOCUMENT_THUMBNAILER, PREVIEW_PORT, RENDERER_REGISTRY, PreviewQueryService],
})
export class PreviewModule {}
