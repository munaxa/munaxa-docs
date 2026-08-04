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
  readonly scanThreat: string | null;
  readonly refCount: number;
  readonly derived: boolean;
  readonly createdAt: Date;
  readonly createdBy: string | null;
}

export interface NewFileObject {
  readonly id: string;
  readonly checksumSha256: string;
  readonly sizeBytes: number;
  readonly mimeType: string;
  readonly storageKey: string;
  readonly storageDriver: string;
  readonly scanStatus: ScanStatusKey;
  readonly scanner: string | null;
  readonly scanThreat: string | null;
  readonly derived: boolean;
}

export interface FileObjectRepository {
  findById(id: FileObjectId): Promise<FileObjectRecord | null>;
  /** Dedupe: an identical checksum within the tenant is the same blob. */
  findByChecksum(checksum: string): Promise<FileObjectRecord | null>;
  insert(file: NewFileObject): Promise<void>;
  recordScan(
    id: FileObjectId,
    verdict: { status: ScanStatusKey; scanner: string; threat: string | null; at: Date },
  ): Promise<void>;
  /**
   * Moves the reference count by `by`, and answers with the new value.
   *
   * One statement rather than read-modify-write, because two revisions attaching the same blob in
   * two transactions would otherwise each write `1` and the blob would be deleted at the first
   * detachment while a document still pointed at it. A check constraint refuses a negative result,
   * so drift is a failed statement rather than a missing file.
   */
  adjustRefCount(id: FileObjectId, by: number): Promise<number>;
  /** Only retention calls this, and only at a reference count of zero. */
  listUnreferenced(limit: number): Promise<readonly FileObjectRecord[]>;
}

export interface UploadSessionRecord {
  readonly id: UploadSessionId;
  readonly filename: string;
  readonly declaredMimeType: string;
  readonly declaredSizeBytes: number;
  readonly targetKey: string;
  readonly state: UploadSessionStateKey;
  readonly multipartUploadId: string | null;
  readonly fileObjectId: string | null;
  readonly expiresAt: Date;
  readonly createdBy: string | null;
}

export interface UploadSessionRepository {
  findById(id: UploadSessionId): Promise<UploadSessionRecord | null>;
  insert(session: {
    id: string;
    filename: string;
    declaredMimeType: string;
    declaredSizeBytes: number;
    targetKey: string;
    multipartUploadId: string | null;
    expiresAt: Date;
  }): Promise<void>;
  /**
   * Moves a session out of `OPEN`, and answers whether it was the one to do so.
   *
   * False means somebody else already completed or abandoned it. That matters because completion
   * is the step that creates a blob and bumps a reference count, and a client retrying a request
   * whose response it never saw must not do either of those twice.
   */
  settle(
    id: UploadSessionId,
    state: UploadSessionStateKey,
    fileObjectId: string | null,
  ): Promise<boolean>;
  /** Expired sessions are swept; a completed session can never be reused. */
  expireOlderThan(cutoff: Date): Promise<number>;
}

export const STORAGE_SERVICE = Symbol('StorageService');

/**
 * What other modules call.
 *
 * Note what is absent: **no method returns bytes.** Upload and download are presigned and direct
 * to storage, and the API only issues short-lived, permission-checked, single-object URLs
 * (`docs/architecture/00-system-architecture.md` §3).
 *
 * `reference` and `dereference` are the seam between this module and the ones that hold documents.
 * Storage owns the count because storage owns the blob; the modules that create and remove
 * references say so, inside the transaction that creates or removes them, and neither reaches into
 * this module's tables to do it.
 */
export interface StorageService {
  createUploadSession(input: {
    filename: string;
    mimeType: string;
    sizeBytes: number;
    /** The leading bytes, for content sniffing. Sent by the client; never the whole file. */
    magicBytes: Uint8Array;
    checksumSha256?: string | undefined;
  }): Promise<IssuedUploadTarget>;

  completeUploadSession(
    id: UploadSessionId,
    parts: readonly { partNumber: number; etag: string }[],
  ): Promise<CompletedUpload>;

  abandonUploadSession(id: UploadSessionId): Promise<void>;

  createDownloadUrl(
    fileObjectId: FileObjectId,
    filename: string,
    options?: { inline?: boolean },
  ): Promise<{ url: string; expiresAt: Date }>;

  /** The gate: content is unreachable until its scan verdict is CLEAN. */
  isReachable(fileObjectId: FileObjectId): Promise<boolean>;

  get(fileObjectId: FileObjectId): Promise<FileObjectRecord | null>;

  /** Records a reference from another module's row. Joins the caller's transaction. */
  reference(fileObjectId: FileObjectId): Promise<void>;
  dereference(fileObjectId: FileObjectId): Promise<void>;

  /**
   * Stores bytes the API itself produced — a thumbnail, later a rendition.
   *
   * The one place bytes pass through the process, and it is deliberate: a derived artefact is made
   * *here*, so there is no client to presign a target for. It is marked `derived`, which excludes
   * it from quota and purges it with its source.
   */
  storeDerived(input: { content: Buffer; mimeType: string }): Promise<FileObjectRecord>;
}

export interface IssuedUploadTarget {
  readonly uploadSessionId: string;
  readonly url: string;
  readonly method: 'PUT' | 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: Date;
  readonly parts: readonly { partNumber: number; url: string }[] | null;
  /**
   * Set when the tenant already holds these bytes.
   *
   * The client is told so and skips the transfer entirely: content addressing means the blob it
   * was about to upload is already there, byte for byte. It is also what makes duplicate detection
   * free — the document use case gets the existing blob's identity and can say which documents
   * already reference it.
   */
  readonly alreadyStored: { readonly fileObjectId: string } | null;
}

export interface CompletedUpload {
  readonly fileObjectId: string;
  readonly checksumSha256: string;
  readonly sizeBytes: number;
  readonly mimeType: string;
  readonly scanStatus: ScanStatusKey;
  /** True when completion found the digest already stored and referenced that blob instead. */
  readonly deduplicated: boolean;
}
