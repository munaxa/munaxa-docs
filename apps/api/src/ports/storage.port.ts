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
  /**
   * Where a client PUTs this part.
   *
   * Optional because Phase 9 added a second producer of these: a server-driven streaming write
   * sends each part itself and has no URL to hand anybody. A client never sees one of those, so
   * the field is present for every part that reaches a browser and absent for every part that
   * does not.
   */
  readonly url?: string;
  /**
   * The driver's handle for the multipart upload, carried back at completion.
   *
   * Opaque above the adapter — S3 calls it an upload id, another provider may not have one at all
   * — which is why it is a string on the part rather than a field on `UploadTarget`: a driver with
   * no notion of a multipart session simply never sets it, and `completeUpload` sees a single-part
   * transfer.
   */
  readonly uploadId?: string;
  /**
   * The entity tag the store returned for this part, supplied by the client at completion.
   *
   * The API never sees the bytes, so it cannot compute these. The store checks them itself, and a
   * wrong one fails the completion rather than assembling an object out of the wrong pieces.
   */
  readonly etag?: string;
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

  /**
   * Writes bytes the API produced itself, streaming, without ever holding them whole.
   *
   * The three methods below are the server-side half of this port, and they are deliberately
   * separate from the presigned handshake above. That handshake exists so a *client's* bytes never
   * pass through the API; these exist for bytes that have no client — an evidence bundle assembled
   * from the trail, a signed checkpoint. There is no browser to presign a target for something the
   * server made.
   *
   * `put` streams because Phase 9's first caller cannot do otherwise: the `audit.export` lane's own
   * description is "evidence bundles, streamed to storage rather than held in memory", and a
   * seven-year range is hundreds of megabytes of JSONL. `storeDerived` takes a `Buffer` and is
   * correct for a thumbnail; it contradicts that lane's description for a bundle, which is why this
   * arrived rather than being worked around.
   *
   * Memory is bounded at one part — `STORAGE_STREAM_PART_BYTES` — whatever the artefact's size.
   */
  put(
    key: StorageKey,
    body: AsyncIterable<Uint8Array>,
    options: { readonly contentType: string },
  ): Promise<BlobMetadata>;

  /**
   * Reads a small object the API wrote itself, whole.
   *
   * For a checkpoint, which is a few hundred bytes of signed JSON. Never for a document: nothing
   * calls this with a key the product did not construct for its own metadata, and the size bound is
   * the caller's to respect, since no object store enforces one on a `GET`.
   */
  read(key: StorageKey): Promise<Buffer | null>;

  /**
   * Every key under a prefix.
   *
   * The checkpoint store's index. Prefix listing is the one operation every provider offers with
   * the same semantics, which is why checkpoints are keyed so that lexicographic order *is*
   * chronological order — the listing needs no sort key the store does not have.
   */
  list(prefix: string): Promise<readonly StorageKey[]>;
}
