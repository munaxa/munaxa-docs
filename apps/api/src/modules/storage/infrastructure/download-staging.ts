import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { type FileHandle, mkdir, open, readdir, rm, statfs, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import type { DownloadStaging, StagingFile } from '../application/ports';

/**
 * Where a download waits while it is verified — ADR-0026 §10,
 * `docs/reports/hetzner-download-integrity-proposal.md` §3.1.
 *
 * A download is streamed from the store into one of these files while it is hashed, and nothing
 * is sent until the digest matches the record. The file holds a document's bytes on the API's own
 * disk for that time, so it is made to hold nothing anyone else can use:
 *
 * - **Unlinked at once.** It is created under a random name in a directory only this process may
 *   enter (0700), opened, and its name removed before a byte is written. Only the open descriptor
 *   reaches it; closing that — on success, failure, disconnection, or the process dying — frees it.
 *   A process killed between `open` and `unlink` leaves a named file; `prepare()` empties the
 *   directory at start-up for that case.
 * - **Encrypted with a key that is never written down.** AES-256-GCM with a fresh random key per
 *   file, held in this object's memory only and overwritten on `dispose()`. The disk never holds a
 *   key beside its data, so whatever a crash leaves behind is unreadable.
 * - **Authenticated record by record.** Each record (up to `RECORD_BYTES` of plaintext) carries its
 *   own tag, checked before that record's plaintext is handed out — so even bytes changed on this
 *   disk while they waited are refused before they could be sent, not discovered after.
 */

/** Plaintext per record. Memory per download is about one of these. */
const RECORD_BYTES = 256 * 1024;
/** 4-byte length, then a 16-byte GCM tag, then the ciphertext. */
const HEADER_BYTES = 4 + 16;

export class LocalDownloadStaging implements DownloadStaging {
  constructor(private readonly directory: string) {}

  /** Creates the directory (0700) and removes anything a previous process left in it. */
  async prepare(): Promise<number> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const leftovers = await readdir(this.directory);
    await Promise.all(
      leftovers.map((name) => rm(join(this.directory, name), { force: true, recursive: true })),
    );
    return leftovers.length;
  }

  async freeBytes(): Promise<number> {
    const stats = await statfs(this.directory);
    return Number(stats.bavail) * Number(stats.bsize);
  }

  async create(): Promise<StagingFile> {
    const path = join(this.directory, randomUUID());
    const handle = await open(path, 'wx+', 0o600);
    try {
      await unlink(path);
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
    return new EncryptedStagingFile(handle);
  }
}

class EncryptedStagingFile implements StagingFile {
  private readonly key = randomBytes(32);
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private records = 0;
  private offset = 0;
  private written = 0;
  private sealed = false;
  private disposed = false;

  constructor(private readonly handle: FileHandle) {}

  get bytesWritten(): number {
    return this.written;
  }

  async write(chunk: Uint8Array): Promise<void> {
    this.refuseAfter('write', this.sealed);
    this.pending.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    this.pendingBytes += chunk.byteLength;
    this.written += chunk.byteLength;
    while (this.pendingBytes >= RECORD_BYTES) {
      const joined = Buffer.concat(this.pending, this.pendingBytes);
      await this.writeRecord(joined.subarray(0, RECORD_BYTES));
      const rest = Buffer.from(joined.subarray(RECORD_BYTES));
      this.pending = rest.length > 0 ? [rest] : [];
      this.pendingBytes = rest.length;
    }
  }

  async *replay(): AsyncIterable<Buffer> {
    this.refuseAfter('replay', false);
    if (!this.sealed) {
      if (this.pendingBytes > 0) {
        await this.writeRecord(Buffer.concat(this.pending, this.pendingBytes));
        this.pending = [];
        this.pendingBytes = 0;
      }
      this.sealed = true;
    }
    let position = 0;
    let delivered = 0;
    for (let record = 0; record < this.records; record += 1) {
      const header = Buffer.alloc(HEADER_BYTES);
      await this.readFully(header, position);
      const length = header.readUInt32BE(0);
      const ciphertext = Buffer.alloc(length);
      await this.readFully(ciphertext, position + HEADER_BYTES);
      position += HEADER_BYTES + length;

      const decipher = createDecipheriv('aes-256-gcm', this.key, nonceFor(record));
      decipher.setAuthTag(header.subarray(4, HEADER_BYTES));
      // `final()` throws on a bad tag, before this record's plaintext is yielded.
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      delivered += plaintext.length;
      yield plaintext;
    }
    if (delivered !== this.written) {
      throw new Error('The staged download is not the length that was written.');
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.key.fill(0);
    this.pending = [];
    await this.handle.close().catch(() => undefined);
  }

  private async writeRecord(plaintext: Buffer): Promise<void> {
    const cipher = createCipheriv('aes-256-gcm', this.key, nonceFor(this.records));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const header = Buffer.alloc(HEADER_BYTES);
    header.writeUInt32BE(ciphertext.length, 0);
    cipher.getAuthTag().copy(header, 4);
    const record = Buffer.concat([header, ciphertext]);
    let done = 0;
    while (done < record.length) {
      const { bytesWritten } = await this.handle.write(
        record,
        done,
        record.length - done,
        this.offset + done,
      );
      done += bytesWritten;
    }
    this.offset += record.length;
    this.records += 1;
  }

  private async readFully(target: Buffer, position: number): Promise<void> {
    let done = 0;
    while (done < target.length) {
      const { bytesRead } = await this.handle.read(
        target,
        done,
        target.length - done,
        position + done,
      );
      if (bytesRead === 0) {
        throw new Error('The staged download ended early.');
      }
      done += bytesRead;
    }
  }

  private refuseAfter(operation: string, sealed: boolean): void {
    if (this.disposed) {
      throw new Error(`A disposed staging file cannot ${operation}.`);
    }
    if (sealed) {
      throw new Error(`A staging file being replayed cannot ${operation}.`);
    }
  }
}

/** A 96-bit counter nonce: unique per record under a key that is unique per file. */
function nonceFor(record: number): Buffer {
  const nonce = Buffer.alloc(12);
  nonce.writeUInt32BE(record, 8);
  return nonce;
}
