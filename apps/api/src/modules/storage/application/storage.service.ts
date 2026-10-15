import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import {
  type AnyId,
  AuditSubjectType,
  type DomainEventDraft,
  type FileObjectId,
  AuditOutcome,
  ErrorReason,
  IntegrityStatus,
  type IntegrityStatusKey,
  ScanStatus,
  isServableIntegrity,
  type ScanStatusKey,
  UploadSessionState,
  type UploadSessionId,
  asId,
} from '@edms/domain';
import { sanitizeFilename } from '@edms/utils';

import { APP_CONFIG, type AppConfig } from '../../../core/config';
import {
  ContentNotScannedError,
  ContentQuarantinedError,
  DownloadTooLargeError,
  ForbiddenError,
  NotFoundError,
  ScannerBusyError,
  StorageUnavailableError,
  UnsupportedContentError,
  UploadExpiredError,
  UploadNotReceivedError,
  ValidationError,
} from '../../../core/errors/application-errors';
import { AdministeredWriter, AdministrativeOperation } from '../../../core/persistence';
import { currentTransaction } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';
import { OUTBOX_WRITER, type OutboxWriter } from '../../../core/outbox/outbox.port';
import {
  ANTIVIRUS_PORT,
  AntivirusScanError,
  type AntivirusPort,
} from '../../../ports/antivirus.port';
import { CLOCK_PORT, type ClockPort } from '../../../ports/clock.port';
import { STORAGE_PORT, type StoragePort } from '../../../ports/storage.port';
import { StorageAudit } from '../domain/audit-actions';
import { ByteBudget, ByteBudgetTimeoutError } from '../domain/byte-budget';
import { unreachableBecause } from '../domain/reachability';
import {
  BLOB_PREFIX,
  STAGING_PREFIX,
  blobKeyFor,
  derivedKeyFor,
  evidenceKeyFor,
  evidencePrefixFor,
  isBlobKey,
  stagingKeyFor,
  stagingSessionOf,
} from '../domain/content-key';
import {
  fileIntegrityMismatchEvent,
  fileObjectCreatedEvent,
  fileQuarantinedEvent,
  fileScanCompletedEvent,
} from '../domain/events';
import {
  checkUpload,
  defaultUploadPolicy,
  formatBytes,
  isRejection,
  narrowPolicy,
} from '../domain/upload-policy';
import {
  DOWNLOAD_LINK_PATH,
  type DownloadLinkSubject,
  encodeDownloadLinkToken,
} from '../domain/download-link-token';
import {
  type CompletedUpload,
  FILE_OBJECT_REPOSITORY,
  type FileObjectRecord,
  type FileObjectRepository,
  type IntegritySweepResult,
  type IssuedUploadTarget,
  type StorageService,
  UPLOAD_SESSION_REPOSITORY,
  type UploadSessionRecord,
  type UploadSessionRepository,
  type OrphanSweepArea,
  type OrphanSweepResult,
} from './ports';

/**
 * The upload and download path, and the only caller of the antivirus gate.
 *
 * Four things here are the phase's substance rather than plumbing.
 *
 * **Nothing is stored to find out it is refused.** The type, the size and the content sniff all run
 * before a presigned target exists, so a rejected upload never occupies a byte of storage and never
 * costs the person the transfer (`17-security-architecture.md` §5).
 *
 * **Bytes land on a staging key and move to their content key at completion.** The final key *is*
 * the digest, and the digest is not known until the bytes have arrived. Writing to the content key
 * on the client's word would mean a client that computes its checksum wrongly — or lies — could
 * overwrite the blob that legitimately holds that digest, and every integrity check afterwards
 * would report tampering on a document nobody touched.
 *
 * **The store's own answer is the fact; the client's claim is a claim.** Size and digest are read
 * back at completion and compared with what was announced. A mismatch is refused, and the bytes are
 * removed rather than left behind as an orphan nothing references.
 *
 * **A blob is unreachable until the scan says CLEAN.** Enforced here, and again by a database
 * trigger, because "enforced in the use case and in the database" is what the architecture asks for
 * and because the use case is not the only thing that ever writes these rows.
 */
/** How far a store's clock may run ahead of ours before an object looks rewritten (see above). */
const STORE_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** How long one integrity re-read may wait for scan capacity before the pass gives up. */
const VERIFIER_CAPACITY_WAIT_MS = 10 * 60 * 1000;

@Injectable()
export class DefaultStorageService implements StorageService {
  constructor(
    @Inject(FILE_OBJECT_REPOSITORY) private readonly files: FileObjectRepository,
    @Inject(UPLOAD_SESSION_REPOSITORY) private readonly sessions: UploadSessionRepository,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(ANTIVIRUS_PORT) private readonly antivirus: AntivirusPort,
    @Inject(CLOCK_PORT) private readonly clock: ClockPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriter,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly writer: AdministeredWriter,
  ) {
    this.scanCapacity = new ByteBudget(config.antivirus.budgetBytes);
  }

  /** The bytes of content scanned at once in this process (`AV_SCAN_BUDGET_BYTES`). */
  private readonly scanCapacity: ByteBudget;

  /**
   * Validates, then issues a target — or reports that the bytes are already here.
   *
   * The `alreadyStored` answer is what makes duplicate detection cost nothing. The client sends the
   * digest it computed; if the tenant already holds that content, there is nothing to transfer and
   * the document use case is handed the existing blob. A client that sends no digest simply
   * uploads, and completion deduplicates instead — the same outcome, one transfer later.
   */
  async createUploadSession(input: {
    filename: string;
    mimeType: string;
    sizeBytes: number;
    magicBytes: Uint8Array;
    checksumSha256?: string | undefined;
  }): Promise<IssuedUploadTarget> {
    const filename = sanitizeFilename(input.filename);
    const verdict = checkUpload(
      {
        filename,
        declaredMimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        magicBytes: input.magicBytes,
      },
      this.policy(),
    );
    if (isRejection(verdict)) {
      throw new UnsupportedContentError(
        verdict.detail,
        { reason: verdict.reason },
        { reason: verdict.reason, ...(verdict.values !== undefined && { values: verdict.values }) },
      );
    }

    const digest = normalizeDigest(input.checksumSha256);
    // A blob that never received a verdict is scanned when its bytes are offered again, so
    // re-uploading is how it recovers — RC D-3. The scan runs here, before the transaction opens,
    // and the transaction below only records it — STG-1 (`verdictFor`).
    const offered =
      digest === null ? null : await this.writer.read(() => this.files.findByChecksum(digest));
    const known = offered === null ? null : await this.verdictFor(offered);

    return this.writer.write<IssuedUploadTarget>(async () => {
      if (digest !== null) {
        const found = await this.files.findByChecksum(digest);
        if (found !== null) {
          // Nothing to transfer. Still audited, and still a session, because "an upload happened"
          // is a fact an auditor asks about whether or not bytes moved.
          const { file: existing, rescan } = await this.settleVerdict(found, known);
          const sessionId = this.writer.clock.nextId();
          return {
            result: {
              uploadSessionId: sessionId,
              url: '',
              method: 'PUT' as const,
              headers: {},
              expiresAt: this.expiry(),
              parts: null,
              alreadyStored: { fileObjectId: existing.id },
            },
            change: this.uploaded(existing.id, AdministrativeOperation.CREATED, {
              filename,
              sizeBytes: input.sizeBytes,
              mimeType: verdict.format.mimeType,
              deduplicated: true,
              ...rescan,
            }),
          };
        }
      }

      const sessionId = this.writer.clock.nextId();
      const targetKey = stagingKeyFor(sessionId);
      // One signed PUT at every size (STG-10), never a multipart target. The store verifies the
      // signed SHA-256 against the bytes and reports it back, which is the digest completion
      // requires; a multipart object has no full-object SHA-256, and the web client sends one
      // body to one URL. A single PUT is bounded by the store at 5 GiB, above the 2 GiB default
      // ceiling and far above the scanner's.
      const target = await this.storage.createUploadTarget({
        key: targetKey,
        // The *sniffed* type is signed into the target, not the declared one. A URL issued for a
        // PDF cannot be redeemed for anything else, and the sniff is what decided it is a PDF.
        contentType: verdict.format.mimeType,
        sizeBytes: input.sizeBytes,
        expiresInSeconds: this.config.storage.signedUrlTtlSeconds,
        ...(digest !== null && { checksumSha256: digest }),
      });

      await this.sessions.insert({
        id: sessionId,
        filename,
        declaredMimeType: verdict.format.mimeType,
        declaredSizeBytes: input.sizeBytes,
        targetKey,
        multipartUploadId: target.parts?.[0]?.uploadId ?? null,
        expiresAt: target.expiresAt,
      });

      return {
        result: {
          uploadSessionId: sessionId,
          url: target.url,
          method: target.method,
          headers: target.headers,
          expiresAt: target.expiresAt,
          // Only the parts a client can actually PUT. Every part of a presigned target has a
          // URL; the ones without are the server-driven write's, which never reach a caller.
          parts:
            target.parts?.flatMap((part) =>
              part.url === undefined ? [] : [{ partNumber: part.partNumber, url: part.url }],
            ) ?? null,
          alreadyStored: null,
        },
        // Audited *before* the URL reaches the caller — the record of who was handed a capability
        // is the only evidence of how bytes could have left the system.
        change: this.uploaded(sessionId, AdministrativeOperation.CREATED, {
          filename,
          sizeBytes: input.sizeBytes,
          mimeType: verdict.format.mimeType,
        }),
      };
    });
  }

  /**
   * Confirms the transfer, checks it against what was promised, and creates the blob.
   *
   * The order is the point. Read the store's answer, compare, scan, and only then write a row —
   * so there is no state in which a `file_object` exists for bytes that were never verified.
   *
   * ## Only the last step is a database transaction — STG-1
   *
   * Staging found this whole method inside one PostgreSQL transaction, and Prisma closes an
   * interactive transaction after 5,000 ms. Reading a 50 MiB object back and scanning it takes
   * longer than that, so every such upload answered `500` with nothing recorded, and a slow or hung
   * scanner did the same instead of recording `FAILED` — `AV_SCAN_TIMEOUT_MS` governed nothing.
   *
   * So the work is split where the database stops being involved:
   *
   * 1. **Read** the session (a short read) and the store's own answer about the bytes.
   * 2. **Outside any transaction**: promote the bytes to their content key and scan them — or, for
   *    a digest already stored without a verdict, scan that blob (`verdictFor`). Only the scanner's
   *    bound (`AV_SCAN_TIMEOUT_MS`) limits this now.
   * 3. **One short transaction** records the verdict: the row (inserted with its verdict, never
   *    before it), the session's claim, the outbox events and the audit record, together.
   *
   * Nothing in step 2 can make bytes fileable. A `file_object` row exists only from step 3, with
   * the verdict the scanner gave for exactly the bytes whose digest the row carries: the content
   * key is the digest, and the adapter refuses bytes that do not hash to it (RC D-3). The claim on
   * the session is still `settle`'s compare-and-set in step 3, so a completion racing this one, or
   * the expiry sweep, decides the winner exactly as before; the loser's row insert rolls back with
   * its claim. Deduplication is asked again inside step 3, because the answer from step 1 is only
   * as fresh as step 2 was short, and a verdict carried into step 3 is applied only to a row
   * holding the digest it was computed for, only from `FAILED`/`SKIPPED` (`settleVerdict`).
   */
  async completeUploadSession(
    id: UploadSessionId,
    parts: readonly { partNumber: number; etag: string }[],
  ): Promise<CompletedUpload> {
    const session = await this.writer.read(() => this.sessions.findById(id));
    if (session === null) {
      throw new NotFoundError('The requested upload');
    }
    this.refuseAnotherPersonsUpload(session);
    if (session.state !== UploadSessionState.OPEN) {
      throw new ValidationError(
        'That upload has already been finished.',
        [{ field: 'state', message: session.state }],
        { reason: ErrorReason.UPLOAD_FINISHED },
      );
    }

    // A single PUT has nothing to finish, so the store is simply asked what it holds — and an
    // answer of "nothing" is told apart from a store that is down (ADR-0026 §10, Phase A).
    const metadata =
      session.multipartUploadId === null
        ? await this.storage.head(session.targetKey)
        : await this.storage.completeUpload(
            session.targetKey,
            parts.map((part) => ({
              partNumber: part.partNumber,
              url: '',
              etag: part.etag,
              uploadId: session.multipartUploadId ?? undefined,
            })),
          );
    if (metadata === null) {
      return this.refuseMissingBytes(session);
    }

    if (metadata.sizeBytes !== session.declaredSizeBytes) {
      // The bytes that arrived are not the bytes that were approved. The target was signed for a
      // size, so this is a store that did not enforce it — and the honest response is to remove
      // what arrived rather than to record a blob whose provenance is already in question.
      return this.refuseTransfer(
        session,
        new UnsupportedContentError(
          'The upload did not match the size it declared.',
          { declared: session.declaredSizeBytes, stored: metadata.sizeBytes },
          { reason: ErrorReason.SIZE_MISMATCH },
        ),
      );
    }

    const digest = metadata.checksumSha256;
    if (digest === null) {
      return this.refuseTransfer(
        session,
        new UnsupportedContentError(
          'Storage could not confirm the file’s digest.',
          {},
          { reason: ErrorReason.DIGEST_UNCONFIRMED },
        ),
      );
    }

    // Deduplication, at the only moment the digest is a fact. Two people uploading the same
    // standard form converge here rather than at the client's optional pre-check.
    const existing = await this.writer.read(() => this.files.findByChecksum(digest));
    if (existing !== null) {
      const known = await this.verdictFor(existing);
      const deduplicated = await this.writer.write<CompletedUpload>(async () => {
        const current = await this.files.findByChecksum(digest);
        if (current === null) {
          // Reclaimed while this upload was being scanned: the bytes it would settle onto are gone.
          // Nothing is recorded and this session's staged copy is still there, so completing again
          // stores the bytes afresh.
          throw new StorageUnavailableError(
            'The stored copy of this file was removed while the upload finished.',
          );
        }
        return await this.deduplicatedOnto(current, id, known);
      });
      await this.removeStaged(session.targetKey);
      return deduplicated;
    }

    const contentKey = blobKeyFor(digest);
    // Admitted before anything is copied: a completion refused as busy has changed nothing, so the
    // same request succeeds later (ADR-0026 §10, Phase A).
    const scan = await this.withScanCapacity(metadata.sizeBytes, async () => {
      await this.storage.copy(session.targetKey, contentKey);
      return this.scan(contentKey, digest, metadata.sizeBytes, session.declaredMimeType);
    });

    // The staged bytes outlive everything that can fail before the row commits (ADR-0026 §10,
    // Phase A): a completion interrupted anywhere above — refused, crashed, killed — leaves the
    // session OPEN with its bytes staged, and completing it again repeats the copy (to the same
    // content key) and the scan. They are removed only once the row says what they became.
    const completed = await this.writer.write<CompletedUpload>(async () => {
      const fileObjectId = this.writer.clock.nextId();
      const created = await this.files.insert({
        id: fileObjectId,
        checksumSha256: digest,
        sizeBytes: metadata.sizeBytes,
        mimeType: session.declaredMimeType,
        storageKey: contentKey,
        storageDriver: this.storage.driver,
        scanStatus: scan.status,
        scanner: scan.scanner,
        scanThreat: scan.threat,
        derived: false,
      });
      if (!created) {
        /*
         * Somebody stored these very bytes while this upload was scanning them — Slice 46.
         *
         * The read above and the insert are the same question asked at two moments, and between
         * them sit the copy to the content key and the scan. Two people uploading the same standard
         * form at the same time both saw no digest, and the loser used to raise `P2002` from
         * `fileObject.create` — a raw Prisma error, so `AllExceptionsFilter` answered `500`, and the
         * rolled-back transaction left the session `OPEN` with its staging object already deleted,
         * which made retrying answer "Object storage is unavailable". The upload had to be started
         * again from the file picker.
         *
         * Now the insert tolerates the conflict and says so, and this converges on the answer the
         * *sequential* second-comer already gets: the winner's blob, this session settled onto it,
         * and `deduplicated`. Nothing new is invented — the bytes are the same bytes, which is what
         * content addressing means, and both sessions copied them to the same content key.
         */
        const winner = await this.files.findByChecksum(digest);
        if (winner === null) {
          // The digest is not there and this did not write it: something other than the checksum
          // index refused the row, and answering "stored" would be a lie about durable content.
          throw new StorageUnavailableError('The blob could not be stored.');
        }
        // This upload already scanned these very bytes. If the winner has no verdict yet, this one
        // is it — the verdict is not lost because the row was somebody else's to insert.
        return await this.deduplicatedOnto(winner, id, { checksumSha256: digest, outcome: scan });
      }
      this.requireClaimed(
        await this.sessions.settle(id, UploadSessionState.COMPLETED, fileObjectId),
      );

      const events: DomainEventDraft[] = [
        fileObjectCreatedEvent(asId<AnyId>(fileObjectId), {
          fileObjectId,
          checksumSha256: digest,
          sizeBytes: metadata.sizeBytes,
          mimeType: session.declaredMimeType,
          deduplicated: false,
        }),
        fileScanCompletedEvent(asId<AnyId>(fileObjectId), {
          fileObjectId,
          status: scan.status,
          scanner: scan.scanner ?? 'none',
        }),
      ];
      if (scan.status === ScanStatus.INFECTED) {
        // The blob stays, unreachable, rather than being deleted: an incident wants the sample, and
        // nothing can attach it — the gate here and the database trigger both refuse.
        events.push(
          fileQuarantinedEvent(asId<AnyId>(fileObjectId), {
            fileObjectId,
            threat: scan.threat ?? 'unknown',
            uploadedBy: session.createdBy ?? 'system',
          }),
        );
      }
      await this.outbox.publish(events);

      return {
        result: {
          fileObjectId,
          checksumSha256: digest,
          sizeBytes: metadata.sizeBytes,
          mimeType: session.declaredMimeType,
          scanStatus: scan.status,
          deduplicated: false,
        },
        change: this.uploaded(fileObjectId, AdministrativeOperation.UPDATED, {
          checksumSha256: digest,
          sizeBytes: metadata.sizeBytes,
          scanStatus: scan.status,
          ...(scan.threat !== null && { threat: scan.threat }),
          ...(scan.failure !== null && { scanFailure: scan.failure }),
        }),
      };
    });
    await this.removeStaged(session.targetKey);
    return completed;
  }

  async abandonUploadSession(id: UploadSessionId): Promise<void> {
    await this.writer.write(async () => {
      const session = await this.sessions.findById(id);
      if (session === null) {
        throw new NotFoundError('The requested upload');
      }
      this.refuseAnotherPersonsUpload(session);
      /*
       * A session can only be abandoned once, and only if nothing else finished it — Slice 43.
       *
       * `UploadSessionRepository.settle` has answered "was I the one to move it out of `OPEN`"
       * since Phase 3, and says why: *"a client retrying a request whose response it never saw must
       * not do either of those twice"* — the two being creating a blob and bumping a reference
       * count. All three call sites discarded that answer, and completion did not notice because it
       * refuses a non-`OPEN` session at the top. This method had no such check, so abandoning an
       * upload that had already completed returned success and wrote a `DELETED / abandoned` audit
       * row for a blob that is durable and attached — a record that materially misstates what
       * happened. Abandoning twice wrote two of them.
       *
       * The claim is the check rather than a second read of `session.state`: re-reading the row we
       * already hold would refuse the sequential case and still lose the race against a completion
       * committing beside it, which is exactly what the compare-and-set exists to decide.
       *
       * One refusal for both terminal states, and the same sentence `completeUploadSession` uses,
       * so the answer never tells a caller which of the two their identifier reached.
       */
      if (!(await this.discard(session.targetKey, id))) {
        throw new ValidationError(
          'That upload has already been finished.',
          [{ field: 'state', message: session.state }],
          { reason: ErrorReason.UPLOAD_FINISHED },
        );
      }
      return {
        result: undefined,
        change: this.uploaded(id, AdministrativeOperation.DELETED, { abandoned: true }),
      };
    });
  }

  /**
   * A short-lived, single-object URL — audited before it exists.
   *
   * The audit event is written inside the same transaction that issues the URL, and the URL is
   * built after it. A signed URL outlives the request that produced it and can be redeemed by
   * whoever holds it, so the record of who was handed one is the evidence of how bytes left; a
   * window in which one exists and nothing says so is exactly where a failure would hide
   * (`11-storage-architecture.md` §5).
   */
  async createInternalReadUrl(
    fileObjectId: FileObjectId,
    filename: string,
    options: { inline?: boolean } = {},
  ): Promise<{ url: string; expiresAt: Date }> {
    return this.writer.write<{ url: string; expiresAt: Date }>(async () => {
      const file = await this.require(fileObjectId);
      this.refuseUnreachable(file);
      await this.confirmStoredBytes(file);

      const signed = await this.storage.createDownloadUrl(file.storageKey, {
        expiresInSeconds: this.config.storage.signedUrlTtlSeconds,
        filename: sanitizeFilename(filename),
        ...(options.inline === true && { inline: true }),
      });

      return {
        result: signed,
        change: {
          action: StorageAudit.FILE_DOWNLOAD_ISSUED,
          subjectType: AuditSubjectType.FILE,
          subjectId: asId<AnyId>(fileObjectId),
          operation: AdministrativeOperation.UPDATED,
          after: {
            checksumSha256: file.checksumSha256,
            filename,
            inline: options.inline === true,
            expiresAt: signed.expiresAt.toISOString(),
          },
        },
      };
    });
  }

  /**
   * A verified download link — ADR-0026 §10, the download-integrity proposal §3.1.
   *
   * Every refusal `createInternalReadUrl` makes, in the same order, plus the size the verified path
   * stages, and the same `FILE_DOWNLOAD_ISSUED` event in the same transaction. The link is the
   * API's own (`/api/v1/downloads?token=…`): no store URL is signed, and nothing is served until
   * the bytes have been read whole and their SHA-256 matched (`VerifiedDownloadDelivery`).
   */
  async createVerifiedDownloadLink(
    fileObjectId: FileObjectId,
    filename: string,
    options: {
      readonly inline?: boolean;
      readonly subject: DownloadLinkSubject;
      readonly mimeType?: string;
      readonly audit?: Readonly<Record<string, string>>;
    },
  ): Promise<{ url: string; expiresAt: Date }> {
    const context = requireContext();
    if (context.userId === null) {
      // A link names the person it was issued to; the system has nobody to name.
      throw new ForbiddenError('download this file');
    }
    const userId = context.userId;
    return this.writer.write<{ url: string; expiresAt: Date }>(async () => {
      const file = await this.require(fileObjectId);
      this.refuseUnreachable(file);
      const limit = this.config.download.maxFileBytes;
      if (file.sizeBytes > limit) {
        throw new DownloadTooLargeError(limit, formatBytes(limit));
      }
      await this.confirmStoredBytes(file);

      const expiresAt = new Date(
        this.clock.now().getTime() + this.config.download.linkTtlSeconds * 1000,
      );
      const inline = options.inline === true;
      const token = encodeDownloadLinkToken(this.config.auth.accessSecret, {
        tenantId: String(context.tenantId),
        userId: String(userId),
        permissionVersion: context.permissionVersion,
        subject: options.subject,
        fileObjectId: String(file.id),
        disposition: inline ? 'inline' : 'attachment',
        filename: sanitizeFilename(filename),
        // The object's own type when it has one: a deduplicated blob carries whichever export
        // wrote it first, which is not necessarily this one's format (E-8).
        mimeType: options.mimeType ?? file.mimeType,
        expiresAt,
      });
      const base = (
        this.config.storage.publicUrl ?? `http://localhost:${String(this.config.app.port)}`
      ).replace(/\/$/, '');
      const url = `${base}/api/v1/${DOWNLOAD_LINK_PATH}?token=${encodeURIComponent(token)}`;

      return {
        result: { url, expiresAt },
        change: {
          action: StorageAudit.FILE_DOWNLOAD_ISSUED,
          subjectType: AuditSubjectType.FILE,
          subjectId: asId<AnyId>(fileObjectId),
          operation: AdministrativeOperation.UPDATED,
          after: {
            // Correlation first, so nothing a caller names can overwrite the facts below.
            ...options.audit,
            checksumSha256: file.checksumSha256,
            filename,
            inline,
            expiresAt: expiresAt.toISOString(),
            delivery: 'VERIFIED',
            kind: options.subject.kind,
          },
        },
      };
    });
  }

  async servable(fileObjectId: FileObjectId): Promise<FileObjectRecord> {
    return this.writer.read(async () => {
      const file = await this.require(fileObjectId);
      this.refuseUnreachable(file);
      return file;
    });
  }

  async recordIntegrityFinding(
    fileObjectId: FileObjectId,
    status: 'MISMATCH' | 'UNREADABLE',
    actualSha256: string | null,
  ): Promise<void> {
    const file = await this.writer.read(() => this.require(fileObjectId));
    await this.quarantine(file, status, actualSha256);
  }

  async recordDownloadServed(
    fileObjectId: FileObjectId,
    details: {
      readonly sizeBytes: number;
      readonly verifiedAfterMs: number;
      readonly audit?: Readonly<Record<string, string>>;
    },
  ): Promise<void> {
    // `read` + `record` rather than `write`: the bytes have already left, and a tenant made
    // read-only since must still have that fact in its trail.
    await this.writer.read(async () => {
      const file = await this.require(fileObjectId);
      await this.writer.record({
        action: StorageAudit.FILE_DOWNLOAD_SERVED,
        subjectType: AuditSubjectType.FILE,
        subjectId: asId<AnyId>(fileObjectId),
        operation: AdministrativeOperation.UPDATED,
        after: {
          // Correlation first, so nothing a redeemer names can overwrite the facts below.
          ...details.audit,
          checksumSha256: file.checksumSha256,
          sizeBytes: details.sizeBytes,
          verifiedAfterMs: details.verifiedAfterMs,
        },
      });
    });
  }

  async isReachable(fileObjectId: FileObjectId): Promise<boolean> {
    const file = await this.files.findById(fileObjectId);
    // The download gate's own predicate, so "may this be served" has one answer wherever it is
    // asked. `UNVERIFIED` passes: it is the state of every blob the verifier has not reached yet.
    return file !== null && unreachableBecause(file) === null;
  }

  /**
   * One pass of the rolling verifier — `storage.verify-integrity`, Phase 18.
   *
   * 17 §8 has promised "a rolling verifier plus verification on every preview fetch; mismatch
   * quarantines and raises an incident" since Phase 0, and 13 §2 has carried `INTEGRITY_MISMATCH`
   * with the note "Phase 18 — the integrity sweep that would detect one". This is that sweep.
   *
   * ## The three decisions in it
   *
   * **A pass carries no cursor.** The page is ordered by the column the pass writes, nulls first,
   * so a blob checked now sorts to the end and the next call naturally takes the next set. A
   * crashed pass loses nothing and resumes nowhere in particular, which is the point: there is no
   * stored position for a restore or a failover to disagree with.
   *
   * **A verified blob writes no audit row.** One row per blob per pass would put millions of
   * chained, retention-governed events into the trail to say that nothing happened — the same
   * argument 13 §2 makes for not auditing favourites, at a far larger scale. What is recorded is
   * the *finding*, on the row, where the next pass reads it. Only a mismatch is an event.
   *
   * **Only a finding quarantines** — ADR-0026 §10. Bytes read back with another digest, or an
   * object the store says is absent on two looks, are findings. A blob too large to read and a read
   * that failed (a store error, a timeout, a store out of reach) are not: they record that the blob
   * is not verified now, and leave a quarantine already in place as it was. A failed read was once
   * indistinguishable from an absent object, so one store outage quarantined every blob it touched.
   *
   * **The read is bounded, and a blob too large to read is marked checked anyway.**
   * `StoragePort.read` returns a whole `Buffer` — there is no streaming read on the port — so a
   * 2 GB scan would be 2 GB of process memory, which is exactly what 19 §5 forbids of a background
   * lane. Blobs above the bound are skipped, and their `integrity_checked_at` is stamped even
   * though their status stays `UNVERIFIED`: without that stamp the ordering would return the same
   * unreadable-to-us blobs on every pass for ever, and the sweep would never reach anything else.
   * The report names the streaming read as what closes it.
   */
  async verifyIntegrity(): Promise<IntegritySweepResult> {
    const page = await this.writer.read(() =>
      this.files.listForIntegrityCheck(this.config.storage.integrityBatchSize),
    );
    const result = {
      checked: 0,
      verified: 0,
      mismatched: 0,
      unreadable: 0,
      inconclusive: 0,
      tooLarge: 0,
    };

    for (const file of page) {
      // Outside any transaction: this is a network read of somebody else's object store, and
      // holding a database transaction open across it would put an object store's latency in
      // front of every other write in the tenant.
      const reading = await this.rehash(file);
      result.checked += 1;

      switch (reading.kind) {
        case 'read': {
          const status =
            reading.sha256 === file.checksumSha256
              ? IntegrityStatus.VERIFIED
              : IntegrityStatus.MISMATCH;
          if (status === IntegrityStatus.VERIFIED) {
            result.verified += 1;
            await this.recordIntegrity(file, status);
          } else {
            result.mismatched += 1;
            await this.quarantine(file, status, reading.sha256);
          }
          break;
        }
        case 'absent':
          result.unreadable += 1;
          await this.quarantine(file, IntegrityStatus.UNREADABLE, null);
          break;
        case 'too-large':
          result.tooLarge += 1;
          await this.recordIntegrity(file, notVerifiedNow(file.integrityStatus));
          break;
        case 'inconclusive':
          result.inconclusive += 1;
          await this.recordIntegrity(file, notVerifiedNow(file.integrityStatus));
          break;
      }
    }

    return result;
  }

  /**
   * Removes objects nothing refers to — ADR-0026 §10, Phase A.
   *
   * Phase A left two kinds behind. A completion interrupted after its copy (eight were, when the
   * API was killed) left the content key holding bytes no row names. A transfer that outlasted its
   * link and the expiry sweep left staged bytes whose session was already `EXPIRED`, which that
   * sweep — it looks only at `OPEN` sessions — never visits again. This finds both, by listing
   * the two prefixes this module writes uploads to and asking the database about each key.
   *
   * ## What keeps an object
   *
   * - **A reference.** Staged bytes are kept while their session is `OPEN` (the expiry sweep owns
   *   those). A content key is kept while *any* row names it — live or deleted.
   * - **Youth.** Anything younger than `STORAGE_ORPHAN_GRACE_SECONDS` is left alone, because a
   *   completion copies its bytes before it writes the row naming them; configuration refuses a
   *   grace shorter than the longest a completion can take.
   * - **A second look.** Immediately before a delete, the reference and the object's age are
   *   asked again, so a completion or a re-upload that arrived during the pass is not undone.
   * - **Not being ours.** Only keys of exactly the two shapes this module writes are considered;
   *   anything else under the prefixes is counted and never touched. Derived and evidence objects
   *   live elsewhere and are not listed.
   *
   * Idempotent — a second pass finds nothing the first removed — and safe to stop at any point.
   * `STORAGE_ORPHAN_SWEEP_DRY_RUN` reports the same findings and removes nothing.
   */
  async sweepOrphanedObjects(): Promise<OrphanSweepResult> {
    const dryRun = this.config.storage.orphanSweepDryRun;
    const graceSeconds = this.config.storage.orphanGraceSeconds;
    const orphanedKeys: string[] = [];

    const staging = await this.sweepArea(STAGING_PREFIX, graceSeconds, dryRun, orphanedKeys, {
      recognised: (key) => stagingSessionOf(key) !== null,
      referenced: async (key) => {
        const id = stagingSessionOf(key) as string;
        const session = await this.writer.read(() =>
          this.sessions.findById(asId<UploadSessionId>(id)),
        );
        return session !== null && session.state === UploadSessionState.OPEN;
      },
    });
    const blobs = await this.sweepArea(BLOB_PREFIX, graceSeconds, dryRun, orphanedKeys, {
      recognised: isBlobKey,
      referenced: (key) => this.writer.read(() => this.files.referencesStorageKey(key)),
    });

    return { dryRun, graceSeconds, staging, blobs, orphanedKeys };
  }

  get(fileObjectId: FileObjectId): Promise<FileObjectRecord | null> {
    return this.files.findById(fileObjectId);
  }

  async reference(fileObjectId: FileObjectId): Promise<void> {
    await this.files.adjustRefCount(fileObjectId, 1);
  }

  async dereference(fileObjectId: FileObjectId): Promise<void> {
    await this.files.adjustRefCount(fileObjectId, -1);
  }

  /**
   * Bytes the API produced itself — a thumbnail now, a rendition in Phase 7.
   *
   * The one path where content passes through the process, and it is unavoidable: there is no
   * client to presign a target for something the server made. It goes through the same content
   * addressing and the same deduplication as anything else, so two documents with the same first
   * page share one thumbnail. It is *not* scanned: the product generated it, and running an
   * antivirus pass over the output of a renderer the product also wrote would be theatre.
   */
  async storeDerived(input: { content: Buffer; mimeType: string }): Promise<FileObjectRecord> {
    const digest = createHash('sha256').update(input.content).digest('hex');

    return this.writer.write<FileObjectRecord>(async () => {
      const existing = await this.files.findByChecksum(digest);
      if (existing !== null) {
        return {
          result: existing,
          change: this.uploaded(existing.id, AdministrativeOperation.UPDATED, {
            derived: true,
            deduplicated: true,
          }),
        };
      }

      const key = derivedKeyFor(digest);
      const target = await this.storage.createUploadTarget({
        key,
        contentType: input.mimeType,
        sizeBytes: input.content.length,
        expiresInSeconds: this.config.storage.signedUrlTtlSeconds,
        checksumSha256: digest,
      });
      // The API redeems the target it was just issued, which is the same path a browser takes. It
      // is not a short cut around presigning: writing straight to the store would mean a second
      // code path per driver, and the second path is the one nobody exercises.
      const response = await fetch(target.url, {
        method: target.method,
        headers: { ...target.headers },
        body: new Uint8Array(input.content),
      });
      if (!response.ok) {
        throw new UnsupportedContentError('The rendered artefact could not be stored.');
      }

      const id = this.writer.clock.nextId();
      const created = await this.files.insert({
        id,
        checksumSha256: digest,
        sizeBytes: input.content.length,
        mimeType: input.mimeType,
        storageKey: key,
        storageDriver: this.storage.driver,
        // Derived content is clean by construction: the product made it from bytes that had
        // already passed the gate.
        scanStatus: ScanStatus.SKIPPED,
        scanner: null,
        scanThreat: null,
        derived: true,
      });
      if (!created) {
        // Two renders of the same artefact finishing together — the read above and the insert are
        // the same question asked at two moments, and the render sits between them. The winner's
        // row is the answer this call already gives when the digest was there first, so take it
        // rather than reading back an id that was never written.
        return this.deduplicatedDerived(digest, { derived: true });
      }

      const stored = await this.require(asId<FileObjectId>(id));
      return {
        result: stored,
        change: this.uploaded(id, AdministrativeOperation.CREATED, {
          derived: true,
          sizeBytes: input.content.length,
          mimeType: input.mimeType,
        }),
      };
    });
  }

  /**
   * An artefact streamed straight to the store, never held whole.
   *
   * The write happens *before* the transaction, not inside it, and that is the one thing worth
   * reading carefully here. A multi-minute upload inside a database transaction would hold a
   * connection and its snapshot open for the duration, which at the `audit.export` lane's
   * fifteen-minute budget is long enough to matter to every other writer in the tenant. The
   * ordering is safe because the failure it risks is benign in exactly one direction: bytes in
   * the store with no row are unreferenced and expire with their prefix, while a row with no
   * bytes would be a bundle somebody could ask for and never receive.
   */
  async storeStreamed(input: {
    bundleId: string;
    name: string;
    body: AsyncIterable<Uint8Array>;
    mimeType: string;
  }): Promise<FileObjectRecord> {
    const stored = await this.storage.put(evidenceKeyFor(input.bundleId, input.name), input.body, {
      contentType: input.mimeType,
    });
    const checksumSha256 = stored.checksumSha256;
    if (checksumSha256 === null) {
      // Every adapter computes it while streaming, so reaching here means a driver was added
      // that does not — and a file object with no digest is one nothing can ever verify.
      throw new StorageUnavailableError('The artefact was stored without a digest.');
    }

    // **Deduplicated, like every other blob in this product** — Phase 15's correction.
    //
    // ADR-0007 makes blobs content-addressed and `uq_file_object_checksum` enforces one live row
    // per digest per tenant, and the *upload* path has honoured that since Phase 3 (`alreadyStored`).
    // This path did not, and nothing noticed for six phases because Phase 9's artefacts can never
    // collide: an evidence manifest names its own export identifier, so two bundles differ in their
    // bytes by construction. A report export has no such field — the same report, run twice by the
    // same person, is byte-for-byte identical — and it hit the unique index on the second run.
    //
    // Returning the existing row is what content addressing *means*: the bytes are the same bytes,
    // and the download names its own filename, so nothing about the second export is misdescribed.
    // The object just written under this artefact's own key is left unreferenced, which is the same
    // benign direction the comment above describes and the same class of leftover an interrupted
    // upload produces.
    const existing = await this.writer.read(() => this.files.findByChecksum(checksumSha256));
    if (existing !== null) {
      return existing;
    }

    return this.writer.write<FileObjectRecord>(async () => {
      const id = this.writer.clock.nextId();
      const created = await this.files.insert({
        id,
        // The store's own answer for the size, and our own for the digest — computed over the
        // bytes as they went past rather than read back, because reading it back would attest
        // what the store returned rather than what was written.
        checksumSha256,
        sizeBytes: stored.sizeBytes,
        mimeType: input.mimeType,
        storageKey: stored.key,
        storageDriver: this.storage.driver,
        // Made by the product from bytes that were already in the database. Nothing to scan.
        scanStatus: ScanStatus.SKIPPED,
        scanner: null,
        scanThreat: null,
        derived: true,
      });
      if (!created) {
        // The same export, run twice, finishing at the same time. The read above already returns
        // the winner's row when it got there first; arriving together must not answer differently.
        return this.deduplicatedDerived(checksumSha256, { derived: true, streamed: true });
      }

      const record = await this.require(asId<FileObjectId>(id));
      return {
        result: record,
        change: this.uploaded(id, AdministrativeOperation.CREATED, {
          derived: true,
          streamed: true,
          sizeBytes: stored.sizeBytes,
          mimeType: input.mimeType,
        }),
      };
    });
  }

  /**
   * Where a bundle's artefacts live.
   *
   * Storage answers this rather than the caller building it, for the reason no caller builds any
   * other key here: a key assembled outside this module is a second place the layout is written
   * down, and the boundary lint would have to be argued with rather than obeyed.
   */
  evidencePrefix(bundleId: string): string {
    return evidencePrefixFor(bundleId);
  }

  // --- Internals ---------------------------------------------------------------------------

  /**
   * The malware gate.
   *
   * Synchronous, and that is the Phase 3 shape rather than the final one: the architecture puts
   * scanning on a worker fed by the outbox, so a 2 GB upload does not hold a request open. Until
   * the dispatcher exists there is nothing to feed, and a blob left `PENDING` forever would be a
   * blob nothing can ever attach — an upload path that silently produces unusable documents.
   *
   * Three outcomes, and only one of them reachable — RC D-3:
   *
   * - **A verdict.** `CLEAN` or `INFECTED`, from a configured scanner. Nothing else an adapter
   *   returns is accepted as one.
   * - **`FAILED`.** A configured scanner was asked and gave no verdict (`AntivirusScanError`:
   *   unreachable, timed out, an error, an answer that is not a verdict). The reason is kept for the
   *   audit record; the client is told only the status.
   * - **`SKIPPED`.** No scanner is configured (`AV_DRIVER=NONE`, which production refuses at boot),
   *   or anything else went wrong that is not the scanner's to report. A development environment
   *   can upload; nothing can pretend the gate ran.
   *
   * Neither failure is ever `CLEAN`, and a blob in either state recovers by being uploaded again —
   * `settleVerdict` scans it then.
   */
  private async scan(
    key: string,
    checksumSha256: string,
    sizeBytes: number,
    mimeType: string,
  ): Promise<ScanOutcome> {
    // Outside the `try`, so it can never be mistaken for a scanner failure: a scan inside a
    // database transaction is the defect STG-1 found — the transaction's own 5 s timeout, not
    // `AV_SCAN_TIMEOUT_MS`, would decide how long the scanner may take.
    if (currentTransaction() !== null) {
      throw new Error('A malware scan must not run inside a database transaction (STG-1).');
    }
    try {
      const verdict = await this.antivirus.scan({
        storageKey: key,
        checksumSha256,
        sizeBytes,
        declaredMimeType: mimeType,
        timeoutMs: this.config.antivirus.timeoutMs,
      });
      if (verdict.status !== ScanStatus.CLEAN && verdict.status !== ScanStatus.INFECTED) {
        return { status: ScanStatus.FAILED, scanner: null, threat: null, failure: 'NOT_A_VERDICT' };
      }
      return {
        status: verdict.status,
        scanner: verdict.scanner,
        threat: verdict.status === ScanStatus.INFECTED ? (verdict.threat ?? 'unnamed') : null,
        failure: null,
      };
    } catch (error) {
      // Never `CLEAN`. A scanner that could not be reached has not cleared anything, and the one
      // failure mode this product must not have is an environment where "upload works" means "the
      // gate is off" (`17-security-architecture.md` §10).
      if (error instanceof AntivirusScanError) {
        return { status: ScanStatus.FAILED, scanner: null, threat: null, failure: error.reason };
      }
      return { status: ScanStatus.SKIPPED, scanner: null, threat: null, failure: null };
    }
  }

  /**
   * Scans a stored blob that has no verdict yet, when somebody offers its bytes again — RC D-3.
   *
   * A blob recorded `FAILED` (the scanner was down) or `SKIPPED` (no scanner was configured when it
   * arrived) could otherwise never become `CLEAN`: every later upload of the same bytes deduplicates
   * onto it, and nothing else scans. Re-uploading is what a person does when a file is refused, so
   * that is where it recovers. Answers `null` for a blob that already has a verdict, or that the
   * product made itself — nothing to scan.
   *
   * **Called outside any transaction** — STG-1. The verdict it returns is recorded afterwards, in a
   * short transaction, by `settleVerdict`; the verdict carries the digest it was computed for, and
   * the adapter refuses bytes that do not hash to that digest, so it cannot be about other bytes.
   */
  private async verdictFor(existing: FileObjectRecord): Promise<KnownVerdict | null> {
    const unverdicted =
      existing.scanStatus === ScanStatus.FAILED || existing.scanStatus === ScanStatus.SKIPPED;
    if (existing.derived || !unverdicted) {
      return null;
    }
    return {
      checksumSha256: existing.checksumSha256,
      outcome: await this.withScanCapacity(existing.sizeBytes, () =>
        this.scan(
          existing.storageKey,
          existing.checksumSha256,
          existing.sizeBytes,
          existing.mimeType,
        ),
      ),
    };
  }

  /**
   * Runs work that reads content into memory for a scan, within `AV_SCAN_BUDGET_BYTES`.
   *
   * Phase A (ADR-0026 §10): a scan holds its whole object in memory, and eight ~120 MiB completions
   * at once got the API killed inside its 1.5 GB limit. Admission waits, first come first served,
   * for the bytes to fit; a wait past `AV_SCAN_QUEUE_TIMEOUT_MS` is refused as busy before any of
   * the work has started.
   */
  private async withScanCapacity<T>(sizeBytes: number, work: () => Promise<T>): Promise<T> {
    try {
      return await this.scanCapacity.run(sizeBytes, this.config.antivirus.queueTimeoutMs, work);
    } catch (error) {
      if (error instanceof ByteBudgetTimeoutError) {
        throw new ScannerBusyError();
      }
      throw error;
    }
  }

  /**
   * Records a verdict obtained outside the transaction on a blob that had none — RC D-3, STG-1.
   *
   * Never scans: it runs inside the caller's transaction, and a scan there is STG-1. `known` is
   * applied only if it is a real verdict (`CLEAN` or `INFECTED`) for **this row's digest** — a
   * verdict about other bytes is never recorded here, whatever raced in between.
   *
   * The write is `recordScan`'s compare-and-set from `FAILED`/`SKIPPED` only, so a blob that has a
   * verdict is never re-marked — an `INFECTED` blob in particular never becomes `CLEAN` this way —
   * and two uploads racing here converge on one verdict, with one set of events. A product-made
   * artefact is `SKIPPED` by construction and is left alone.
   */
  private async settleVerdict(
    existing: FileObjectRecord,
    known: KnownVerdict | null,
  ): Promise<{ file: FileObjectRecord; rescan: Readonly<Record<string, unknown>> }> {
    const unverdicted =
      existing.scanStatus === ScanStatus.FAILED || existing.scanStatus === ScanStatus.SKIPPED;
    if (existing.derived || !unverdicted) {
      return { file: existing, rescan: {} };
    }
    if (known === null || known.checksumSha256 !== existing.checksumSha256) {
      return { file: existing, rescan: {} };
    }
    const scan = known.outcome;
    if (scan.status !== ScanStatus.CLEAN && scan.status !== ScanStatus.INFECTED) {
      return { file: existing, rescan: {} };
    }
    const moved = await this.files.recordScan(
      existing.id,
      {
        status: scan.status,
        scanner: scan.scanner ?? this.antivirus.scanner,
        threat: scan.threat,
        at: this.clock.now(),
      },
      [ScanStatus.FAILED, ScanStatus.SKIPPED],
    );
    if (!moved) {
      // Somebody else's verdict landed first. Theirs is the verdict; read it rather than assume.
      return { file: (await this.files.findById(existing.id)) ?? existing, rescan: {} };
    }
    const events: DomainEventDraft[] = [
      fileScanCompletedEvent(asId<AnyId>(existing.id), {
        fileObjectId: existing.id,
        status: scan.status,
        scanner: scan.scanner ?? 'none',
      }),
    ];
    if (scan.status === ScanStatus.INFECTED) {
      events.push(
        fileQuarantinedEvent(asId<AnyId>(existing.id), {
          fileObjectId: existing.id,
          threat: scan.threat ?? 'unnamed',
          uploadedBy: requireContext().userId ?? 'system',
        }),
      );
    }
    await this.outbox.publish(events);
    return {
      file: { ...existing, scanStatus: scan.status, scanThreat: scan.threat },
      rescan: {
        rescanned: { from: existing.scanStatus, to: scan.status },
        ...(scan.threat !== null && { threat: scan.threat }),
      },
    };
  }

  /**
   * Reads a blob back and re-hashes it, saying which of four things happened — ADR-0026 §10.
   *
   * Only `read` (with whatever digest it gave) and `absent` are findings. `absent` needs the store to
   * say "no such object" twice — to the read, and then to a HEAD — so an object that is merely slow
   * to appear, or a store that answered one request wrongly, is not an incident.
   */
  private async rehash(file: FileObjectRecord): Promise<IntegrityReading> {
    if (file.sizeBytes > this.config.storage.integrityMaxBytes) {
      return { kind: 'too-large' };
    }
    let bytes: Buffer | null;
    try {
      // Within the same byte budget as scans: this read holds the whole object too, and the
      // verifier runs beside live completions. It is background work, so it may wait far longer
      // than a request; a wait that still runs out ends the pass (it runs again) rather than being
      // mistaken below for an unreadable object.
      bytes = await this.scanCapacity.run(file.sizeBytes, VERIFIER_CAPACITY_WAIT_MS, () =>
        this.storage.read(file.storageKey),
      );
    } catch (error) {
      if (error instanceof ByteBudgetTimeoutError) {
        throw error;
      }
      // A store that is briefly unreachable must not quarantine a tenant's library.
      return { kind: 'inconclusive' };
    }
    if (bytes !== null) {
      return { kind: 'read', sha256: createHash('sha256').update(bytes).digest('hex') };
    }
    try {
      return (await this.storage.head(file.storageKey)) === null
        ? { kind: 'absent' }
        : { kind: 'inconclusive' };
    } catch {
      return { kind: 'inconclusive' };
    }
  }

  /** Stamps what one pass found, outside the caller's transaction; never a quarantine. */
  private async recordIntegrity(file: FileObjectRecord, status: IntegrityStatusKey): Promise<void> {
    await this.writer.read(() =>
      this.files.recordIntegrity(file.id, { status, at: this.clock.now() }),
    );
  }

  /**
   * Records the finding, quarantines the blob and raises the incident.
   *
   * One transaction: the row, the audit event and the outbox row commit together, so there is no
   * state in which a blob is quarantined and nothing says why — which is the state an operator
   * would find during the incident and be unable to explain.
   */
  private async quarantine(
    file: FileObjectRecord,
    status: IntegrityStatusKey,
    actual: string | null,
  ): Promise<void> {
    await this.writer.write(async () => {
      await this.files.recordIntegrity(file.id, { status, at: this.clock.now() });
      await this.outbox.publish([
        fileIntegrityMismatchEvent(asId<AnyId>(String(file.id)), {
          fileObjectId: String(file.id),
          expectedSha256: file.checksumSha256,
          actualSha256: actual,
          storageKey: file.storageKey,
          storageDriver: file.storageDriver,
        }),
      ]);
      return {
        result: undefined,
        change: {
          action: StorageAudit.INTEGRITY_MISMATCH,
          subjectType: AuditSubjectType.FILE,
          subjectId: asId<AnyId>(String(file.id)),
          operation: AdministrativeOperation.UPDATED,
          // The outcome is the finding, not the pass: the sweep worked and the blob is wrong, and
          // an auditor filtering the trail for failures must find this row.
          outcome: AuditOutcome.FAILED,
          after: {
            integrityStatus: status,
            expectedSha256: file.checksumSha256,
            actualSha256: actual,
            storageDriver: file.storageDriver,
          },
        },
      };
    });
  }

  /**
   * Refuses a completed transfer whose bytes are not the ones approved, removing what arrived.
   *
   * The session is settled `ABORTED` in a transaction of its own that commits before the refusal is
   * thrown, and only the caller that won that claim deletes the staged bytes.
   */
  private async refuseTransfer(session: UploadSessionRecord, refusal: Error): Promise<never> {
    // The claim is committed on its own, *then* the refusal is thrown — ADR-0026 §10, Phase A.
    // Thrown inside the claim's transaction it rolled the claim back, so a refused upload stayed
    // `OPEN` with its bytes already deleted until the expiry sweep found it. Now it is `ABORTED`
    // at once, and a second completion is told it is finished rather than tried again.
    const claimed = await this.writer.change(() =>
      this.sessions.settle(session.id, UploadSessionState.ABORTED, null),
    );
    if (claimed) {
      await this.removeStaged(session.targetKey);
    }
    throw refusal;
  }

  /**
   * Completion found no bytes under the session's key.
   *
   * After the link expired they can no longer arrive, so the session is settled `EXPIRED` and the
   * caller is told to start again. Before then the transfer may still be running, so nothing is
   * settled and completing again once it has finished succeeds.
   */
  private async refuseMissingBytes(session: UploadSessionRecord): Promise<never> {
    if (session.expiresAt.getTime() > this.clock.now().getTime()) {
      throw new UploadNotReceivedError();
    }
    await this.writer.change(() =>
      this.sessions.settle(session.id, UploadSessionState.EXPIRED, null),
    );
    throw new UploadExpiredError();
  }

  /**
   * Asks the store about the object before a link to it is signed — ADR-0026 §10, Phase A.
   *
   * Phase A showed the gate trusting the row: until the nightly verifier ran, a link was signed for
   * an object somebody had overwritten (it served the other bytes) or deleted (it answered 404).
   * One `HEAD` now stands between the row and the link, with no read of the content and no
   * buffer — the link is signed only if the store still holds what the row describes:
   *
   * - **Absent** — refused.
   * - **A different size** — refused.
   * - **A SHA-256 recorded by the store** (every upload: the digest is signed into its PUT, and a
   *   copy keeps it) — it must be this row's digest. An overwrite either carries its own digest,
   *   which differs, or none, which is the next case.
   * - **No SHA-256** (a streamed export; an object restored or rewritten by a plain write) — the
   *   object must not have been written after the last moment the product vouched for its bytes:
   *   the row's creation, or the verifier's last successful re-hash. A store's clock and ours may
   *   differ, so a few minutes of skew are allowed.
   *
   * What it does not close: the link outlives this check by its TTL, and bytes swapped within
   * that window would be served. A store's own record of a digest is also not a re-hash — bit
   * rot under an intact record is the rolling verifier's to find. The refusal is not recorded
   * here: this runs inside the caller's transaction, which a refusal rolls back, so the verifier
   * records the finding on its next pass.
   */
  private async confirmStoredBytes(file: FileObjectRecord): Promise<void> {
    const stored = await this.storage.head(file.storageKey);
    if (stored === null) {
      throw new ContentQuarantinedError(IntegrityStatus.UNREADABLE);
    }
    const vouchedAt = Math.max(
      file.createdAt.getTime(),
      file.integrityStatus === IntegrityStatus.VERIFIED && file.integrityCheckedAt !== null
        ? file.integrityCheckedAt.getTime()
        : 0,
    );
    const unchanged =
      stored.sizeBytes === file.sizeBytes &&
      (stored.checksumSha256 !== null
        ? stored.checksumSha256 === file.checksumSha256
        : stored.lastModifiedAt.getTime() <= vouchedAt + STORE_CLOCK_SKEW_MS);
    if (!unchanged) {
      throw new ContentQuarantinedError(IntegrityStatus.MISMATCH);
    }
  }

  /** One prefix of the orphan sweep: list, classify, re-check, remove. */
  private async sweepArea(
    prefix: string,
    graceSeconds: number,
    dryRun: boolean,
    orphanedKeys: string[],
    rules: {
      readonly recognised: (key: string) => boolean;
      readonly referenced: (key: string) => Promise<boolean>;
    },
  ): Promise<OrphanSweepArea> {
    const area = { listed: 0, referenced: 0, recent: 0, unrecognised: 0, orphaned: 0 };
    const keys = await this.storage.list(prefix);
    const olderThanGrace = async (key: string): Promise<boolean | null> => {
      const metadata = await this.storage.head(key);
      if (metadata === null) {
        return null;
      }
      return this.clock.now().getTime() - metadata.lastModifiedAt.getTime() >= graceSeconds * 1000;
    };

    for (const key of keys) {
      area.listed += 1;
      if (!rules.recognised(key)) {
        area.unrecognised += 1;
        continue;
      }
      if (await rules.referenced(key)) {
        area.referenced += 1;
        continue;
      }
      const old = await olderThanGrace(key);
      if (old === null) {
        // Gone since the listing — removed by somebody else, which is what was wanted.
        continue;
      }
      if (!old) {
        area.recent += 1;
        continue;
      }
      // The second look, as late as possible: a re-upload of the same bytes during the pass has
      // refreshed the object by now, and a completion has written its row. The reference is asked
      // last, immediately before the delete.
      if ((await olderThanGrace(key)) !== true) {
        area.recent += 1;
        continue;
      }
      if (await rules.referenced(key)) {
        area.referenced += 1;
        continue;
      }
      area.orphaned += 1;
      orphanedKeys.push(key);
      if (!dryRun) {
        await this.storage.delete(key);
      }
    }
    return area;
  }

  /**
   * Removes a session's staged bytes once nothing needs them, as best it can.
   *
   * A failure here is not the caller's failure — the upload has already been recorded or refused —
   * and the object is not lost track of: the orphan sweep removes staged bytes whose session is
   * no longer `OPEN` (`sweepOrphanedObjects`).
   */
  private async removeStaged(key: string): Promise<void> {
    try {
      await this.storage.delete(key);
    } catch {
      // Left for the orphan sweep; see above.
    }
  }

  /**
   * Aborts a session and removes what it staged. Answers whether it was the one to abort it.
   *
   * **The claim comes first** — Slice 43. `settle` carries `state: OPEN` in its predicate, which is
   * what makes it a compare-and-set rather than an assignment, and taking it before touching the
   * store is what stops an abandon from deleting bytes a completion running beside it is still
   * copying. The order was the other way round, which was safe only because nothing read the
   * answer. Used by `abandonUploadSession`, whose transaction commits the claim.
   */
  private async discard(key: string, id: UploadSessionId): Promise<boolean> {
    const claimed = await this.sessions.settle(id, UploadSessionState.ABORTED, null);
    if (claimed) {
      await this.storage.delete(key);
    }
    return claimed;
  }

  private async require(id: FileObjectId): Promise<FileObjectRecord> {
    const file = await this.files.findById(id);
    if (file === null) {
      throw new NotFoundError('The requested file');
    }
    return file;
  }

  private refuseUnreachable(file: FileObjectRecord): void {
    // Refused before anything is signed. The scan comes first — a file the product generated is
    // `SKIPPED` by construction and passes that half, anything a person uploaded needs `CLEAN` —
    // and then the integrity finding: a blob the verifier found changed or missing is quarantined
    // until a successful re-read clears it (`domain/reachability.ts`).
    const refusal = unreachableBecause(file);
    if (refusal === null) {
      return;
    }
    if (refusal.reason === 'SCAN') {
      throw new ContentNotScannedError(refusal.scanStatus);
    }
    throw new ContentQuarantinedError(refusal.integrityStatus);
  }

  private policy() {
    // The deployment's ceiling is the outer bound. A tenant narrowing it further is settings work
    // that belongs with the rest of the tenant's configuration, and `narrowPolicy` is the seam it
    // will attach to — it can only ever restrict what is here.
    return narrowPolicy(defaultUploadPolicy(this.maxUploadBytes()), {});
  }

  /**
   * The deployment's ceiling, lowered to what the scanner will be sent — RC D-3.
   *
   * Under `AV_DRIVER=ICAP` anything above `AV_ICAP_MAX_BYTES` would be stored, fail its scan and
   * never be fileable. Refusing it here keeps this class's first promise: nothing is stored to find
   * out it is refused.
   */
  private maxUploadBytes(): number {
    const ceiling = this.config.storage.maxUploadBytes;
    return this.config.providers.antivirus === 'ICAP'
      ? Math.min(ceiling, this.config.antivirus.maxBytes)
      : ceiling;
  }

  /**
   * An upload session belongs to whoever opened it — Slice 42.
   *
   * `created_by` has been on the row since Phase 3, written by `RecordStamps.creation()` like every
   * other actor column, and `UploadSessionRecord` has carried it to this class the whole time.
   * Nothing read it. Both routes that act on a session — completing it and abandoning it — resolved
   * it by identifier alone, so `document:create` plus somebody else's session identifier was enough
   * to finish their upload and be handed the `fileObjectId` for bytes this caller never sent, with
   * the blob's own audit row naming them as the uploader; or to abandon it and destroy a transfer
   * in flight.
   *
   * The identifier is a `uuidv7` returned only to its creator while the session is open, so this
   * was a trap rather than an open door. That is the same standing Slice 24 gave the resolver's
   * supplied-subject list, and the same answer: an authenticated, permission-gated route that acts
   * on an object should check that the actor may act on *that* object, rather than rely on the
   * identifier being hard to learn.
   *
   * A null `created_by` is not refused. The column is nullable because a system context has no
   * actor, and a row written before this check existed carries nothing to compare — refusing those
   * would break an upload in flight across a deployment for no gain, and they age out with the
   * session's own expiry.
   */
  /**
   * The session was still ours to finish — Slice 44.
   *
   * `settle` carries `state: OPEN` in its predicate, and the answer is the only thing that can tell
   * this method the row moved while it worked. The check at the top of `completeUploadSession` runs
   * *before* the promotion — `completeUpload`, the digest read, the copy, the scan, the insert —
   * and `storage.sweep-upload-sessions` runs every fifteen minutes against anything still `OPEN`
   * past its deadline, which is exactly a session whose completion is in flight. Without this the
   * reaper stamped `EXPIRED`, the completion committed a durable `file_object` anyway and answered
   * with its identifier, and the row was left saying the upload never finished.
   *
   * Throwing rather than forcing the state: the session really was taken away, and refusing is what
   * this method already answers for a session it cannot have. The rollback takes the blob with it —
   * the bytes copied to the content key become an unreferenced object, which is the direction
   * `storeStreamed` already calls benign and which the blob sweep collects.
   *
   * The payload does not repeat `session.state`, because the state this read at the top is no
   * longer the state the row is in; saying "not open" is the whole of what is known here.
   */
  /**
   * This session finished onto a blob somebody else stored.
   *
   * One shape for both ways of reaching it — the digest already existed when this transaction
   * looked, or it appeared while this transaction worked. The session still settles, so a caller
   * who lost the race is not left holding an `OPEN` row, and the audit records the upload against
   * the blob it actually resolved to.
   */
  private async deduplicatedOnto(
    found: FileObjectRecord,
    id: UploadSessionId,
    known: KnownVerdict | null,
  ) {
    this.requireClaimed(await this.sessions.settle(id, UploadSessionState.COMPLETED, found.id));
    const { file: existing, rescan } = await this.settleVerdict(found, known);
    return {
      result: {
        fileObjectId: existing.id,
        checksumSha256: existing.checksumSha256,
        sizeBytes: existing.sizeBytes,
        mimeType: existing.mimeType,
        scanStatus: existing.scanStatus,
        deduplicated: true,
      },
      change: this.uploaded(existing.id, AdministrativeOperation.UPDATED, {
        deduplicated: true,
        uploadSessionId: id,
        ...rescan,
      }),
    };
  }

  /**
   * The winner's row, for a derived artefact whose insert lost the race — Slice 46.
   *
   * `insert` tolerates the conflict rather than raising it, so a loser must resolve the winner
   * instead of reading back an id that was never written. The outcome is deliberately the one each
   * caller's own `findByChecksum` branch already gives when the digest was simply there first:
   * arriving together must not answer differently from arriving second.
   */
  private async deduplicatedDerived(digest: string, facts: Readonly<Record<string, unknown>>) {
    const winner = await this.files.findByChecksum(digest);
    if (winner === null) {
      throw new StorageUnavailableError('The artefact could not be stored.');
    }
    return {
      result: winner,
      change: this.uploaded(winner.id, AdministrativeOperation.UPDATED, {
        ...facts,
        deduplicated: true,
      }),
    };
  }

  private requireClaimed(claimed: boolean): void {
    if (!claimed) {
      throw new ValidationError(
        'That upload has already been finished.',
        [{ field: 'state', message: 'not open' }],
        { reason: ErrorReason.UPLOAD_FINISHED },
      );
    }
  }

  private refuseAnotherPersonsUpload(session: UploadSessionRecord): void {
    const { userId } = requireContext();
    if (session.createdBy !== null && session.createdBy !== userId) {
      throw new ForbiddenError('act on an upload somebody else started');
    }
  }

  private expiry(): Date {
    return new Date(this.clock.now().getTime() + this.config.storage.signedUrlTtlSeconds * 1000);
  }

  private uploaded(
    subjectId: string,
    operation: (typeof AdministrativeOperation)[keyof typeof AdministrativeOperation],
    after: Readonly<Record<string, unknown>>,
  ) {
    return {
      action: StorageAudit.FILE_UPLOADED,
      subjectType: AuditSubjectType.FILE,
      subjectId: asId<AnyId>(subjectId),
      operation,
      after,
    };
  }
}

/** What one re-read of a blob came to. Only `read` and `absent` are findings. */
type IntegrityReading =
  | { readonly kind: 'read'; readonly sha256: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'too-large' }
  | { readonly kind: 'inconclusive' };

/**
 * The status to record when a pass could not look at a blob — ADR-0026 §10.
 *
 * Not a finding, so it never quarantines; and never a release from quarantine, so a blob already
 * found MISMATCH or UNREADABLE stays so until a read shows the original bytes again. Otherwise
 * `UNVERIFIED`, also over an earlier `VERIFIED`: the stamp moves the ordering past the blob, and a
 * `VERIFIED` stamped now would vouch for bytes this pass never read (the download gate trusts an
 * object no newer than its last verification).
 */
function notVerifiedNow(current: IntegrityStatusKey): IntegrityStatusKey {
  return isServableIntegrity(current) ? IntegrityStatus.UNVERIFIED : current;
}

/** What one scan came to. `failure` is why a configured scanner gave no verdict, for the audit. */
interface ScanOutcome {
  readonly status: ScanStatusKey;
  readonly scanner: string | null;
  readonly threat: string | null;
  readonly failure: string | null;
}

/** A scan's outcome, bound to the digest of the bytes that were scanned — STG-1. */
interface KnownVerdict {
  readonly checksumSha256: string;
  readonly outcome: ScanOutcome;
}

function normalizeDigest(raw: string | undefined): string | null {
  if (raw === undefined) {
    return null;
  }
  const digest = raw.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new ValidationError('A checksum is 64 hexadecimal characters.', [
      { field: 'checksumSha256', message: 'malformed' },
    ]);
  }
  return digest;
}
