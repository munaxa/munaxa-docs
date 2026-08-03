import type { StorageDriverKey } from '@edms/domain';

/**
 * Blob storage, in the application's language.
 *
 * Bytes never pass through the API: it issues short-lived, permission-checked, single-object
 * URLs and records the transfer (`docs/architecture/11-storage-architecture.md`). Nothing in
 * this signature names a bucket, a container or an SDK — swapping S3 for Azure Blob is an
 * adapter and a configuration value, not a use-case change.
 */
export const STORAGE_PORT = Symbol('StoragePort');

/** An opaque, driver-independent location. Adapters map it onto their own addressing. */
export type StorageKey = string;

export interface UploadTargetInput {
  readonly key: StorageKey;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly checksumSha256?: string;
  readonly expiresInSeconds: number;
  /** Above the driver's threshold the target is multipart, so a large upload can resume. */
  readonly multipart?: boolean;
}

export interface UploadTarget {
  readonly key: StorageKey;
  readonly url: string;
  readonly method: 'PUT' | 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: Date;
  readonly parts?: readonly UploadPart[];
}

export interface UploadPart {
  readonly partNumber: number;
  readonly url: string;
}

export interface DownloadOptions {
  readonly expiresInSeconds: number;
  /** Sent as `Content-Disposition`; already sanitised by the use case. */
  readonly filename?: string;
  readonly inline?: boolean;
}

export interface SignedUrl {
  readonly url: string;
  readonly expiresAt: Date;
}

export interface BlobMetadata {
  readonly key: StorageKey;
  readonly sizeBytes: number;
  readonly contentType: string;
  readonly checksumSha256: string | null;
  readonly lastModifiedAt: Date;
}

export interface StoragePort {
  readonly driver: StorageDriverKey;
  createUploadTarget(input: UploadTargetInput): Promise<UploadTarget>;
  completeUpload(key: StorageKey, parts: readonly UploadPart[]): Promise<BlobMetadata>;
  createDownloadUrl(key: StorageKey, options: DownloadOptions): Promise<SignedUrl>;
  head(key: StorageKey): Promise<BlobMetadata | null>;
  copy(from: StorageKey, to: StorageKey): Promise<void>;
  /** Only ever called by retention, for a blob whose reference count has reached zero. */
  delete(key: StorageKey): Promise<void>;
}
