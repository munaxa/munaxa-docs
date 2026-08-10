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
  /**
   * How much of a streamed write is held before a part is sent.
   *
   * Deployment-tunable rather than fixed, because it is the only memory a server-produced
   * artefact of any size costs, and the right number depends on how many exports a deployment
   * runs at once — not on anything this adapter knows.
   */
  readonly streamPartBytes?: number;
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
      // **The digest, signed** — Phase 6.12, and the field this adapter had been handed since Phase
      // 3 and never read.
      //
      // `UploadTargetInput.checksumSha256` has always carried the digest the product approved, and
      // `StorageService.createUploadSession` has always passed it. This adapter dropped it, so the
      // object was written with no checksum, `head()` read `x-amz-checksum-sha256` back as absent,
      // and `completeUploadSession` refused every upload with *"Storage could not confirm the
      // file's digest."* — on **every S3 and R2 deployment**, since the adapter was written. The
      // `LOCAL` adapter hashes the bytes itself, which is why a single-server install never saw it.
      //
      // Signing it does more than make `head()` answer. S3 and every compatible store **verify**
      // `x-amz-checksum-sha256` against the bytes they receive and reject the PUT on a mismatch, so
      // the digest stops being a claim the client made and becomes a condition of the write. And
      // because it is in the *signature*, a client cannot substitute one: changing the header
      // invalidates the URL.
      //
      // That is what keeps ADR-0007 intact rather than bent. Its §6 says bytes never pass through
      // the API, so the product cannot hash the object itself; §2 makes the key the digest, so a
      // wrong digest is a wrong key. The store enforcing the digest at write time is the only
      // arrangement that satisfies both — and it attests the bytes rather than the store's opinion
      // of them, which is the distinction `write()`'s own comment draws.
      ...(input.checksumSha256 !== undefined && {
        'x-amz-checksum-sha256': base64Digest(input.checksumSha256),
      }),
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
      // Every signed header is returned, because the client has to send exactly these: a presigned
      // URL is a signature *over* them, so one omitted or altered header is a `403` from the store.
      headers: {
        'Content-Type': input.contentType,
        'Content-Length': String(input.sizeBytes),
        ...(input.checksumSha256 !== undefined && {
          'x-amz-checksum-sha256': base64Digest(input.checksumSha256),
        }),
      },
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
    // `x-amz-checksum-mode: ENABLED` — Phase 6.12, and the other half of the same defect.
    //
    // S3 stores a checksum when one is supplied and then **withholds it from HEAD and GET unless
    // asked for**. Without this header the response carries no `x-amz-checksum-sha256` even for an
    // object that has one, so `decodeChecksum` reads null and `completeUploadSession` refuses a
    // perfectly good upload. Signing the digest into the presigned PUT was necessary and not
    // sufficient: the write had to record it *and* the read had to request it.
    const response = await this.send('HEAD', key, { 'x-amz-checksum-mode': 'ENABLED' });
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

  /**
   * A streamed write, as a multipart upload the API drives itself.
   *
   * This is the one place bytes the *product* made pass through the process, and they pass through
   * a part at a time: the iterable is accumulated to `streamPartBytes`, that part is sent, and the
   * buffer is released. Memory is one part regardless of the artefact's size, which is what the
   * `audit.export` lane means by "streamed to storage rather than held in memory".
   *
   * Multipart even for a small object, deliberately. A single `PUT` would need the length in
   * advance to sign, and an evidence bundle's length is not known until it has been produced —
   * so a size-conditional branch here would be a second code path exercised only by the small
   * case, which is the case that never fails. One path, always taken.
   *
   * An interrupted upload leaves parts the bucket's own lifecycle rule expires; the object itself
   * never appears, because it only exists once the completion is accepted. That is the same
   * property the filesystem adapter gets from writing to a `.partial` name.
   */
  async put(
    key: StorageKey,
    body: AsyncIterable<Uint8Array>,
    options: { readonly contentType: string },
  ): Promise<BlobMetadata> {
    const partSize = this.options.streamPartBytes ?? MULTIPART_PART_SIZE_BYTES;
    const uploadId = await this.beginMultipart(key, options.contentType);
    const hash = createHash('sha256');
    const parts: UploadPart[] = [];
    let pending: Uint8Array[] = [];
    let pendingBytes = 0;
    let sizeBytes = 0;

    const sendPart = async (): Promise<void> => {
      const part = Buffer.concat(pending, pendingBytes);
      pending = [];
      pendingBytes = 0;
      parts.push({
        partNumber: parts.length + 1,
        uploadId,
        etag: await this.uploadPart(key, uploadId, parts.length + 1, part),
      });
    };

    try {
      for await (const chunk of body) {
        hash.update(chunk);
        sizeBytes += chunk.byteLength;
        pending.push(chunk);
        pendingBytes += chunk.byteLength;
        if (pendingBytes >= partSize) {
          await sendPart();
        }
      }
      // The last part, and the only one allowed below the store's minimum. An empty artefact
      // still gets one, because a multipart upload with no parts is refused.
      if (pendingBytes > 0 || parts.length === 0) {
        await sendPart();
      }
      await this.finishMultipart(key, uploadId, parts);
    } catch (cause) {
      await this.abortMultipart(key, uploadId);
      throw cause instanceof StorageUnavailableError
        ? cause
        : new StorageUnavailableError('The artefact could not be written.', { cause });
    }

    return {
      key,
      sizeBytes,
      contentType: options.contentType,
      // The digest computed on the way past, not read back from the store: asking the store what
      // it holds and then attesting that answer would attest the store rather than the bytes.
      checksumSha256: hash.digest('hex'),
      lastModifiedAt: this.options.now(),
    };
  }

  async read(key: StorageKey): Promise<Buffer | null> {
    const response = await this.send('GET', key);
    if (response.status === 404) {
      return null;
    }
    this.refuseFailure(response, 'read');
    return Buffer.from(await response.arrayBuffer());
  }

  /** Every key under a prefix, following the store's continuation token to the end. */
  async list(prefix: string): Promise<readonly StorageKey[]> {
    const keys: StorageKey[] = [];
    let token: string | undefined;

    do {
      const response = await this.sendToBucket({
        'list-type': '2',
        prefix,
        ...(token === undefined ? {} : { 'continuation-token': token }),
      });
      this.refuseFailure(response, 'list');
      const xml = await response.text();
      for (const match of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) {
        const key = match[1];
        if (key !== undefined) {
          keys.push(decodeXmlText(key));
        }
      }
      token =
        elementText(xml, 'IsTruncated') === 'true'
          ? (elementText(xml, 'NextContinuationToken') ?? undefined)
          : undefined;
    } while (token !== undefined);

    return keys.sort();
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

  /** One part of a server-driven multipart upload. Returns the entity tag the store answered. */
  private async uploadPart(
    key: StorageKey,
    uploadId: string,
    partNumber: number,
    part: Buffer,
  ): Promise<string> {
    const response = await this.send(
      'PUT',
      key,
      {},
      { partNumber: String(partNumber), uploadId },
      part,
    );
    this.refuseFailure(response, 'write');
    const etag = response.headers.get('etag');
    if (etag === null) {
      throw new StorageUnavailableError('Object storage did not acknowledge a part.');
    }
    return etag;
  }

  /**
   * Abandons a multipart upload whose stream failed.
   *
   * Failures here are swallowed: the caller is already throwing about something that matters
   * more, and a bucket lifecycle rule expires abandoned parts anyway. Replacing a real error with
   * "and the cleanup also failed" would lose the diagnosis.
   */
  private async abortMultipart(key: StorageKey, uploadId: string): Promise<void> {
    try {
      await this.send('DELETE', key, {}, { uploadId });
    } catch {
      // Deliberately ignored — see above.
    }
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
    body?: string | Buffer,
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
        ...(body !== undefined && {
          body: typeof body === 'string' ? body : new Uint8Array(body),
        }),
      });
    } catch (cause) {
      // A store that cannot be reached is a 503 with a retry hint, never a 500 that reads as a
      // defect in this product (`11-storage-architecture.md` §8).
      throw new StorageUnavailableError('Object storage could not be reached.', { cause });
    }
  }

  /**
   * A request against the bucket rather than an object — the listing, and only the listing.
   *
   * Separate from `send` because `pathFor` always names a key, and the bucket's own path differs
   * between the two addressing styles: `/bucket` under path style and `/` under virtual host.
   * Folding that into the key-signing helper would put a "when the key is empty" branch in the
   * one method every object operation goes through.
   */
  private async sendToBucket(query: Readonly<Record<string, string>>): Promise<Response> {
    const path = this.options.forcePathStyle ? `/${this.options.bucket}` : '/';
    const headers = signRequest({
      credentials: this.options.credentials,
      region: this.options.region,
      service: 's3',
      at: this.options.now(),
      method: 'GET',
      host: this.host,
      path,
      query,
      headers: {},
      payloadHash: EMPTY_PAYLOAD_HASH,
    });
    try {
      return await this.fetch(`${this.origin}${path}?${new URLSearchParams(query).toString()}`, {
        method: 'GET',
        headers: { ...headers },
      });
    } catch (cause) {
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

/**
 * The five XML entities a listing can contain.
 *
 * A key legitimately holds `&` — a document title never reaches a key, but a tenant prefix could
 * — and a listing that returned `&amp;` in a key would address an object that does not exist.
 */
function decodeXmlText(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

/** The XML elements this adapter reads. A parser dependency for a handful of tags is not worth it. */
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

/**
 * The other direction — Phase 6.12, and the exact inverse of `decodeChecksum` above.
 *
 * Everything in this product holds a digest as hex; S3 expects `x-amz-checksum-sha256` base64. The
 * two functions sit together so the pair cannot drift, and this one **throws** where its sibling
 * returns null: a digest that is not 32 bytes of hex is a programming error on the way *out*, and
 * signing a malformed one would produce a URL every client is refused with, which is a far worse
 * failure than refusing to issue it.
 */
function base64Digest(hex: string): string {
  const bytes = Buffer.from(hex, 'hex');
  if (bytes.length !== 32 || bytes.toString('hex') !== hex.toLowerCase()) {
    throw new Error('An upload digest must be 32 bytes of hex.');
  }
  return bytes.toString('base64');
}
