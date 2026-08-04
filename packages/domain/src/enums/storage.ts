/** Storage and upload vocabulary (`docs/architecture/11-storage-architecture.md`). */
export const StorageDriver = {
  LOCAL: 'LOCAL',
  S3: 'S3',
  AZURE_BLOB: 'AZURE_BLOB',
  R2: 'R2',
  GCS: 'GCS',
} as const;

export type StorageDriverKey = (typeof StorageDriver)[keyof typeof StorageDriver];

/**
 * A blob is unreachable until it is CLEAN. The gate is enforced in the use case and by a
 * database check constraint, in every environment that holds real data.
 */
export const ScanStatus = {
  PENDING: 'PENDING',
  CLEAN: 'CLEAN',
  INFECTED: 'INFECTED',
  FAILED: 'FAILED',
  SKIPPED: 'SKIPPED',
} as const;

export type ScanStatusKey = (typeof ScanStatus)[keyof typeof ScanStatus];

export const UploadSessionState = {
  OPEN: 'OPEN',
  COMPLETED: 'COMPLETED',
  EXPIRED: 'EXPIRED',
  ABORTED: 'ABORTED',
} as const;

export type UploadSessionStateKey = (typeof UploadSessionState)[keyof typeof UploadSessionState];

/**
 * What a preview worker produced for a revision.
 *
 * `TEXT` is what a renderer extracted from the file's own text layer; `OCR` is what an engine
 * read off the pixels when no usable text layer existed. Two kinds rather than a flag, because
 * they answer differently: extracted text is the file's own words, OCR output is an inference
 * with a confidence, flagged in the UI rather than presented as authoritative
 * (`docs/architecture/14-preview-architecture.md` §6).
 */
export const PreviewArtifactKind = {
  PAGE_IMAGE: 'PAGE_IMAGE',
  THUMBNAIL: 'THUMBNAIL',
  PDF: 'PDF',
  TEXT: 'TEXT',
  OCR: 'OCR',
} as const;

export type PreviewArtifactKindKey = (typeof PreviewArtifactKind)[keyof typeof PreviewArtifactKind];

/**
 * Where rendering stands for a revision — the row behind "202 with status" and behind the
 * operator's view of a failure (`docs/architecture/14-preview-architecture.md` §§4, 7).
 *
 * `UNSUPPORTED` is a terminal answer, not a failure: the format has no renderer, the UI says so
 * and offers download where permitted. `FAILED` is retried by the queue until its attempts are
 * spent; what remains here afterwards is the reason an administrator reads.
 */
export const PreviewRenderState = {
  PENDING: 'PENDING',
  READY: 'READY',
  FAILED: 'FAILED',
  UNSUPPORTED: 'UNSUPPORTED',
} as const;

export type PreviewRenderStateKey = (typeof PreviewRenderState)[keyof typeof PreviewRenderState];
