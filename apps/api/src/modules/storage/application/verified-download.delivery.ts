import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { type FileObjectId, IntegrityStatus } from '@edms/domain';

import { APP_CONFIG, type AppConfig } from '../../../core/config';
import {
  ContentQuarantinedError,
  DownloadBusyError,
  DownloadTooLargeError,
  StorageUnavailableError,
} from '../../../core/errors/application-errors';
import { LOGGER, type Logger } from '../../../core/observability/logger';
import { CLOCK_PORT, type ClockPort } from '../../../ports/clock.port';
import {
  STORAGE_PORT,
  type StoragePort,
  type StoredObjectStream,
} from '../../../ports/storage.port';
import { ByteBudget, ByteBudgetTimeoutError } from '../domain/byte-budget';
import { type DownloadLinkGrant, decodeDownloadLinkToken } from '../domain/download-link-token';
import { formatBytes } from '../domain/upload-policy';
import {
  DOWNLOAD_STAGING,
  type DownloadStaging,
  type FileObjectRecord,
  STORAGE_SERVICE,
  type StorageService,
  type VerifiedDownload,
  type VerifiedDownloadDelivery,
} from './ports';

/**
 * Verify, then serve — ADR-0026 §10, `docs/reports/hetzner-download-integrity-proposal.md` §3.
 *
 * Hashing bytes while they are sent does not stop a person receiving the wrong ones: the mismatch
 * is known only after the last byte has gone. So the object is read **whole** into a staging file
 * first, hashed on the way in, and `send` is called only once the size and the SHA-256 both equal
 * the record. Until then not one byte of content has been offered to the caller.
 *
 * What each failure means is decided by what is known, never guessed:
 *
 * | What happened | Answer | Quarantine |
 * | --- | --- | --- |
 * | The bytes hash to another digest, or the store states another size | 409 | MISMATCH |
 * | The store says "no such object", and a HEAD says so again | 409 | UNREADABLE |
 * | One "no such object" the HEAD contradicts or cannot confirm | 503 | no |
 * | A store error, a timeout, a reset, a body shorter or longer than stated | 503 | no |
 * | No room (concurrency, staging bytes, free disk) within the wait | 503 + Retry-After | no |
 *
 * Memory is a few staging records per download whatever the file's size; disk is the file's size,
 * for as long as it is being verified and sent, inside `DOWNLOAD_STAGING_MAX_BYTES`.
 */
@Injectable()
export class DefaultVerifiedDownloadDelivery implements VerifiedDownloadDelivery {
  private readonly slots: ByteBudget;
  private readonly stagedBytes: ByteBudget;

  constructor(
    @Inject(STORAGE_SERVICE) private readonly storageService: StorageService,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(DOWNLOAD_STAGING) private readonly staging: DownloadStaging,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(CLOCK_PORT) private readonly clock: ClockPort,
  ) {
    // Two limits, each first come first served: one unit per download, and its bytes.
    this.slots = new ByteBudget(config.download.maxConcurrent);
    this.stagedBytes = new ByteBudget(config.download.stagingMaxBytes);
  }

  decode(token: string): DownloadLinkGrant | null {
    const decoded = decodeDownloadLinkToken(this.config.auth.accessSecret, token, this.clock.now());
    if ('rejection' in decoded) {
      this.logger.warn('A download link was refused', { rejection: decoded.rejection });
      return null;
    }
    return decoded.grant;
  }

  async deliver(
    fileObjectId: FileObjectId,
    send: (download: VerifiedDownload) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    // The gate's own refusals (not scanned, quarantined), asked again at the moment of use.
    const file = await this.storageService.servable(fileObjectId);
    const limit = this.config.download.maxFileBytes;
    if (file.sizeBytes > limit) {
      throw new DownloadTooLargeError(limit, formatBytes(limit));
    }

    const started = Date.now();
    const deadline = started + this.config.download.queueTimeoutMs;
    try {
      await this.slots.run(1, this.config.download.queueTimeoutMs, () =>
        this.stagedBytes.run(file.sizeBytes, Math.max(1, deadline - Date.now()), async () => {
          await this.refuseWithoutDiskRoom(file);
          await this.verifyAndSend(file, send, signal, started);
        }),
      );
    } catch (error) {
      if (error instanceof ByteBudgetTimeoutError) {
        throw new DownloadBusyError();
      }
      throw error;
    }
  }

  private async verifyAndSend(
    file: FileObjectRecord,
    send: (download: VerifiedDownload) => Promise<void>,
    signal: AbortSignal,
    started: number,
  ): Promise<void> {
    // Staging first, so that nothing opened at the store is ever left without a reader to close it.
    const staged = await this.staging.create();
    try {
      const opened = await this.open(file, signal);
      if (opened.sizeBytes !== file.sizeBytes) {
        // The store states the object's size before a byte is read; a size other than the one
        // recorded is not the recorded object, and nothing of it is read or sent.
        await opened.cancel();
        await this.quarantine(file, IntegrityStatus.MISMATCH, null, 'size');
      }
      const hash = createHash('sha256');
      for await (const chunk of opened.body) {
        if (signal.aborted) {
          throw new StorageUnavailableError('The download was abandoned.');
        }
        hash.update(chunk);
        await staged.write(chunk);
      }
      const actual = hash.digest('hex');
      if (staged.bytesWritten !== file.sizeBytes || actual !== file.checksumSha256) {
        await this.quarantine(file, IntegrityStatus.MISMATCH, actual, 'digest');
      }
      const verifiedAfterMs = Date.now() - started;
      await send({ sizeBytes: file.sizeBytes, chunks: staged.replay(), verifiedAfterMs });
    } finally {
      await staged.dispose();
    }
  }

  /** The object's stream, with a confirmed absence quarantined and anything else left transient. */
  private async open(file: FileObjectRecord, signal: AbortSignal): Promise<StoredObjectStream> {
    const opened = await this.storage.openRead(file.storageKey, { signal });
    if (opened !== null) {
      return opened;
    }
    let again;
    try {
      again = await this.storage.head(file.storageKey);
    } catch (cause) {
      throw new StorageUnavailableError('The object could not be confirmed absent.', { cause });
    }
    if (again !== null) {
      throw new StorageUnavailableError(
        'The store answered "no such object" for an object it has.',
      );
    }
    return this.quarantine(file, IntegrityStatus.UNREADABLE, null, 'absent');
  }

  private async quarantine(
    file: FileObjectRecord,
    status: typeof IntegrityStatus.MISMATCH | typeof IntegrityStatus.UNREADABLE,
    actual: string | null,
    finding: 'size' | 'digest' | 'absent',
  ): Promise<never> {
    this.logger.error('A download did not verify; nothing was sent and the file is quarantined', {
      fileObjectId: String(file.id),
      finding,
      integrityStatus: status,
    });
    await this.storageService.recordIntegrityFinding(file.id, status, actual);
    throw new ContentQuarantinedError(status);
  }

  private async refuseWithoutDiskRoom(file: FileObjectRecord): Promise<void> {
    const free = await this.staging.freeBytes();
    if (free - file.sizeBytes < this.config.download.minFreeBytes) {
      this.logger.error('The download staging disk is too full to verify a download', {
        fileObjectId: String(file.id),
        freeBytes: free,
        neededBytes: file.sizeBytes,
        reserveBytes: this.config.download.minFreeBytes,
      });
      throw new DownloadBusyError();
    }
  }
}
