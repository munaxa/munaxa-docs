import type {
  FileObjectId,
  ScanStatusKey,
  UploadSessionId,
  UploadSessionStateKey,
} from '@edms/domain';

/**
 * Stored bytes.
 *
 * A `FileObject` is immutable after creation, identified by its SHA-256, and shared by
 * reference: the same checksum within a tenant is one stored blob with a reference count.
 * Unscanned blobs are unreachable (`docs/architecture/11-storage-architecture.md`).
 */
export const FILE_OBJECT_REPOSITORY = Symbol('FileObjectRepository');
export const UPLOAD_SESSION_REPOSITORY = Symbol('UploadSessionRepository');

export interface FileObjectRecord {
  readonly id: FileObjectId;
  readonly checksumSha256: string;
  readonly sizeBytes: number;
  readonly mimeType: string;
  readonly storageKey: string;
  readonly storageDriver: string;
  readonly scanStatus: ScanStatusKey;
  readonly refCount: number;
}

export interface FileObjectRepository {
  findById(id: FileObjectId): Promise<FileObjectRecord | null>;
  /** Dedupe: an identical checksum within the tenant is the same blob. */
  findByChecksum(checksum: string): Promise<FileObjectRecord | null>;
  save(file: FileObjectRecord): Promise<void>;
  incrementRefCount(id: FileObjectId, by: number): Promise<number>;
  /** Only retention calls this, and only at a reference count of zero. */
  listUnreferenced(limit: number): Promise<readonly FileObjectRecord[]>;
}

export interface UploadSessionRecord {
  readonly id: UploadSessionId;
  readonly targetKey: string;
  readonly state: UploadSessionStateKey;
  readonly expiresAt: Date;
}

export interface UploadSessionRepository {
  findById(id: UploadSessionId): Promise<UploadSessionRecord | null>;
  save(session: UploadSessionRecord): Promise<void>;
  /** Expired sessions are swept; a completed session can never be reused. */
  expireOlderThan(cutoff: Date): Promise<number>;
}

export const STORAGE_SERVICE = Symbol('StorageService');

/**
 * What other modules call. Note what is absent: no method returns bytes. Upload and download
 * are presigned and direct to storage, and the API only issues short-lived, permission-checked,
 * single-object URLs (`docs/architecture/00-system-architecture.md` §3).
 */
export interface StorageService {
  createUploadSession(input: {
    filename: string;
    mimeType: string;
    sizeBytes: number;
  }): Promise<UploadSessionRecord>;
  completeUploadSession(id: UploadSessionId): Promise<FileObjectRecord>;
  createDownloadUrl(
    fileObjectId: FileObjectId,
    filename: string,
  ): Promise<{ url: string; expiresAt: Date }>;
  /** The gate: content is unreachable until its scan verdict is CLEAN. */
  isReachable(fileObjectId: FileObjectId): Promise<boolean>;
}
