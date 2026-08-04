import type {
  FileObjectId,
  PreviewArtifactKindKey,
  PreviewRenderStateKey,
  RevisionId,
} from '@edms/domain';

/**
 * Preview artefacts are disposable: every one of them is rebuildable from the source blob,
 * so they are cached hard, addressed by content, and never treated as authoritative
 * (`docs/architecture/14-preview-architecture.md`).
 *
 * The record shapes here match the tables — the Phase 0.5 sketches carried a `storageKey`
 * the table never had, and were replaced when this phase bound the repositories, the same
 * procedure as the revision module's drifted skeleton ports in Phase 6.
 */
export const PREVIEW_ARTIFACT_REPOSITORY = Symbol('PreviewArtifactRepository');
export const PREVIEW_RENDER_REPOSITORY = Symbol('PreviewRenderRepository');
export const OCR_RESULT_REPOSITORY = Symbol('OcrResultRepository');

export interface PreviewArtifactRecord {
  readonly revisionId: RevisionId;
  readonly kind: PreviewArtifactKindKey;
  readonly page: number | null;
  readonly fileObjectId: FileObjectId;
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
  /**
   * Insert-or-replace on `(revision, kind, page)`, answering what happened.
   *
   * The caller adjusts blob reference counts from the answer: a `CREATED` row references its
   * blob, a `REPLACED` one also dereferences what it displaced — and `UNCHANGED`, the
   * redelivered render whose artefacts are byte-identical under content addressing, counts
   * nothing twice. The integration suite counts.
   */
  save(artifact: PreviewArtifactRecord): Promise<ArtifactSaveOutcome>;
}

export type ArtifactSaveOutcome =
  | { readonly outcome: 'CREATED' }
  | { readonly outcome: 'UNCHANGED' }
  | { readonly outcome: 'REPLACED'; readonly displacedFileObjectId: FileObjectId };

export interface PreviewRenderRecord {
  readonly revisionId: RevisionId;
  readonly state: PreviewRenderStateKey;
  readonly reason: string | null;
  readonly renderer: string | null;
  readonly rendererVersion: string | null;
  readonly pageCount: number | null;
  readonly attempts: number;
}

/** The row behind "202 with status": one per revision, upserted by the consumer. */
export interface PreviewRenderRepository {
  find(revisionId: RevisionId): Promise<PreviewRenderRecord | null>;
  /** Creates as PENDING or increments the existing row's attempts. */
  claim(revisionId: RevisionId): Promise<PreviewRenderRecord>;
  settle(
    revisionId: RevisionId,
    outcome: {
      state: PreviewRenderStateKey;
      reason: string | null;
      renderer: string | null;
      rendererVersion: string | null;
      pageCount: number | null;
    },
  ): Promise<void>;
}

export interface OcrResultRecord {
  readonly revisionId: RevisionId;
  readonly engine: string;
  readonly engineVersion: string;
  readonly language: string;
  /** 0–100, as stored. */
  readonly confidence: number;
  readonly characterCount: number;
}

export interface OcrResultRepository {
  findForRevision(revisionId: RevisionId): Promise<OcrResultRecord | null>;
  save(result: OcrResultRecord): Promise<void>;
}
