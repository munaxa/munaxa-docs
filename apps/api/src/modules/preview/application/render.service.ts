import { Inject, Injectable } from '@nestjs/common';

import {
  type AnyId,
  type FileObjectId,
  PreviewRenderState,
  QueueName,
  type RevisionId,
  ScanStatus,
  asId,
  formatFor,
} from '@edms/domain';

import { APP_CONFIG, type AppConfig } from '../../../core/config';
import { LOGGER, type Logger } from '../../../core/observability/logger';
import { OUTBOX_WRITER, type OutboxWriter } from '../../../core/outbox/outbox.port';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';
import {
  PREVIEW_PORT,
  type PreviewPort,
  type RenderLimits,
  RenderFailedError,
  type RenderResult,
} from '../../../ports/preview.port';
import { QUEUE_PORT, type QueuePort } from '../../../ports/queue.port';
import { STORAGE_SERVICE, type StorageService } from '../../storage/application/ports';
import { previewFailedEvent, previewRenderedEvent } from '../domain/events';
import { isUsableText } from '../domain/text-quality';
import {
  OCR_RESULT_REPOSITORY,
  PREVIEW_ARTIFACT_REPOSITORY,
  PREVIEW_RENDER_REPOSITORY,
  type OcrResultRepository,
  type PreviewArtifactRepository,
  type PreviewRenderRepository,
} from './ports';

/** What the consumer hands over: the revision to render and the blob it references. */
export interface RenderRequestFacts {
  readonly revisionId: string;
  readonly fileObjectId: string;
}

/**
 * The render orchestrator — everything between "an event said a revision exists" and "artefact
 * rows say what it looks like".
 *
 * The renderers know nothing about documents, tenants or storage; this is the thing that does.
 * It fetches the source through the same presigned path a browser takes, dispatches through the
 * registry under the deployment's resource caps, stores what comes back as derived
 * `FileObject`s, and records the outcome — artefact rows, the render-state row behind "202 with
 * status", and the `preview.rendered` / `preview.failed` events, all in one transaction, so a
 * crash leaves either the whole answer or none of it.
 *
 * **Antivirus first, below everything** (14 §5): the verdict is checked before a byte is
 * fetched. The database trigger already refuses a revision referencing an unclean blob, so in
 * the ordinary world this check finds `CLEAN`; it exists for the extraordinary one — a verdict
 * changed after attachment, an event replayed across a quarantine — and the refusal is recorded
 * as a failed render, visibly, never silently.
 *
 * **Idempotent under redelivery.** The outbox is at-least-once. A redelivered job finds the
 * render-state row `READY` under the current renderer version and stops; a redelivery that
 * races the first delivery re-derives byte-identical artefacts whose rows upsert into place
 * under `uq_preview_artifact` and whose blobs dedupe by content — nothing duplicates, which the
 * integration suite asks the database to confirm.
 */
@Injectable()
export class PreviewRenderService {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    @Inject(PREVIEW_PORT) private readonly preview: PreviewPort,
    @Inject(PREVIEW_ARTIFACT_REPOSITORY) private readonly artifacts: PreviewArtifactRepository,
    @Inject(PREVIEW_RENDER_REPOSITORY) private readonly renders: PreviewRenderRepository,
    @Inject(OCR_RESULT_REPOSITORY) private readonly ocrResults: OcrResultRepository,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriter,
    @Inject(QUEUE_PORT) private readonly queue: QueuePort,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Renders a revision's artefacts if they do not already exist. The consumer's whole use case.
   *
   * Throwing means "retry me": the queue re-delivers with backoff and dead-letters what keeps
   * failing. Terminal answers — unsupported format, unclean source, a renderer that failed —
   * are recorded and *not* thrown, because five more attempts would reach the same conclusion.
   */
  async ensureRendered(facts: RenderRequestFacts): Promise<void> {
    const revisionId = asId<RevisionId>(facts.revisionId);
    const fileObjectId = asId<FileObjectId>(facts.fileObjectId);

    const source = await this.uow.run(async () => {
      const file = await this.storage.get(fileObjectId);
      if (file === null) {
        return null;
      }
      const claim = await this.renders.claim(revisionId);
      if (claim.state === PreviewRenderState.READY) {
        // Redelivery of work already done — the common case under at-least-once, and the cheap
        // exit matters: no bytes are fetched for it. A renderer *upgrade* re-rendering old
        // artefacts is 14 §7's background campaign, an explicit act, never a redelivered event.
        return null;
      }
      if (file.scanStatus !== ScanStatus.CLEAN) {
        // Nothing renders before the verdict is CLEAN — 14 §5's antivirus row, held here even
        // though the content gate makes an unclean revision hard to construct.
        await this.settleFailed(revisionId, null, `The source is not clean (${file.scanStatus}).`);
        return null;
      }
      return file;
    });
    if (source === null) {
      return;
    }

    if (!this.preview.canRender(source.mimeType)) {
      await this.uow.run(async () => {
        await this.renders.settle(revisionId, {
          state: PreviewRenderState.UNSUPPORTED,
          reason: `No renderer claims ${source.mimeType}.`,
          renderer: null,
          rendererVersion: null,
          pageCount: null,
        });
        await this.outbox.publish([
          previewFailedEvent(asId<AnyId>(revisionId), {
            revisionId,
            reason: `No renderer claims ${source.mimeType}.`,
            renderer: null,
          }),
        ]);
      });
      return;
    }

    if (source.sizeBytes > this.config.preview.maxSourceBytes) {
      await this.uow.run(() =>
        this.settleFailed(
          revisionId,
          null,
          `The source is ${String(source.sizeBytes)} bytes; the render ceiling is ${String(this.config.preview.maxSourceBytes)}.`,
        ),
      );
      return;
    }

    let rendered: (RenderResult & { renderer: string; version: string }) | null;
    try {
      const bytes = await this.fetchSource(fileObjectId, source.mimeType);
      rendered = await this.withDeadline(
        this.preview.render({ bytes, mimeType: source.mimeType, limits: this.limits() }),
        this.config.preview.timeoutMs,
      );
    } catch (error) {
      if (error instanceof RenderFailedError) {
        await this.uow.run(() => this.settleFailed(revisionId, null, error.reason, true));
        return;
      }
      // Infrastructure trouble — storage unreachable, a timeout that may be load. Retryable.
      throw error;
    }
    if (rendered === null) {
      // `canRender` said yes a moment ago; a converter losing its binary between the two is the
      // kind of drift that deserves a retry, not a terminal verdict.
      throw new Error(`The registry no longer claims ${source.mimeType}.`);
    }
    const outcome = rendered;

    let textCharacters = 0;
    await this.uow.run(async () => {
      for (const artifact of outcome.artifacts) {
        const stored =
          artifact.content === 'SOURCE'
            ? fileObjectId
            : (
                await this.storage.storeDerived({
                  content: artifact.content.bytes,
                  mimeType: artifact.content.mimeType,
                })
              ).id;
        if (artifact.content !== 'SOURCE' && artifact.kind === 'TEXT') {
          textCharacters += artifact.content.bytes.toString('utf8').length;
        }
        const saved = await this.artifacts.save({
          revisionId,
          kind: artifact.kind,
          page: artifact.page,
          fileObjectId: stored,
          renderer: outcome.renderer,
          rendererVersion: outcome.version,
        });
        // Reference counting follows what the row actually did: a fresh row claims its blob, a
        // replacement also releases the displaced one, and a redelivered no-op counts nothing —
        // the difference the integration suite counts in `file_object.ref_count`.
        if (saved.outcome !== 'UNCHANGED') {
          await this.storage.reference(stored);
        }
        if (saved.outcome === 'REPLACED') {
          await this.storage.dereference(saved.displacedFileObjectId);
        }
      }
      await this.renders.settle(revisionId, {
        state: PreviewRenderState.READY,
        reason: null,
        renderer: outcome.renderer,
        rendererVersion: outcome.version,
        pageCount: outcome.pageCount,
      });
      await this.outbox.publish([
        previewRenderedEvent(asId<AnyId>(revisionId), {
          revisionId,
          pageCount: outcome.pageCount ?? 0,
          renderer: outcome.renderer,
          rendererVersion: outcome.version,
        }),
      ]);
    });

    await this.maybeQueueOcr(revisionId, fileObjectId, source.mimeType, textCharacters);
  }

  /**
   * The OCR decision, 14 §6: only when text extraction yielded nothing usable, only when an
   * engine is configured and reads the format, and only once per revision.
   */
  private async maybeQueueOcr(
    revisionId: RevisionId,
    fileObjectId: FileObjectId,
    mimeType: string,
    textCharacters: number,
  ): Promise<void> {
    if (this.config.providers.ocr === 'NONE' || isUsableText(textCharacters)) {
      return;
    }
    if (formatFor(mimeType)?.family !== 'IMAGE' && mimeType !== 'application/pdf') {
      return;
    }
    const already = await this.uow.run(() => this.ocrResults.findForRevision(revisionId));
    if (already !== null) {
      return;
    }
    const context = requireContext();
    await this.queue.enqueue(
      QueueName.DOCUMENTS_OCR,
      {
        revisionId,
        fileObjectId,
        tenantId: context.tenantId,
        correlationId: context.correlationId,
      },
      // Derived from the revision, so a redelivered render enqueues one OCR job, not several.
      { jobId: `ocr:${revisionId}` },
    );
  }

  private async settleFailed(
    revisionId: RevisionId,
    renderer: string | null,
    reason: string,
    publish = true,
  ): Promise<void> {
    await this.renders.settle(revisionId, {
      state: PreviewRenderState.FAILED,
      reason,
      renderer,
      rendererVersion: null,
      pageCount: null,
    });
    if (publish) {
      await this.outbox.publish([
        previewFailedEvent(asId<AnyId>(revisionId), { revisionId, reason, renderer }),
      ]);
    }
    this.logger.warn('A preview render failed', { revisionId, reason });
  }

  /**
   * The source bytes, through a signed URL the API redeems itself — the same path a browser
   * takes, and the only shape a renderer input has: one blob, no credentials (14 §5).
   */
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

  private limits(): RenderLimits {
    const preview = this.config.preview;
    return {
      timeoutMs: preview.timeoutMs,
      maxOutputBytes: preview.maxOutputBytes,
      maxPages: preview.maxPages,
      maxTextBytes: preview.maxTextBytes,
      maxArchiveEntries: preview.maxArchiveEntries,
      maxArchiveExpansionRatio: preview.maxArchiveExpansionRatio,
      maxPixels: preview.maxPixels,
    };
  }

  /**
   * The wall-clock cap. A promise cannot be cancelled, so an overrun is *abandoned* — its slot
   * freed, its eventual result discarded — which is the strongest guarantee a single-process
   * runtime offers; the subprocess engines additionally kill their children at the same budget.
   */
  private withDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new RenderFailedError(`Rendering exceeded its ${String(timeoutMs)} ms budget.`));
      }, timeoutMs);
      work.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }
}
