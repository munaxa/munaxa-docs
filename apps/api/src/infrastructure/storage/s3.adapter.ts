import { createHash } from 'node:crypto';

import type { StorageDriverKey } from '@edms/domain';

import { StorageUnavailableError } from '../../core/errors/application-errors';
import type {
  BlobMetadata,
  DownloadOptions,
  SignedUrl,
  StorageKey,
  StoragePort,
  UploadPart,
  UploadTarget,
  UploadTargetInput,
} from '../../ports/storage.port';
import {
  EMPTY_PAYLOAD_HASH,
  type SigningCredentials,
  encodePath,
  presignedQueryString,
  signRequest,
} from './sigv4';

/**
 * S3, and everything that speaks S3.
 *
 * One adapter for AWS, MinIO, Cloudflare R2 and any other S3-compatible store, because they differ
 * in three configuration values — endpoint, region, addressing style — and in nothing this class
 * does. `STORAGE_DRIVER=S3` and `STORAGE_DRIVER=R2` therefore select the same code with different
 * settings, which is what "adding a provider is an adapter and a configuration value" was supposed
 * to mean.
 *
 * **Bytes never pass through here.** Upload and download are presigned and go browser-to-store
 * directly (`11-storage-architecture.md` §4). What this class issues is short-lived, single-object,
 * method-bound URLs; what it *calls* S3 for is only the four small control operations — head, copy,
 * delete and the multipart completion — none of which carries a document's content.
 *
 * It knows nothing about tenants. `TenantScopedStorage` wraps it in the composition root and has
 * already put the tenant's prefix on every key by the time anything here runs — so an isolation
 * defect cannot be introduced by this file, and a second object-store adapter written later
 * inherits the same guarantee without implementing it.
 */
export interface S3AdapterOptions {
  readonly driver: StorageDriverKey;
  readonly bucket: string;
  readonly region: string;
  /** Absolute, no trailing slash. AWS's own endpoint when the deployment names none. */
  readonly endpoint: string;
  readonly forcePathStyle: boolean;
  readonly credentials: SigningCredentials;
  readonly now: () => Date;
  /** Injected so a test can assert what was sent without standing up a server. */
  readonly fetch?: typeof globalThis.fetch;
}

/** Above this, an upload is offered as multipart so a large transfer can resume. */
export const MULTIPART_THRESHOLD_BYTES = 64 * 1024 * 1024;
/** S3's own floor for every part but the last; a smaller part size is refused by the service. */
export const MULTIPART_PART_SIZE_BYTES = 16 * 1024 * 1024;

export class S3StorageAdapter implements StoragePort {
  readonly driver: StorageDriverKey;

  private readonly fetch: typeof globalThis.fetch;
  private readonly host: string;
  private readonly origin: string;

  constructor(private readonly options: S3AdapterOptions) {
    this.driver = options.driver;
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    const url = new URL(options.endpoint);
    // Virtual-host addressing puts the bucket in the hostname, which is what AWS and R2 expect;
    // path style puts it in the path, which is what MinIO and most self-hosted stores expect. The
    // signature covers the host and the path, so getting this wrong is a signature failure rather
    // than a silent write to the wrong place — but it is still configuration, not a code branch.
    this.host = options.forcePathStyle ? url.host : `${options.bucket}.${url.host}`;
    this.origin = `${url.protocol}//${this.host}`;
  }

  async createUploadTarget(input: UploadTargetInput): Promise<UploadTarget> {
    const at = this.options.now();
    const expiresAt = new Date(at.getTime() + input.expiresInSeconds * 1000);

    // The size and the content type are *signed*, so the URL is only usable for the file the
    // policy approved. A target issued for a 40 kB PDF cannot be redeemed for a 2 GB executable
    // — the store recomputes the signature over the headers the client actually sent.
    const signedHeaders: Record<string, string> = {
      'content-type': input.contentType,
      'content-length': String(input.sizeBytes),
    };

    if (input.multipart === true) {
      const uploadId = await this.beginMultipart(input.key, input.contentType);
      const partCount = Math.max(1, Math.ceil(input.sizeBytes / MULTIPART_PART_SIZE_BYTES));
      return {
        key: input.key,
        // The completion is the API's call, not the browser's, so the target's own URL is the
        // first part's. A client that only ever PUTs to the part URLs never has to know that a
        // multipart upload has a shape at all.
        url: this.partUrl(input.key, uploadId, 1, at, input.expiresInSeconds),
        method: 'PUT',
        headers: { 'Content-Type': input.contentType },
        expiresAt,
        parts: Array.from({ length: partCount }, (_unused, index) => ({
          partNumber: index + 1,
          url: this.partUrl(input.key, uploadId, index + 1, at, input.expiresInSeconds),
          // Carried back at completion; see `completeUpload`.
          uploadId,
        })),
      };
    }

    const query = presignedQueryString({
      credentials: this.options.credentials,
      region: this.options.region,
      service: 's3',
      at,
      method: 'PUT',
      host: this.host,
      path: this.pathFor(input.key),
      expiresInSeconds: input.expiresInSeconds,
      signedHeaders,
    });
    return {
      key: input.key,
      url: `${this.origin}${this.pathFor(input.key)}?${query}`,
      method: 'PUT',
      headers: { 'Content-Type': input.contentType, 'Content-Length': String(input.sizeBytes) },
      expiresAt,
    };
  }

  /**
   * Finishes the transfer and answers with what is *actually* stored.
   *
   * For a single PUT there is nothing to complete, so this is a HEAD — and that is the point
   * rather than a shortcut. The size and digest a client claimed at the start are a claim; the ones
   * the store reports are the fact, and the use case compares them. An upload that completed with
   * different bytes than it announced fails here rather than becoming a document.
   */
  async completeUpload(key: StorageKey, parts: readonly UploadPart[]): Promise<BlobMetadata> {
    const uploadId = parts.find((part) => part.uploadId !== undefined)?.uploadId;
    if (uploadId !== undefined) {
      await this.finishMultipart(key, uploadId, parts);
    }
    const metadata = await this.head(key);
    if (metadata === null) {
      throw new StorageUnavailableError(
        'The upload completed but the object is not there. Nothing was recorded.',
      );
    }
    return metadata;
  }

  createDownloadUrl(key: StorageKey, options: DownloadOptions): Promise<SignedUrl> {
    const at = this.options.now();
    const query: Record<string, string> = {};
    if (options.filename !== undefined) {
      // Set through the query rather than as a signed request header, because the browser is not
      // going to send it — it is the *response* header the store should emit, and only the store
      // can attach it to bytes it serves.
      query['response-content-disposition'] =
        `${options.inline === true ? 'inline' : 'attachment'}; filename="${options.filename}"`;
    }
    const signed = presignedQueryString({
      credentials: this.options.credentials,
      region: this.options.region,
      service: 's3',
      at,
      method: 'GET',
      host: this.host,
      path: this.pathFor(key),
      query,
      expiresInSeconds: options.expiresInSeconds,
    });
    return Promise.resolve({
      url: `${this.origin}${this.pathFor(key)}?${signed}`,
      expiresAt: new Date(at.getTime() + options.expiresInSeconds * 1000),
    });
  }

  async head(key: StorageKey): Promise<BlobMetadata | null> {
    const response = await this.send('HEAD', key);
    if (response.status === 404) {
      // A real answer — "no such object" — rather than a failure. The sweeper that looks for
      // orphaned upload sessions asks this question about keys it expects to be absent.
      return null;
    }
    this.refuseFailure(response, 'read');

    const size = Number(response.headers.get('content-length') ?? '0');
    return {
      key,
      sizeBytes: Number.isFinite(size) ? size : 0,
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
      checksumSha256: decodeChecksum(response.headers.get('x-amz-checksum-sha256')),
      lastModifiedAt: new Date(response.headers.get('last-modified') ?? this.options.now()),
    };
  }

  async copy(from: StorageKey, to: StorageKey): Promise<void> {
    // Server-side: the bytes never leave the store, so copying a 2 GB drawing costs the API
    // nothing but the round trip. The source is given as a bucket-qualified path because that is
    // the only form `x-amz-copy-source` accepts, whatever the addressing style.
    const response = await this.send('PUT', to, {
      'x-amz-copy-source': `/${this.options.bucket}${encodePath(from)}`,
    });
    this.refuseFailure(response, 'copy');
  }

  async delete(key: StorageKey): Promise<void> {
    const response = await this.send('DELETE', key);
    if (response.status === 404) {
      // Already gone. Retention deletes at a reference count of zero and retries after a failure,
      // so a second attempt meeting an absent object has achieved what it was asked to.
      return;
    }
    this.refuseFailure(response, 'delete');
  }

  // --- Internals ---------------------------------------------------------------------------

  private pathFor(key: StorageKey): string {
    return this.options.forcePathStyle
      ? `/${this.options.bucket}${encodePath(key)}`
      : encodePath(key);
  }

  private partUrl(
    key: StorageKey,
    uploadId: string,
    partNumber: number,
    at: Date,
    expiresInSeconds: number,
  ): string {
    const query = presignedQueryString({
      credentials: this.options.credentials,
      region: this.options.region,
      service: 's3',
      at,
      method: 'PUT',
      host: this.host,
      path: this.pathFor(key),
      query: { partNumber: String(partNumber), uploadId },
      expiresInSeconds,
    });
    return `${this.origin}${this.pathFor(key)}?${query}`;
  }

  private async beginMultipart(key: StorageKey, contentType: string): Promise<string> {
    const response = await this.send('POST', key, { 'content-type': contentType }, { uploads: '' });
    this.refuseFailure(response, 'start');
    const uploadId = elementText(await response.text(), 'UploadId');
    if (uploadId === null) {
      throw new StorageUnavailableError('Object storage did not return an upload identifier.');
    }
    return uploadId;
  }

  private async finishMultipart(
    key: StorageKey,
    uploadId: string,
    parts: readonly UploadPart[],
  ): Promise<void> {
    // The entity tags come from the client, which received them on each part's response. They are
    // opaque here: the completion is a list of (part number, tag) pairs the store checks for
    // itself, and a wrong one fails the completion rather than assembling the wrong object.
    const body =
      '<CompleteMultipartUpload>' +
      [...parts]
        .filter((part) => part.etag !== undefined)
        .sort((left, right) => left.partNumber - right.partNumber)
        .map(
          (part) =>
            `<Part><PartNumber>${String(part.partNumber)}</PartNumber><ETag>${part.etag ?? ''}</ETag></Part>`,
        )
        .join('') +
      '</CompleteMultipartUpload>';

    const response = await this.send(
      'POST',
      key,
      { 'content-type': 'application/xml' },
      { uploadId },
      body,
    );
    this.refuseFailure(response, 'complete');
    // S3 answers 200 for a *failed* completion with an error document in the body, which is the
    // one place in the protocol where the status line lies. Checking the body is not belt and
    // braces; it is the only way to know.
    if ((await response.text()).includes('<Error>')) {
      throw new StorageUnavailableError('Object storage refused to complete the upload.');
    }
  }

  private async send(
    method: string,
    key: StorageKey,
    extraHeaders: Readonly<Record<string, string>> = {},
    query: Readonly<Record<string, string>> = {},
    body?: string,
  ): Promise<Response> {
    const payloadHash =
      body === undefined ? EMPTY_PAYLOAD_HASH : createHash('sha256').update(body).digest('hex');
    const path = this.pathFor(key);
    const headers = signRequest({
      credentials: this.options.credentials,
      region: this.options.region,
      service: 's3',
      at: this.options.now(),
      method,
      host: this.host,
      path,
      query,
      headers: extraHeaders,
      payloadHash,
    });
    const search = new URLSearchParams(query).toString();
    try {
      return await this.fetch(`${this.origin}${path}${search ? `?${search}` : ''}`, {
        method,
        headers: { ...headers },
        ...(body !== undefined && { body }),
      });
    } catch (cause) {
      // A store that cannot be reached is a 503 with a retry hint, never a 500 that reads as a
      // defect in this product (`11-storage-architecture.md` §8).
      throw new StorageUnavailableError('Object storage could not be reached.', { cause });
    }
  }

  private refuseFailure(response: Response, operation: string): void {
    if (!response.ok) {
      // The status is carried and the body is not: an S3 error document quotes the request,
      // including the signed URL that produced it, and putting that in an exception message is how
      // a credential-shaped string reaches a log.
      throw new StorageUnavailableError(
        `Object storage refused to ${operation} the object (HTTP ${String(response.status)}).`,
      );
    }
  }
}

/** The one XML element this adapter reads. A parser dependency for a single tag is not worth it. */
function elementText(xml: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
  return match?.[1] ?? null;
}

/**
 * S3 reports a checksum base64-encoded; everything in this product stores it as hex.
 *
 * Returns null rather than a wrong value for anything unexpected. A checksum is compared against
 * the one the API computed, and a mistranslated digest would fail that comparison and quarantine a
 * perfectly good file — so "no answer" is the safer wrong answer of the two.
 */
function decodeChecksum(header: string | null): string | null {
  if (header === null || header.length === 0) {
    return null;
  }
  const decoded = Buffer.from(header, 'base64');
  return decoded.length === 32 ? decoded.toString('hex') : null;
}
