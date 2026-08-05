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
import { OCR_PORT, type OcrPort, type OcrResult } from '../../../ports/ocr.port';
import { extractReadableImages } from '../infrastructure/pdf-images';
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

    const readable = this.ocr.supports(source.mimeType);
    const isPdf = source.mimeType === 'application/pdf';
    if (!readable && !isPdf) {
      // A format the engine does not read and this phase cannot lift rasters out of. Recorded as
      // a fact rather than a failure — the render state is already READY and honest about having
      // no text.
      this.logger.info('OCR skipped: the engine does not read this format', {
        revisionId,
        mimeType: source.mimeType,
      });
      return;
    }

    const bytes = await this.fetchSource(fileObjectId, source.mimeType);
    const result = readable
      ? await this.ocr.extract({
          bytes,
          mimeType: source.mimeType,
          languages: this.config.ocr.languages,
          // The slow lane's own budget: OCR is allowed to be slow, which is why it has its lane.
          timeoutMs: queueDefinition(QueueName.DOCUMENTS_OCR).timeoutMs,
          maxTextBytes: this.config.preview.maxTextBytes,
        })
      : await this.readPdfImages(revisionId, bytes);
    if (result === null) {
      return;
    }

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

  /**
   * The image-only PDF path — Phase 7's limit row, discharged as far as it honestly goes.
   *
   * That row said an image-only PDF is not OCR-read because "Tesseract reads rasters; rasterising
   * PDF pages is the job the server deliberately does not do", and rasterising a *page* is still
   * not done: it needs a canvas, a canvas in Node is a native binding, and the lockfile cannot
   * gain one. What changed is the observation that a scanned page does not need rasterising — it
   * *is* a raster, sitting in the file as a `/DCTDecode` XObject whose stream bytes are a JPEG.
   * `pdf-images.ts` lifts them out without decoding anything.
   *
   * Pages are read in order and their text joined with a form feed, which is what a page break in
   * plain text has meant since long before this product; the search projection treats it as
   * whitespace and the in-document search shows the reader where a page ended. The confidence is
   * the **mean weighted by characters**, not the mean of the pages: a fifty-page scan with one
   * blank page must not have its confidence dragged down by a page that legitimately produced
   * nothing, and must not have a bad page hidden by forty-nine good ones either.
   *
   * Answers null when there is nothing to read — no images, or none in a readable encoding — so
   * the caller writes no `ocr_result` at all. That is deliberate: a row saying "we read this and
   * found nothing" and the absence of a row are different claims, and only the second is true when
   * the engine never ran.
   */
  private async readPdfImages(revisionId: RevisionId, pdf: Buffer): Promise<OcrResult | null> {
    const images = await extractReadableImages(pdf, {
      maxImages: this.config.preview.maxPages,
      maxImageBytes: this.config.preview.maxSourceBytes,
    });
    if (images.length === 0) {
      this.logger.info('OCR skipped: this PDF carries no directly readable page images', {
        revisionId,
      });
      return null;
    }

    const budget = queueDefinition(QueueName.DOCUMENTS_OCR).timeoutMs;
    const started = Date.now();
    const pages: string[] = [];
    let weighted = 0;
    let characters = 0;
    let engine = this.ocr.engine;
    let engineVersion = '';

    for (const image of images) {
      const remaining = budget - (Date.now() - started);
      if (remaining <= 0) {
        // The lane's budget is for the whole document, not per page. Stopping with what has been
        // read beats being killed with nothing — a fifty-page scan that OCRs forty pages is forty
        // pages more searchable than one whose job was cut off.
        this.logger.warn('OCR stopped at the lane budget with pages remaining', {
          revisionId,
          pagesRead: pages.length,
          pagesTotal: images.length,
        });
        break;
      }
      const page = await this.ocr.extract({
        bytes: image.bytes,
        mimeType: image.mimeType,
        languages: this.config.ocr.languages,
        timeoutMs: remaining,
        maxTextBytes: this.config.preview.maxTextBytes,
      });
      pages.push(page.text);
      weighted += page.confidence * page.text.length;
      characters += page.text.length;
      engine = page.engine;
      engineVersion = page.engineVersion;
    }

    return {
      text: pages.join('\f'),
      language: this.config.ocr.languages,
      confidence: characters === 0 ? 0 : weighted / characters,
      engine,
      engineVersion,
    };
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
