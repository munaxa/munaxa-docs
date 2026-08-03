import type { PreviewArtifactId, PreviewArtifactKindKey, RevisionId } from '@edms/domain';

/**
 * Preview artefacts are disposable: every one of them is rebuildable from the source blob,
 * so they are cached hard, addressed by content, and never treated as authoritative
 * (`docs/architecture/14-preview-architecture.md`).
 */
export const PREVIEW_ARTIFACT_REPOSITORY = Symbol('PreviewArtifactRepository');
export const OCR_RESULT_REPOSITORY = Symbol('OcrResultRepository');

export interface PreviewArtifactRecord {
  readonly id: PreviewArtifactId;
  readonly revisionId: RevisionId;
  readonly kind: PreviewArtifactKindKey;
  readonly page: number | null;
  readonly storageKey: string;
  readonly renderer: string;
  readonly rendererVersion: string;
}

export interface PreviewArtifactRepository {
  find(
    revisionId: RevisionId,
    kind: PreviewArtifactKindKey,
    page: number | null,
  ): Promise<PreviewArtifactRecord | null>;
  listForRevision(revisionId: RevisionId): Promise<readonly PreviewArtifactRecord[]>;
  save(artifact: PreviewArtifactRecord): Promise<void>;
  /** A renderer upgrade invalidates what the old version produced. */
  deleteForRenderer(renderer: string, olderThanVersion: string): Promise<number>;
}

export interface OcrResultRepository {
  findForRevision(
    revisionId: RevisionId,
  ): Promise<{ text: string; language: string; confidence: number } | null>;
  save(
    revisionId: RevisionId,
    result: { text: string; language: string; confidence: number },
  ): Promise<void>;
}

export const PREVIEW_SERVICE = Symbol('PreviewService');

export interface PreviewService {
  /** First page immediately, further pages on demand: a 400-page manual must not block. */
  urlForPage(
    revisionId: RevisionId,
    page: number,
  ): Promise<{ url: string; expiresAt: Date } | null>;
  thumbnailUrl(revisionId: RevisionId): Promise<{ url: string; expiresAt: Date } | null>;
  extractedText(revisionId: RevisionId): Promise<string | null>;
}
