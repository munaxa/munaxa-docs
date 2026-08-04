import { createHash } from 'node:crypto';
import { copyFile, mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

import type { StorageDriverKey } from '@edms/domain';

import { ForbiddenError, StorageUnavailableError } from '../../core/errors/application-errors';
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
import { type TransferGrant, encodeTransferToken } from './local-transfer-token';

/**
 * The filesystem, for an installation that runs on one server.
 *
 * It exists because that installation is real: a single-node on-premise deployment has no object
 * store and does not want one, and telling such a customer to run MinIO beside the product is
 * telling them to operate a second piece of infrastructure to store files on the disk they already
 * have. `DEPLOYMENT_PROFILE=CLOUD` refuses this driver at boot for the matching reason — a
 * filesystem is not shared between instances, so a document uploaded through one would be missing
 * from the next.
 *
 * **Transfers still do not pass through the application's request handling.** They pass through
 * two dedicated endpoints that do nothing but stream, authorised by a signed capability rather than
 * by a session — see `local-transfer-token.ts`. That is as close to presigning as a filesystem
 * gets, and the property that matters is preserved: the document endpoints stay stateless and a
 * 2 GB transfer never occupies one.
 *
 * Every write lands on a temporary name and is renamed into place. A rename within one filesystem
 * is atomic, so a failed or abandoned upload leaves a `.partial` file the sweeper removes rather
 * than a half-written object that reads as a complete one — which for content-addressed storage
 * would be a blob whose bytes do not match the digest that names it.
 */
export interface LocalAdapterOptions {
  /** The directory every tenant's prefix sits inside. */
  readonly root: string;
  /**
   * The absolute, browser-reachable URL of the transfer endpoint.
   *
   * Passed in whole rather than assembled here from a base and a path, because the API's prefix and
   * version live in the composition root — and an adapter that rebuilt them would be a second place
   * the route is written down, silently wrong the day the first one moves.
   */
  readonly transferUrl: string;
  /** Signs the transfer capabilities. Derived from the deployment's own signing material. */
  readonly signingSecret: string;
  readonly now: () => Date;
}

const PARTIAL_SUFFIX = '.partial';

export class LocalStorageAdapter implements StoragePort {
  readonly driver: StorageDriverKey = 'LOCAL';

  private readonly root: string;

  constructor(private readonly options: LocalAdapterOptions) {
    this.root = resolve(options.root);
  }

  createUploadTarget(input: UploadTargetInput): Promise<UploadTarget> {
    const expiresAt = new Date(this.options.now().getTime() + input.expiresInSeconds * 1000);
    // Never multipart. A filesystem has nothing to resume against — there is no server-side
    // session to reattach to — and pretending otherwise would give a client parts it could upload
    // and no way to assemble them. A large upload here is one long PUT, which is what it is.
    return Promise.resolve({
      key: input.key,
      url: this.urlFor({
        key: input.key,
        method: 'PUT',
        expiresAt,
        maxBytes: input.sizeBytes,
        contentType: input.contentType,
      }),
      method: 'PUT',
      headers: { 'Content-Type': input.contentType, 'Content-Length': String(input.sizeBytes) },
      expiresAt,
    });
  }

  async completeUpload(key: StorageKey, _parts: readonly UploadPart[]): Promise<BlobMetadata> {
    const metadata = await this.head(key);
    if (metadata === null) {
      throw new StorageUnavailableError(
        'The upload completed but the file is not there. Nothing was recorded.',
      );
    }
    return metadata;
  }

  createDownloadUrl(key: StorageKey, options: DownloadOptions): Promise<SignedUrl> {
    const expiresAt = new Date(this.options.now().getTime() + options.expiresInSeconds * 1000);
    return Promise.resolve({
      url: this.urlFor({
        key,
        method: 'GET',
        expiresAt,
        ...(options.filename !== undefined && {
          disposition: `${options.inline === true ? 'inline' : 'attachment'}; filename="${options.filename}"`,
        }),
      }),
      expiresAt,
    });
  }

  /**
   * What is on disk, including the digest.
   *
   * The digest is computed by reading the file, which an object store would have recorded on the
   * way in. That is a real cost — one pass over the bytes per completed upload — and it is the
   * right trade: content addressing is what makes "the approved bytes are still the approved
   * bytes" provable, and a `LOCAL` deployment that skipped the hash would be the one deployment
   * where it is not.
   */
  async head(key: StorageKey): Promise<BlobMetadata | null> {
    const path = this.pathFor(key);
    let stats;
    try {
      stats = await stat(path);
    } catch (cause) {
      if (isMissing(cause)) {
        return null;
      }
      throw new StorageUnavailableError('The storage directory could not be read.', { cause });
    }
    if (!stats.isFile()) {
      return null;
    }
    return {
      key,
      sizeBytes: stats.size,
      // A filesystem stores no content type, so the recorded one on the file object is the answer
      // and this is deliberately non-committal rather than guessed from the extension — a
      // content-addressed key has no extension to guess from.
      contentType: 'application/octet-stream',
      checksumSha256: await this.digest(path),
      lastModifiedAt: stats.mtime,
    };
  }

  async copy(from: StorageKey, to: StorageKey): Promise<void> {
    const destination = this.pathFor(to);
    await mkdir(dirname(destination), { recursive: true });
    try {
      await copyFile(this.pathFor(from), destination);
    } catch (cause) {
      throw new StorageUnavailableError('The file could not be copied.', { cause });
    }
  }

  async delete(key: StorageKey): Promise<void> {
    try {
      // `force` so a second attempt at a blob already removed succeeds. Retention retries after a
      // failure, and the second run meeting an absent file has achieved what it was asked to.
      await rm(this.pathFor(key), { force: true });
    } catch (cause) {
      throw new StorageUnavailableError('The file could not be removed.', { cause });
    }
  }

  // --- What the transfer endpoints call ------------------------------------------------------

  /** Where a key's bytes live. The only place a key becomes a path. */
  pathFor(key: StorageKey): string {
    const path = resolve(this.root, key);
    // The scoping wrapper already refuses a key containing `..`, and this refuses it again from the
    // other end — against the resolved path rather than against the string. Two checks for one
    // property, because for the filesystem driver the failure is a write outside the storage root
    // and there is no version of that which is merely untidy.
    if (path !== this.root && !path.startsWith(`${this.root}${sep}`)) {
      throw new ForbiddenError('A storage key cannot address a path outside storage.');
    }
    return path;
  }

  /** The name bytes are written under until they are complete. */
  partialPathFor(key: StorageKey): string {
    return `${this.pathFor(key)}${PARTIAL_SUFFIX}`;
  }

  async beginWrite(key: StorageKey): Promise<string> {
    const partial = this.partialPathFor(key);
    await mkdir(dirname(partial), { recursive: true });
    await writeFile(partial, '');
    return partial;
  }

  /** Renames the completed bytes into place. Atomic within one filesystem, which is the point. */
  async finishWrite(key: StorageKey): Promise<void> {
    await rename(this.partialPathFor(key), this.pathFor(key));
  }

  async abandonWrite(key: StorageKey): Promise<void> {
    await rm(this.partialPathFor(key), { force: true });
  }

  // --- Internals -----------------------------------------------------------------------------

  private urlFor(grant: TransferGrant): string {
    const token = encodeTransferToken(this.options.signingSecret, grant);
    return `${this.options.transferUrl}?token=${encodeURIComponent(token)}`;
  }

  private async digest(path: string): Promise<string> {
    const hash = createHash('sha256');
    const handle = await open(path, 'r');
    try {
      // Streamed rather than read whole: a 2 GB drawing must not become 2 GB of resident memory in
      // the process answering a HEAD.
      for await (const chunk of handle.createReadStream()) {
        hash.update(chunk as Buffer);
      }
    } finally {
      await handle.close();
    }
    return hash.digest('hex');
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
