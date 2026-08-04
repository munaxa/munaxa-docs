import { Inject, Injectable } from '@nestjs/common';

import {
  type AnyId,
  type FileObjectId,
  PreviewArtifactKind,
  QueueName,
  type RevisionId,
  ScanStatus,
  asId,
  formatFor,
  queueDefinition,
} from '@edms/domain';

import { APP_CONFIG, type AppConfig } from '../../../core/config';
import { LOGGER, type Logger } from '../../../core/observability/logger';
import { OUTBOX_WRITER, type OutboxWriter } from '../../../core/outbox/outbox.port';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../core/prisma/unit-of-work';
import { OCR_PORT, type OcrPort } from '../../../ports/ocr.port';
import { STORAGE_SERVICE, type StorageService } from '../../storage/application/ports';
import { ocrCompletedEvent } from '../domain/events';
import {
  OCR_RESULT_REPOSITORY,
  PREVIEW_ARTIFACT_REPOSITORY,
  type OcrResultRepository,
  type PreviewArtifactRepository,
} from './ports';

export interface OcrRequestFacts {
  readonly revisionId: string;
  readonly fileObjectId: string;
}

/**
 * The slow lane's use case — 14 §6, exactly and only.
 *
 * Runs when the render pipeline found nothing usable in a revision's own text layer. The
 * engine's output never modifies the original: the text lands as an `OCR` artefact (a derived
 * `FileObject`, like every artefact), and the engine, version, language and confidence land in
 * `ocr_result` so the UI can flag a low-confidence read rather than present it as
 * authoritative. `preview.ocr-completed` is published for the search projection Phase 8 builds.
 *
 * Idempotent the same way the render is: an existing `ocr_result` row means a redelivered job
 * has nothing to do, and the artefact upsert plus content-addressed storage make the racing
 * case write one answer.
 */
@Injectable()
export class PreviewOcrService {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    @Inject(OCR_PORT) private readonly ocr: OcrPort,
    @Inject(PREVIEW_ARTIFACT_REPOSITORY) private readonly artifacts: PreviewArtifactRepository,
    @Inject(OCR_RESULT_REPOSITORY) private readonly results: OcrResultRepository,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriter,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async extractText(facts: OcrRequestFacts): Promise<void> {
    const revisionId = asId<RevisionId>(facts.revisionId);
    const fileObjectId = asId<FileObjectId>(facts.fileObjectId);

    const source = await this.uow.run(async () => {
      if ((await this.results.findForRevision(revisionId)) !== null) {
        return null;
      }
      const file = await this.storage.get(fileObjectId);
      if (file === null || file.scanStatus !== ScanStatus.CLEAN) {
        // The same gate as rendering: nothing is read off pixels the scanner has not cleared.
        return null;
      }
      return file;
    });
    if (source === null) {
      return;
    }

    if (!this.ocr.supports(source.mimeType)) {
      // An image-only PDF lands here: the engine reads rasters, and rasterising a PDF page is a
      // rendering job this product does not perform server-side. Recorded as a debug fact, not
      // a failure — the render state is already READY and honest about having no text.
      this.logger.info('OCR skipped: the engine does not read this format', {
        revisionId,
        mimeType: source.mimeType,
      });
      return;
    }

    const bytes = await this.fetchSource(fileObjectId, source.mimeType);
    const result = await this.ocr.extract({
      bytes,
      mimeType: source.mimeType,
      languages: this.config.ocr.languages,
      // The slow lane's own budget: OCR is allowed to be slow, which is why it has its own lane.
      timeoutMs: queueDefinition(QueueName.DOCUMENTS_OCR).timeoutMs,
      maxTextBytes: this.config.preview.maxTextBytes,
    });

    await this.uow.run(async () => {
      if (result.text.length > 0) {
        const stored = await this.storage.storeDerived({
          content: Buffer.from(result.text, 'utf8'),
          mimeType: 'text/plain',
        });
        const saved = await this.artifacts.save({
          revisionId,
          kind: PreviewArtifactKind.OCR,
          page: null,
          fileObjectId: stored.id,
          renderer: result.engine,
          rendererVersion: result.engineVersion,
        });
        if (saved.outcome !== 'UNCHANGED') {
          await this.storage.reference(stored.id);
        }
        if (saved.outcome === 'REPLACED') {
          await this.storage.dereference(saved.displacedFileObjectId);
        }
      }
      await this.results.save({
        revisionId,
        engine: result.engine,
        engineVersion: result.engineVersion,
        language: result.language,
        confidence: Math.round(result.confidence * 100),
        characterCount: result.text.length,
      });
      await this.outbox.publish([
        ocrCompletedEvent(asId<AnyId>(revisionId), {
          revisionId,
          language: result.language,
          confidence: result.confidence,
          characterCount: result.text.length,
        }),
      ]);
    });
  }

  private async fetchSource(fileObjectId: FileObjectId, mimeType: string): Promise<Buffer> {
    const extension = formatFor(mimeType)?.extensions[0] ?? '';
    const signed = await this.storage.createDownloadUrl(fileObjectId, `source${extension}`, {
      inline: true,
    });
    const response = await fetch(signed.url);
    if (!response.ok) {
      throw new Error(`The source blob could not be fetched (${String(response.status)}).`);
    }
    return Buffer.from(await response.arrayBuffer());
  }
}
