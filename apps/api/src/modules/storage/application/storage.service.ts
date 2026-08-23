import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import {
  type AnyId,
  AuditSubjectType,
  type DomainEventDraft,
  type FileObjectId,
  AuditOutcome,
  IntegrityStatus,
  type IntegrityStatusKey,
  isServableIntegrity,
  ScanStatus,
  type ScanStatusKey,
  UploadSessionState,
  type UploadSessionId,
  asId,
} from '@edms/domain';
import { sanitizeFilename } from '@edms/utils';

import { APP_CONFIG, type AppConfig } from '../../../core/config';
import {
  ContentNotScannedError,
  ForbiddenError,
  NotFoundError,
  StorageUnavailableError,
  UnsupportedContentError,
  ValidationError,
} from '../../../core/errors/application-errors';
import { AdministeredWriter, AdministrativeOperation } from '../../../core/persistence';
import { requireContext } from '../../../core/tenancy/tenant-context';
import { OUTBOX_WRITER, type OutboxWriter } from '../../../core/outbox/outbox.port';
import { ANTIVIRUS_PORT, type AntivirusPort } from '../../../ports/antivirus.port';
import { CLOCK_PORT, type ClockPort } from '../../../ports/clock.port';
import { STORAGE_PORT, type StoragePort } from '../../../ports/storage.port';
import { StorageAudit } from '../domain/audit-actions';
import {
  blobKeyFor,
  derivedKeyFor,
  evidenceKeyFor,
  evidencePrefixFor,
  stagingKeyFor,
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
  isRejection,
  narrowPolicy,
} from '../domain/upload-policy';
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
  ) {}

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
      throw new UnsupportedContentError(verdict.detail, { reason: verdict.reason });
    }

    return this.writer.write<IssuedUploadTarget>(async () => {
      const digest = normalizeDigest(input.checksumSha256);
      if (digest !== null) {
        const existing = await this.files.findByChecksum(digest);
        if (existing !== null) {
          // Nothing to transfer. Still audited, and still a session, because "an upload happened"
          // is a fact an auditor asks about whether or not bytes moved.
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
            }),
          };
        }
      }

      const sessionId = this.writer.clock.nextId();
      const targetKey = stagingKeyFor(sessionId);
      const multipart = input.sizeBytes > MULTIPART_THRESHOLD_BYTES;
      const target = await this.storage.createUploadTarget({
        key: targetKey,
        // The *sniffed* type is signed into the target, not the declared one. A URL issued for a
        // PDF cannot be redeemed for anything else, and the sniff is what decided it is a PDF.
        contentType: verdict.format.mimeType,
        sizeBytes: input.sizeBytes,
        expiresInSeconds: this.config.storage.signedUrlTtlSeconds,
        ...(digest !== null && { checksumSha256: digest }),
        multipart,
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
          multipart,
        }),
      };
    });
  }

  /**
   * Confirms the transfer, checks it against what was promised, and creates the blob.
   *
   * The order is the point. Read the store's answer, compare, scan, and only then write a row —
   * so there is no state in which a `file_object` exists for bytes that were never verified.
   */
  async completeUploadSession(
    id: UploadSessionId,
    parts: readonly { partNumber: number; etag: string }[],
  ): Promise<CompletedUpload> {
    return this.writer.write<CompletedUpload>(async () => {
      const session = await this.sessions.findById(id);
      if (session === null) {
        throw new NotFoundError('The requested upload');
      }
      this.refuseAnotherPersonsUpload(session);
      if (session.state !== UploadSessionState.OPEN) {
        throw new ValidationError('That upload has already been finished.', [
          { field: 'state', message: session.state },
        ]);
      }

      const metadata = await this.storage.completeUpload(
        session.targetKey,
        parts.map((part) => ({
          partNumber: part.partNumber,
          url: '',
          etag: part.etag,
          ...(session.multipartUploadId !== null && { uploadId: session.multipartUploadId }),
        })),
      );

      if (metadata.sizeBytes !== session.declaredSizeBytes) {
        // The bytes that arrived are not the bytes that were approved. The target was signed for a
        // size, so this is a store that did not enforce it — and the honest response is to remove
        // what arrived rather than to record a blob whose provenance is already in question.
        await this.discard(session.targetKey, id);
        throw new UnsupportedContentError('The upload did not match the size it declared.', {
          declared: session.declaredSizeBytes,
          stored: metadata.sizeBytes,
        });
      }

      const digest = metadata.checksumSha256;
      if (digest === null) {
        await this.discard(session.targetKey, id);
        throw new UnsupportedContentError('Storage could not confirm the file’s digest.');
      }

      // Deduplication, at the only moment the digest is a fact. Two people uploading the same
      // standard form converge here rather than at the client's optional pre-check.
      const existing = await this.files.findByChecksum(digest);
      if (existing !== null) {
        await this.storage.delete(session.targetKey);
        await this.sessions.settle(id, UploadSessionState.COMPLETED, existing.id);
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
          }),
        };
      }

      const contentKey = blobKeyFor(digest);
      await this.storage.copy(session.targetKey, contentKey);
      await this.storage.delete(session.targetKey);

      const scan = await this.scan(contentKey, metadata.sizeBytes, session.declaredMimeType);
      const fileObjectId = this.writer.clock.nextId();
      await this.files.insert({
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
      await this.sessions.settle(id, UploadSessionState.COMPLETED, fileObjectId);

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
        }),
      };
    });
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
        throw new ValidationError('That upload has already been finished.', [
          { field: 'state', message: session.state },
        ]);
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
  async createDownloadUrl(
    fileObjectId: FileObjectId,
    filename: string,
    options: { inline?: boolean } = {},
  ): Promise<{ url: string; expiresAt: Date }> {
    return this.writer.write<{ url: string; expiresAt: Date }>(async () => {
      const file = await this.require(fileObjectId);
      this.refuseUnreachable(file);

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

  async isReachable(fileObjectId: FileObjectId): Promise<boolean> {
    const file = await this.files.findById(fileObjectId);
    return (
      file !== null &&
      file.scanStatus === ScanStatus.CLEAN &&
      // Phase 18. A blob whose bytes no longer hash to what was recorded is quarantined for the
      // same reason an infected one is: the product must not serve content it cannot vouch for.
      // `UNVERIFIED` passes, because that is the state of every blob written before the sweep
      // existed and refusing it would have made the whole library unreadable on the day the
      // column arrived.
      isServableIntegrity(file.integrityStatus)
    );
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
    const result = { checked: 0, verified: 0, mismatched: 0, unreadable: 0 };

    for (const file of page) {
      // Outside any transaction: this is a network read of somebody else's object store, and
      // holding a database transaction open across it would put an object store's latency in
      // front of every other write in the tenant.
      const actual = await this.rehash(file);
      const status = integrityFrom(file.checksumSha256, actual);
      result.checked += 1;

      if (status === IntegrityStatus.VERIFIED || status === IntegrityStatus.UNVERIFIED) {
        if (status === IntegrityStatus.VERIFIED) {
          result.verified += 1;
        }
        await this.writer.read(() =>
          this.files.recordIntegrity(file.id, { status, at: this.clock.now() }),
        );
        continue;
      }

      if (status === IntegrityStatus.MISMATCH) {
        result.mismatched += 1;
      } else {
        result.unreadable += 1;
      }
      await this.quarantine(file, status, actual);
    }

    return result;
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
      await this.files.insert({
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
    // ADR-0007 makes blobs content-addressed and `uq_file_object_checksum` enforces one row per
    // digest per tenant, and the *upload* path has honoured that since Phase 3 (`alreadyStored`).
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
      await this.files.insert({
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
   * With `AV_DRIVER=NONE` the port refuses, and the refusal is caught rather than propagated: the
   * verdict becomes `SKIPPED`, which is *not* `CLEAN` and therefore not reachable. A development
   * environment can upload; nothing can pretend the gate ran.
   */
  private async scan(
    key: string,
    sizeBytes: number,
    mimeType: string,
  ): Promise<{ status: ScanStatusKey; scanner: string | null; threat: string | null }> {
    try {
      const verdict = await this.antivirus.scan({
        storageKey: key,
        sizeBytes,
        declaredMimeType: mimeType,
        timeoutMs: SCAN_TIMEOUT_MS,
      });
      return { status: verdict.status, scanner: verdict.scanner, threat: verdict.threat };
    } catch {
      // Never `CLEAN`. A scanner that could not be reached has not cleared anything, and the one
      // failure mode this product must not have is an environment where "upload works" means "the
      // gate is off" (`17-security-architecture.md` §10).
      return { status: ScanStatus.SKIPPED, scanner: null, threat: null };
    }
  }

  /**
   * Reads a blob back and re-hashes it.
   *
   * Answers `null` for "could not read", which covers a missing object, a store that refused and a
   * blob past the size bound alike — the caller distinguishes the last of those by the size it
   * already has on the row, because the three need different findings and only one of them is an
   * incident.
   */
  private async rehash(file: FileObjectRecord): Promise<string | null> {
    if (file.sizeBytes > this.config.storage.integrityMaxBytes) {
      return null;
    }
    try {
      const bytes = await this.storage.read(file.storageKey);
      return bytes === null ? null : createHash('sha256').update(bytes).digest('hex');
    } catch {
      // A store that is briefly unreachable must not quarantine a tenant's library, so this is
      // indistinguishable here from a missing object — and the *finding* below is what tells them
      // apart, because an object that reads as absent twice is an incident and one pass is not.
      return null;
    }
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
   * Aborts a session and removes what it staged. Answers whether it was the one to abort it.
   *
   * **The claim comes first** — Slice 43. `settle` carries `state: OPEN` in its predicate, which is
   * what makes it a compare-and-set rather than an assignment, and taking it before touching the
   * store is what stops an abandon from deleting bytes a completion running beside it is still
   * copying. The order was the other way round, which was safe only because nothing read the
   * answer.
   *
   * The completion path calls this on a size or digest mismatch and then throws, so its `settle`
   * rolls back with the rest of that transaction and the object is gone either way — the same net
   * effect as before, and the reason that caller needs no change.
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
    if (file.scanStatus !== ScanStatus.CLEAN) {
      throw new ContentNotScannedError(file.scanStatus);
    }
  }

  private policy() {
    // The deployment's ceiling is the outer bound. A tenant narrowing it further is settings work
    // that belongs with the rest of the tenant's configuration, and `narrowPolicy` is the seam it
    // will attach to — it can only ever restrict what is here.
    return narrowPolicy(defaultUploadPolicy(this.config.storage.maxUploadBytes), {});
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

/**
 * What one blob's re-read says about it.
 *
 * `UNVERIFIED` is the "we did not manage to look" answer — a blob past the size bound. It is not a
 * finding and never quarantines; it is recorded so the ordering advances past it.
 */
function integrityFrom(expected: string, actual: string | null): IntegrityStatusKey {
  if (actual === null) {
    return IntegrityStatus.UNREADABLE;
  }
  return actual === expected ? IntegrityStatus.VERIFIED : IntegrityStatus.MISMATCH;
}

/** Above this an upload is offered as a resumable transfer. Mirrors the S3 adapter's threshold. */
const MULTIPART_THRESHOLD_BYTES = 64 * 1024 * 1024;

/** Long enough for a large file, short enough that a hung scanner is not a hung request. */
const SCAN_TIMEOUT_MS = 120_000;

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
