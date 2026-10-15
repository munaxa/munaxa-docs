import type { DownloadLinkGrant, DownloadLinkSubject } from '../domain/download-link-token';
import type {
  FileObjectId,
  IntegrityStatusKey,
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
  /** What the rolling verifier last found — Phase 18, `17-security-architecture.md` §8. */
  readonly integrityStatus: IntegrityStatusKey;
  readonly integrityCheckedAt: Date | null;
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
  /**
   * Whether any row of this tenant — live or deleted — names this storage key. The orphan sweep
   * keeps every object a row names, whatever state the row is in.
   */
  referencesStorageKey(storageKey: string): Promise<boolean>;
  /**
   * Inserts the blob, and answers whether it was the one to insert it.
   *
   * `false` means another transaction stored this digest first — `uq_file_object_checksum` is one
   * live row per digest per tenant. The conflict is *tolerated* rather than raised, because a unique
   * violation aborts the PostgreSQL transaction and the recovery a caller needs is a read.
   */
  insert(file: NewFileObject): Promise<boolean>;
  /**
   * Writes a verdict onto a blob that has none yet — RC D-3.
   *
   * A compare-and-set: the row moves only while its status is still one of `from`, and the answer
   * says whether this call moved it. Two uploads re-scanning the same unscanned blob at once both
   * scan; one writes, the other reads the row back — so the verdict is never overwritten by a later
   * one, and a blob that already has a verdict is never touched.
   */
  recordScan(
    id: FileObjectId,
    verdict: { status: ScanStatusKey; scanner: string; threat: string | null; at: Date },
    from: readonly ScanStatusKey[],
  ): Promise<boolean>;
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
  /**
   * The integrity sweep's page: least recently verified first, never-verified before everything
   * else — Phase 18.
   *
   * A *page* rather than a cursor the caller keeps, because the ordering column is the one the
   * pass writes: a blob checked in this pass sorts to the end, so the next call naturally returns
   * the next set and the sweep needs no state of its own. That is what makes it resumable after a
   * crash and what makes "every blob is re-read within N days" a property of the schedule rather
   * than of a stored position somebody has to reconcile.
   */
  listForIntegrityCheck(limit: number): Promise<readonly FileObjectRecord[]>;
  recordIntegrity(
    id: FileObjectId,
    finding: { status: IntegrityStatusKey; at: Date },
  ): Promise<void>;
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

export interface IntegritySweepResult {
  readonly checked: number;
  readonly verified: number;
  readonly mismatched: number;
  readonly unreadable: number;
  /** Not read this pass — a store error, a timeout, an unreachable store. Not a finding. */
  readonly inconclusive: number;
  /** Past `STORAGE_INTEGRITY_MAX_BYTES`, so not read. Not a finding. */
  readonly tooLarge: number;
}

/** One area the orphan sweep covers, and what it found there. */
export interface OrphanSweepArea {
  /** Objects listed under the prefix. */
  readonly listed: number;
  /** Named by a row or an open session: kept. */
  readonly referenced: number;
  /** Unreferenced, but younger than the grace: left for a later sweep. */
  readonly recent: number;
  /** Keys this product would not have written there: never touched, only counted. */
  readonly unrecognised: number;
  /** Unreferenced, older than the grace, and still so when re-checked: removed (or, dry, not). */
  readonly orphaned: number;
}

/** One pass of the orphan sweep — ADR-0026 §10, Phase A. Keys only: no credential, no content. */
export interface OrphanSweepResult {
  readonly dryRun: boolean;
  readonly graceSeconds: number;
  readonly staging: OrphanSweepArea;
  readonly blobs: OrphanSweepArea;
  /** The keys found orphaned (removed unless `dryRun`), relative to the tenant's prefix. */
  readonly orphanedKeys: readonly string[];
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

  /**
   * A source's bytes for the API's own processing (rendering, thumbnails, OCR), read whole and
   * returned only when their size and SHA-256 equal the record. Never handed to a person.
   *
   * Refuses as a download is refused (scan, integrity) and above `maxBytes`. A mismatch or an
   * absent object quarantines and throws `ContentQuarantinedError`; a store failure throws
   * `StorageUnavailableError` and changes nothing. Audited as `FILE_DOWNLOAD_ISSUED` with
   * `delivery: 'INTERNAL'`.
   */
  readVerifiedSource(
    fileObjectId: FileObjectId,
    options: { readonly purpose: 'RENDER' | 'THUMBNAIL' | 'OCR'; readonly maxBytes: number },
  ): Promise<Buffer>;

  /**
   * A verified download link — ADR-0026 §10, the download-integrity proposal §3.1.
   *
   * The same refusals as `readVerifiedSource` (scan, integrity), plus the store's HEAD and the size
   * the verified path accepts, and the same `FILE_DOWNLOAD_ISSUED` event. The link names the
   * person in the current context, their permission version, and the document (and revision) it
   * is for, so its redemption can ask every question again. Nothing is signed by the store: the
   * bytes are served by the API, after verification.
   */
  createVerifiedDownloadLink(
    fileObjectId: FileObjectId,
    filename: string,
    options: {
      readonly inline?: boolean;
      /** What the link is for — the kind and its identifiers, re-asked at redemption. */
      readonly subject: DownloadLinkSubject;
      /**
       * The media type to serve, from the object's own record (an export's format, an artefact's
       * type). Omitted only for a document, whose blob is its own. Never taken from a blob several
       * exports may share (E-8).
       */
      readonly mimeType?: string;
      /** Correlation fields recorded on `FILE_DOWNLOAD_ISSUED` (an export or operation id). */
      readonly audit?: Readonly<Record<string, string>>;
    },
  ): Promise<{ url: string; expiresAt: Date }>;

  /** The file, if it may be served now; otherwise the gate's own refusal (404, 409). */
  servable(fileObjectId: FileObjectId): Promise<FileObjectRecord>;

  /**
   * Quarantines a blob on a confirmed finding made outside the verifier — a download that did not
   * verify. The verifier's own path: the row, `INTEGRITY_MISMATCH` and the outbox event together.
   */
  recordIntegrityFinding(
    fileObjectId: FileObjectId,
    status: 'MISMATCH' | 'UNREADABLE',
    actualSha256: string | null,
  ): Promise<void>;

  /** `FILE_DOWNLOAD_SERVED`: every verified byte was handed to the connection. */
  recordDownloadServed(
    fileObjectId: FileObjectId,
    details: {
      readonly sizeBytes: number;
      readonly verifiedAfterMs: number;
      /** The redeemer's correlation fields, so the row names what the bytes were released as. */
      readonly audit?: Readonly<Record<string, string>>;
    },
  ): Promise<void>;

  /**
   * The gate: content is unreachable until its scan verdict is CLEAN (or, for a file the product
   * generated, `SKIPPED` by construction) — and, since Phase 18, only while the rolling verifier
   * has not found its bytes changed or missing. The same predicate the issuing paths refuse on;
   * a door that signs bytes on the raw port asks this first.
   */
  isReachable(fileObjectId: FileObjectId): Promise<boolean>;

  /**
   * One pass of the rolling verifier — `storage.verify-integrity`, Phase 18.
   *
   * Reads a bounded page of blobs back from the store, re-hashes each, and records what it found.
   * A mismatch quarantines the blob, writes `INTEGRITY_MISMATCH` and publishes an event; 17 §9
   * pages on it, because a stored document whose bytes have changed is the failure this product
   * exists to make impossible.
   */
  verifyIntegrity(): Promise<IntegritySweepResult>;
  /**
   * Removes stored objects nothing refers to — staged bytes whose session is no longer open, and
   * content keys no row names — once they are older than STORAGE_ORPHAN_GRACE_SECONDS.
   */
  sweepOrphanedObjects(): Promise<OrphanSweepResult>;

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

  /**
   * Stores an artefact the API produced *and never held whole* — an evidence bundle.
   *
   * The difference from `storeDerived` is the `Buffer`, and it is not cosmetic. A thumbnail is
   * kilobytes and content-addressed, so holding it is free and hashing it first is what names it.
   * A seven-year evidence export is hundreds of megabytes and unique by construction, so holding
   * it would contradict the `audit.export` lane's own description — "streamed to storage rather
   * than held in memory" — and content-addressing it would buy a deduplication that can never hit.
   *
   * The key is therefore supplied by the caller rather than derived from a digest that is not
   * known until the last byte, and the digest is computed on the way past and returned. The row is
   * `derived`, so it is excluded from quota and purged with the export it belongs to, and it is
   * `SKIPPED` by the scanner for the same reason a thumbnail is: the product made it.
   */
  storeStreamed(input: {
    /** The bundle these bytes belong to. Storage derives the key; no caller builds one. */
    bundleId: string;
    /** The artefact's name within the bundle — `events.jsonl`, `manifest.json`. */
    name: string;
    body: AsyncIterable<Uint8Array>;
    mimeType: string;
  }): Promise<FileObjectRecord>;

  /** The prefix a bundle's artefacts live under, for the record that describes it. */
  evidencePrefix(bundleId: string): string;
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

// --- Verified downloads — ADR-0026 §10 ----------------------------------------------------------

export const DOWNLOAD_STAGING = Symbol('DownloadStaging');
export const VERIFIED_DOWNLOAD_DELIVERY = Symbol('VerifiedDownloadDelivery');

/** One download's bytes while they are verified: encrypted, unlinked, gone when disposed. */
export interface StagingFile {
  readonly bytesWritten: number;
  write(chunk: Uint8Array): Promise<void>;
  /** The bytes written, in order; each record's authentication is checked before it is yielded. */
  replay(): AsyncIterable<Buffer>;
  /** Closes the file (freeing it) and overwrites the key. Idempotent. */
  dispose(): Promise<void>;
}

export interface DownloadStaging {
  create(): Promise<StagingFile>;
  /** Free space on the staging file system, for the reserve check. */
  freeBytes(): Promise<number>;
}

/** What `send` receives: bytes whose size and SHA-256 already equal the record. */
export interface VerifiedDownload {
  readonly sizeBytes: number;
  readonly chunks: AsyncIterable<Buffer>;
  /** From the request's admission to the end of verification — the time to first byte, nearly. */
  readonly verifiedAfterMs: number;
}

export {
  DOWNLOAD_LINK_PATH,
  DownloadLinkKind,
  type DownloadLinkGrant,
  type DownloadLinkGrantOf,
  type DownloadLinkKindKey,
  type DownloadLinkSubject,
} from '../domain/download-link-token';
export {
  DOWNLOAD_REDEEMERS,
  type DownloadRedeemer,
  DownloadRedeemerRegistry,
  type RedeemedDownload,
} from './download-redeemers';

export interface VerifiedDownloadDelivery {
  /** The grant a link's token carries, if it is genuine and unexpired. Authorizes nothing. */
  decode(token: string): DownloadLinkGrant | null;

  /**
   * Stages and verifies the blob, then calls `send` — and only then. Throws, having called nothing,
   * when the blob may not be served, did not verify (quarantined), or could not be read now.
   */
  deliver(
    fileObjectId: FileObjectId,
    send: (download: VerifiedDownload) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void>;
}
