import { createHash } from 'node:crypto';
import { connect, type Socket } from 'node:net';

import { ScanStatus } from '@edms/domain';

import {
  AntivirusScanError,
  type AntivirusPort,
  type ScanRequest,
  type ScanVerdict,
} from '../../../ports/antivirus.port';
import type { IcapEndpoint } from '../../../core/config/icap-url';
import type { StoragePort } from '../../../ports/storage.port';
import {
  BODY_END,
  bodyChunk,
  headEnd,
  type IcapResponseHead,
  parseResponseHead,
  respmodHead,
  scannerOf,
  verdictOf,
} from './icap-protocol';

export interface IcapAntivirusOptions {
  readonly endpoint: IcapEndpoint;
  /** Content above this is not sent, and is recorded as having no verdict. */
  readonly maxBytes: number;
  /** An upper bound on one scan, whatever the caller asks for. */
  readonly timeoutMs: number;
}

/** A response head larger than this is not a scanner talking. */
const MAX_HEAD_BYTES = 64 * 1024;
/** The size the body is framed in. Bounded so one write never doubles a large blob in memory. */
const CHUNK_BYTES = 64 * 1024;
/** What the readiness probe scans: a few bytes of text any engine passes. */
const PROBE_BODY = Buffer.from('munaxa-docs antivirus readiness probe\n', 'latin1');

/**
 * `AV_DRIVER=ICAP` — the antivirus adapter, RC D-3.
 *
 * Until this existed `ANTIVIRUS_PORT` was bound to the unconfigured adapter whatever `AV_DRIVER`
 * said, so a production deployment configured for ICAP booted, reported ready, and recorded every
 * upload `SKIPPED` — content that could never be filed. This speaks RESPMOD to the configured ICAP
 * service (c-icap with ClamAV is what CI and the RC validation run; any RFC 3507 scanner that
 * answers `204` for clean and names a threat when it blocks is compatible).
 *
 * ## What it guarantees
 *
 * - **Only the scanner's own `204` becomes `CLEAN`.** The verdict rules are in `icap-protocol.ts`,
 *   pure and unit-tested; this file never decides one.
 * - **Every failure throws `AntivirusScanError`** — unreachable, refused, timed out, closed early,
 *   answered with an error or in a way that is not a verdict, or handed content it will not send.
 *   The storage service records that as `FAILED`. There is no code path from a failure to `CLEAN`.
 * - **The bytes come from the tenant-scoped store.** It is handed the bound `STORAGE_PORT`, which is
 *   the tenant wrapper, so it can read only the calling tenant's objects — the same isolation every
 *   other reader of blobs inherits (ADR-0015).
 * - **It sends the bytes, not the claims about them.** No filename, and no declared type: see
 *   `respmodHead`.
 *
 * The whole object is read into memory before it is sent, because `StoragePort.read` is the only
 * read the port has — the constraint `verifyIntegrity` documents. `maxBytes` bounds it, and the
 * upload policy refuses anything larger before a byte is stored, so nothing is accepted that could
 * never be scanned.
 */
export class IcapAntivirusAdapter implements AntivirusPort {
  readonly scanner = 'icap';

  constructor(
    private readonly options: IcapAntivirusOptions,
    private readonly storage: Pick<StoragePort, 'read'>,
  ) {}

  async scan(request: ScanRequest): Promise<ScanVerdict> {
    if (request.sizeBytes > this.options.maxBytes) {
      throw new AntivirusScanError(
        `The content is larger than AV_ICAP_MAX_BYTES (${String(this.options.maxBytes)}) and was not sent to the scanner.`,
        'UNSCANNABLE',
      );
    }
    let bytes: Buffer | null;
    try {
      bytes = await this.storage.read(request.storageKey);
    } catch {
      throw new AntivirusScanError(
        'The content could not be read back for scanning.',
        'UNSCANNABLE',
      );
    }
    if (bytes === null) {
      throw new AntivirusScanError('The content to scan is not in storage.', 'UNSCANNABLE');
    }
    if (bytes.length > this.options.maxBytes) {
      throw new AntivirusScanError(
        'The stored content is larger than AV_ICAP_MAX_BYTES and was not sent to the scanner.',
        'UNSCANNABLE',
      );
    }
    // The verdict is recorded against this digest, so only these exact bytes may be judged. A short
    // or empty read — a store caught mid-write — would otherwise be scanned, pass as clean, and make
    // the real content CLEAN without anybody having looked at it.
    if (createHash('sha256').update(bytes).digest('hex') !== request.checksumSha256) {
      throw new AntivirusScanError(
        'The content read back does not match its digest and was not sent to the scanner.',
        'UNSCANNABLE',
      );
    }

    const head = await this.exchange(bytes, Math.min(request.timeoutMs, this.options.timeoutMs));
    const verdict = verdictOf(head);
    const scanner = scannerOf(head);
    return {
      status: verdict.infected ? ScanStatus.INFECTED : ScanStatus.CLEAN,
      threat: verdict.infected ? verdict.threat : null,
      scanner: scanner.name,
      scannerVersion: scanner.version,
      scannedAt: new Date(),
    };
  }

  /** A real scan of a few harmless bytes: the engine behind the ICAP server has to answer. */
  async probe(timeoutMs: number): Promise<void> {
    const head = await this.exchange(PROBE_BODY, Math.min(timeoutMs, this.options.timeoutMs));
    if (verdictOf(head).infected) {
      throw new AntivirusScanError('The scanner blocked the readiness probe.', 'SCANNER_ERROR');
    }
  }

  /**
   * One RESPMOD round trip: the head and an empty preview, then — once the scanner says `100
   * Continue` — the body; then the scanner's answer. Closes either way.
   *
   * Settles exactly once. A final answer to the preview means the scanner will not look at the
   * content, so it is judged with `contentSent` false: an error stays an error, and a `204` is not
   * clean.
   */
  private exchange(body: Buffer, timeoutMs: number): Promise<IcapResponseHead> {
    const { endpoint } = this.options;
    return new Promise<IcapResponseHead>((resolve, reject) => {
      let settled = false;
      let received = Buffer.alloc(0);
      let continued = false;
      let contentSent = false;
      const socket: Socket = connect({ host: endpoint.host, port: endpoint.port });

      const finish = (outcome: { head: IcapResponseHead } | { error: Error }): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if ('head' in outcome) {
          resolve(outcome.head);
        } else {
          reject(outcome.error);
        }
      };

      const timer = setTimeout(() => {
        finish({
          error: new AntivirusScanError(
            `The scanner did not answer within ${String(timeoutMs)} ms.`,
            'TIMEOUT',
          ),
        });
      }, timeoutMs);

      let connected = false;
      socket.on('connect', () => {
        connected = true;
        socket.write(respmodHead(endpoint, body.length));
      });

      socket.on('data', (data: Buffer) => {
        received = Buffer.concat([received, data]);
        for (let end = headEnd(received); end >= 0 && !settled; end = headEnd(received)) {
          let head: IcapResponseHead;
          try {
            head = parseResponseHead(received.subarray(0, end).toString('latin1'));
          } catch (error) {
            finish({ error: error as Error });
            return;
          }
          received = received.subarray(end + 4);
          if (head.status === 100 && !continued) {
            continued = true;
            this.send(socket, body, () => {
              // Every byte is handed to the socket; the scanner has been given the content.
              contentSent = true;
            }).catch(() => {
              // A scanner that answered early and closed breaks the pipe; its answer is read above,
              // or the close below reports that there was none.
            });
            continue;
          }
          try {
            verdictOf(head, contentSent);
            finish({ head });
          } catch (error) {
            finish({ error: error as Error });
          }
        }
        if (!settled && received.length > MAX_HEAD_BYTES) {
          finish({
            error: new AntivirusScanError(
              'The scanner sent an oversized response head.',
              'PROTOCOL',
            ),
          });
        }
      });

      // After the connection is up, an error is usually the write half failing because the scanner
      // answered and closed early — so it is noted, and the decision waits for `close`, by which
      // time any answer that arrived has been read.
      let dropped: string | null = null;
      socket.on('error', (error: NodeJS.ErrnoException) => {
        const code = error.code ?? error.name;
        if (connected) {
          dropped = code;
          return;
        }
        finish({
          error: new AntivirusScanError(
            `The scanner could not be reached (${code}).`,
            'UNREACHABLE',
          ),
        });
      });

      socket.on('close', () => {
        finish({
          error: new AntivirusScanError(
            dropped === null
              ? 'The scanner closed the connection without an answer.'
              : `The scanner dropped the connection without an answer (${dropped}).`,
            'PROTOCOL',
          ),
        });
      });
    });
  }

  private async send(socket: Socket, body: Buffer, queued: () => void): Promise<void> {
    for (let offset = 0; offset < body.length; offset += CHUNK_BYTES) {
      await write(socket, bodyChunk(body.subarray(offset, offset + CHUNK_BYTES)));
    }
    const last = write(socket, BODY_END);
    queued();
    await last;
  }
}

/** A write that waits for the socket to drain, so a large body is not queued whole in memory. */
function write(socket: Socket, chunk: Buffer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (socket.destroyed) {
      reject(new Error('socket closed'));
      return;
    }
    const flushed = socket.write(chunk, (error) => {
      if (error) {
        reject(error);
      }
    });
    if (flushed) {
      resolve();
    } else {
      socket.once('drain', () => resolve());
      socket.once('close', () => reject(new Error('socket closed')));
    }
  });
}
