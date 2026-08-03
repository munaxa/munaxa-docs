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

/** What a preview worker produced for a revision. */
export const PreviewArtifactKind = {
  PAGE_IMAGE: 'PAGE_IMAGE',
  THUMBNAIL: 'THUMBNAIL',
  PDF: 'PDF',
  TEXT: 'TEXT',
} as const;

export type PreviewArtifactKindKey = (typeof PreviewArtifactKind)[keyof typeof PreviewArtifactKind];
