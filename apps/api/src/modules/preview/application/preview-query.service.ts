import { Inject, Injectable } from '@nestjs/common';

import {
  type FileObjectId,
  PreviewArtifactKind,
  PreviewRenderState,
  type PreviewRenderStateKey,
  type RevisionId,
} from '@edms/domain';

import { APP_CONFIG, type AppConfig } from '../../../core/config';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';
import { CLOCK_PORT, type ClockPort } from '../../../ports/clock.port';
import { STORAGE_PORT, type StoragePort } from '../../../ports/storage.port';
import { STORAGE_SERVICE, type StorageService } from '../../storage/application/ports';
import { LOW_OCR_CONFIDENCE_THRESHOLD } from '../domain/ocr-quality';
import { stampViewer } from '../domain/watermark-text';
import { PREVIEW_STREAM_PATH, encodePreviewToken } from '../domain/preview-stream-token';
import {
  OCR_RESULT_REPOSITORY,
  PREVIEW_ARTIFACT_REPOSITORY,
  PREVIEW_RENDER_REPOSITORY,
  type OcrResultRepository,
  type PreviewArtifactRepository,
  type PreviewRenderRepository,
} from './ports';

/** What exists for a revision — the read side of the pipeline, with no opinions about who asks. */
export interface PreviewFacts {
  readonly state: PreviewRenderStateKey;
  readonly reason: string | null;
  readonly pageCount: number | null;
  /** How a viewer should present this revision, given what was rendered. */
  readonly mode: 'PDF' | 'IMAGE' | 'TEXT' | null;
  readonly hasText: boolean;
  readonly ocr: {
    readonly engine: string;
    readonly confidence: number;
    readonly lowConfidence: boolean;
  } | null;
}

export interface ViewTarget {
  readonly fileObjectId: FileObjectId;
  readonly mimeType: string;
  readonly mode: 'PDF' | 'IMAGE';
}

export interface TextPages {
  readonly source: 'TEXT' | 'OCR';
  readonly lowConfidence: boolean;
  readonly pages: readonly { readonly page: number | null; readonly text: string }[];
}

/**
 * What the document module asks when it serves a preview.
 *
 * Deliberately ignorant of documents, permissions and confidentiality: the caller has already
 * decided *whether* — permission → state → confidentiality, in the document module where those
 * words mean something — and this answers *what and how*. The split is what keeps the viewer's
 * data path incapable of deciding access by accident.
 */
@Injectable()
export class PreviewQueryService {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(PREVIEW_ARTIFACT_REPOSITORY) private readonly artifacts: PreviewArtifactRepository,
    @Inject(PREVIEW_RENDER_REPOSITORY) private readonly renders: PreviewRenderRepository,
    @Inject(OCR_RESULT_REPOSITORY) private readonly ocrResults: OcrResultRepository,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    @Inject(STORAGE_PORT) private readonly storagePort: StoragePort,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK_PORT) private readonly clock: ClockPort,
  ) {}

  /** Joins the caller's transaction. */
  async facts(revisionId: RevisionId): Promise<PreviewFacts> {
    const [render, rows, ocr] = await Promise.all([
      this.renders.find(revisionId),
      this.artifacts.listForRevision(revisionId),
      this.ocrResults.findForRevision(revisionId),
    ]);
    const hasPdf = rows.some((row) => row.kind === PreviewArtifactKind.PDF);
    const hasImage = rows.some((row) => row.kind === PreviewArtifactKind.PAGE_IMAGE);
    const hasText = rows.some(
      (row) => row.kind === PreviewArtifactKind.TEXT || row.kind === PreviewArtifactKind.OCR,
    );
    return {
      // No row yet means the event has not been consumed yet, which to a caller is PENDING —
      // "not ready, ask again" — not an error.
      state: render?.state ?? PreviewRenderState.PENDING,
      reason: render?.reason ?? null,
      pageCount: render?.pageCount ?? null,
      mode: hasPdf ? 'PDF' : hasImage ? 'IMAGE' : hasText ? 'TEXT' : null,
      hasText,
      ocr:
        ocr === null
          ? null
          : {
              engine: `${ocr.engine} ${ocr.engineVersion}`,
              confidence: ocr.confidence,
              lowConfidence: ocr.confidence < LOW_OCR_CONFIDENCE_THRESHOLD,
            },
    };
  }

  /** The artefact a viewer draws — the rendition when one exists, the single page otherwise. */
  async viewTarget(revisionId: RevisionId): Promise<ViewTarget | null> {
    const pdf = await this.artifacts.find(revisionId, PreviewArtifactKind.PDF, null);
    const chosen =
      pdf ?? (await this.artifacts.find(revisionId, PreviewArtifactKind.PAGE_IMAGE, 1));
    if (chosen === null) {
      return null;
    }
    const file = await this.storage.get(chosen.fileObjectId);
    if (file === null) {
      return null;
    }
    return {
      fileObjectId: chosen.fileObjectId,
      mimeType: file.mimeType,
      mode: chosen.kind === PreviewArtifactKind.PDF ? 'PDF' : 'IMAGE',
    };
  }

  /**
   * A short-lived, single-artefact URL onto the preview stream.
   *
   * Minted, not presigned: the stream endpoint is where a watermark is burned in before a byte
   * leaves, which storage's own presigned URLs cannot do. The TTL is the deployment's signed-URL
   * TTL — one policy for how long an issued link lives, wherever it points.
   */
  issueStreamUrl(
    target: ViewTarget,
    options: {
      readonly disposition: 'inline' | 'attachment';
      readonly watermark: { viewer: string; viewerFallback: string; reference: string } | null;
    },
  ): { url: string; expiresAt: Date } {
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + this.config.storage.signedUrlTtlSeconds * 1000);
    const token = encodePreviewToken(this.config.auth.accessSecret, {
      fileObjectId: target.fileObjectId,
      tenantId: requireContext().tenantId,
      mimeType: target.mimeType,
      disposition: options.disposition,
      expiresAt,
      watermark:
        options.watermark === null
          ? null
          : {
              viewer: stampViewer(options.watermark.viewer, options.watermark.viewerFallback),
              reference: options.watermark.reference,
              issuedAt: `${now.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
            },
    });
    return { url: `${this.streamBase()}?token=${token}`, expiresAt };
  }

  /**
   * The extracted words, per page — the file's own text layer when the renderer found one, the
   * OCR read otherwise, and the answer says which, because an inference is flagged, never
   * passed off as the document's own words (14 §6).
   */
  async textPages(revisionId: RevisionId): Promise<TextPages | null> {
    const rows = await this.uow.run(() => this.artifacts.listForRevision(revisionId));
    const text = rows
      .filter((row) => row.kind === PreviewArtifactKind.TEXT)
      .sort((a, b) => (a.page ?? 0) - (b.page ?? 0));
    const chosen =
      text.length > 0 ? text : rows.filter((row) => row.kind === PreviewArtifactKind.OCR);
    if (chosen.length === 0) {
      return null;
    }
    const source = text.length > 0 ? 'TEXT' : 'OCR';
    const ocr =
      source === 'OCR'
        ? await this.uow.run(() => this.ocrResults.findForRevision(revisionId))
        : null;

    const pages: { page: number | null; text: string }[] = [];
    for (const row of chosen) {
      pages.push({ page: row.page, text: await this.readArtifact(row.fileObjectId) });
    }
    return {
      source,
      lowConfidence: ocr !== null && ocr.confidence < LOW_OCR_CONFIDENCE_THRESHOLD,
      pages,
    };
  }

  private async readArtifact(fileObjectId: FileObjectId): Promise<string> {
    const file = await this.uow.run(() => this.storage.get(fileObjectId));
    if (file === null) {
      return '';
    }
    // The raw port rather than the audited service: reading derived text back to serve search
    // and comparison is the pipeline consuming its own output, not bytes leaving to a person —
    // the audited fact is the issuance of the preview itself, recorded by the caller.
    const signed = await this.storagePort.createDownloadUrl(file.storageKey, {
      expiresInSeconds: 60,
      inline: true,
    });
    const response = await fetch(signed.url);
    return response.ok ? await response.text() : '';
  }

  private streamBase(): string {
    const base = (
      this.config.storage.publicUrl ?? `http://localhost:${String(this.config.app.port)}`
    ).replace(/\/$/, '');
    return `${base}/api/v1/${PREVIEW_STREAM_PATH}`;
  }
}
