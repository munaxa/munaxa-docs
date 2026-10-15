import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import {
  type AnyId,
  AuditOutcome,
  AuditSubjectType,
  type FileObjectId,
  Permission,
  QueueName,
  type UserId,
  asId,
} from '@edms/domain';
import type { Page, PageRequest } from '@edms/utils';

import { GENESIS_HASH } from '../../../core/audit/hash-chain';
import { APP_CONFIG, type AppConfig } from '../../../core/config';
import { NotFoundError, ValidationError } from '../../../core/errors/application-errors';
import { LOGGER, type Logger } from '../../../core/observability/logger';
import { OUTBOX_WRITER, type OutboxWriter } from '../../../core/outbox/outbox.port';
import { AdministeredWriter, AdministrativeOperation } from '../../../core/persistence';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../core/prisma';
import { requireContext } from '../../../core/tenancy/tenant-context';
import { CLOCK_PORT, type ClockPort } from '../../../ports/clock.port';
import { QUEUE_PORT, type QueuePort } from '../../../ports/queue.port';
import {
  DownloadLinkKind,
  type DownloadLinkGrantOf,
  type RedeemedDownload,
  STORAGE_SERVICE,
  type StorageService,
} from '../../storage/application/ports';
import { AuditAudit } from '../domain/audit-actions';
import { auditExportReadyEvent } from '../domain/events';
import {
  type BundleArtefact,
  type BundleCheckpoint,
  type EvidenceRow,
  StreamDigest,
  buildManifest,
  evidenceCsvHeader,
  evidenceCsvRow,
  type EvidenceCsvProfileKey,
  evidenceJsonlRow,
  serialiseManifest,
  signManifest,
} from '../domain/evidence-bundle';
import { AuditVerificationService } from './audit-verification.service';
import {
  AUDIT_CHECKPOINT_STORE,
  AUDIT_EXPORT_REPOSITORY,
  AUDIT_REPOSITORY,
  type AuditCheckpointStore,
  type AuditEventRecord,
  AuditExportState,
  type AuditExportRecord,
  type AuditExportRepository,
  type AuditRepository,
} from './ports';

/**
 * Evidence export — `13-audit-architecture.md` §6's "signed bundle … written to storage and
 * downloaded via a signed URL. The export itself is audited."
 *
 * ## Two acts, two audit rows
 *
 * `request` writes `AUDIT_EXPORTED` before anything is produced, and the run writes a second one
 * when it completes or fails. That is the `FILE_DOWNLOAD_ISSUED` reasoning applied one level up: a
 * window in which a range of the trail is being assembled for somebody and nothing says so is
 * exactly where a failure would hide. Taking the bundle is a third act and a third row —
 * `BULK_DOWNLOAD`, written every time the URLs are issued, because producing evidence and carrying
 * it away are different facts and the second can happen repeatedly, by whoever holds the link.
 *
 * ## Why a prefix of objects rather than one archive
 *
 * §6 says "downloaded via a signed URL", and a single downloadable file would mean a ZIP. A ZIP
 * means either a compression dependency and a second assembly pass — which is precisely the
 * in-memory hold the `audit.export` lane's description forbids — or hand-rolling a stored-entry
 * archive writer, which is a format implementation nobody asked for. So the bundle is a prefix
 * containing `events.jsonl`, `events.csv` and `manifest.json`, the manifest is its entry point,
 * and the download endpoint issues one signed URL per artefact. The auditor gets three links
 * instead of one; the product does not gain an archive format to maintain.
 *
 * ## What streams and what does not
 *
 * The rows stream: read by sequence in batches, hashed and written as they pass, so a seven-year
 * range costs one batch of memory. The manifest does not, and cannot — it states the digest of
 * every artefact, which is only known once each has been written, so it is produced last and is
 * kilobytes.
 */
@Injectable()
export class AuditExportService {
  constructor(
    @Inject(AUDIT_EXPORT_REPOSITORY) private readonly exports: AuditExportRepository,
    @Inject(AUDIT_REPOSITORY) private readonly repository: AuditRepository,
    @Inject(AUDIT_CHECKPOINT_STORE) private readonly checkpoints: AuditCheckpointStore,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    @Inject(QUEUE_PORT) private readonly queue: QueuePort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriter,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK_PORT) private readonly clock: ClockPort,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly verification: AuditVerificationService,
    private readonly writer: AdministeredWriter,
  ) {}

  /**
   * Records the request, audits it, and hands the work to the lane.
   *
   * `202` at the endpoint, because a range worth exporting is a range worth not holding a request
   * open for. The enqueue happens *after* the transaction rather than inside it — the outbox rule
   * exists for events, and this is a job whose row is its own record; enqueuing before commit would
   * let a consumer claim a row nothing had written yet.
   */
  async request(
    from: Date,
    to: Date,
    filters: Readonly<Record<string, string>>,
  ): Promise<AuditExportRecord> {
    if (from.getTime() > to.getTime()) {
      throw new ValidationError('The range ends before it begins.', [
        { field: 'to', message: 'The end of the range must not precede its start.' },
      ]);
    }
    const context = requireContext();
    if (context.userId === null) {
      // An export is always somebody's act. There is no system path to one, and a nullable
      // requester would make "who took a copy of the trail" unanswerable for exactly the export
      // an investigation cares about.
      throw new ValidationError('An evidence export must be requested by a signed-in user.', [
        { field: 'requestedBy', message: 'No current user.' },
      ]);
    }

    const record = await this.writer.write<AuditExportRecord>(async () => {
      const created: AuditExportRecord = {
        id: asId<AnyId>(this.writer.clock.nextId()),
        state: AuditExportState.REQUESTED,
        from,
        to,
        filters,
        requestedById: context.userId as UserId,
        requestedAt: this.writer.clock.now(),
        eventCount: 0,
        storagePrefix: null,
        artefacts: [],
        chainIntact: null,
        brokenAtId: null,
        completedAt: null,
        error: null,
      };
      await this.exports.insert(created);
      return {
        result: created,
        change: {
          action: AuditAudit.AUDIT_EXPORTED,
          subjectType: AuditSubjectType.EXPORT,
          subjectId: created.id,
          operation: AdministrativeOperation.CREATED,
          after: {
            from: from.toISOString(),
            to: to.toISOString(),
            filters,
            state: AuditExportState.REQUESTED,
          },
        },
      };
    });

    await this.queue.enqueue(
      QueueName.AUDIT_EXPORT,
      { kind: 'audit.export', tenantId: context.tenantId, exportId: record.id },
      { jobId: `audit:export:${record.id}` },
    );
    return record;
  }

  get(id: AnyId): Promise<AuditExportRecord | null> {
    return this.writer.read(() => this.exports.findById(id));
  }

  list(page: PageRequest): Promise<Page<AuditExportRecord>> {
    return this.writer.read(() => this.exports.list(page));
  }

  /**
   * Issues verified download links for a completed bundle — every artefact, or the one named — and
   * audits the issuance. ADR-0026 §10, the export design §3.3.
   *
   * **All or nothing, in one transaction.** Each artefact is checked as Storage checks any link
   * (servable, the download size limit, the store's HEAD) and its `FILE_DOWNLOAD_ISSUED` row is
   * written in the same transaction as `BULK_DOWNLOAD`. If any artefact is refused — quarantined,
   * missing, too large — or the store cannot be asked, the transaction rolls back: no row records a
   * link that was never returned, and no partial bundle is handed out (E-5). The checks are store
   * reads, which no transaction spans; what is atomic is the record and the answer, and they agree.
   *
   * **Policy kept:** any holder of `audit:export` may take any completed bundle in the tenant, as
   * before. The links are verified links the API serves (`AUDIT_ARTEFACT` kind), never store URLs,
   * and each is re-authorized when it is followed (`redeemArtefactDownload`).
   */
  async download(
    id: AnyId,
    artefact: string | null = null,
  ): Promise<readonly { name: string; url: string; expiresAt: Date }[]> {
    const record = await this.get(id);
    if (record === null || record.state !== AuditExportState.COMPLETED) {
      throw new NotFoundError('The requested resource');
    }
    const chosen =
      artefact === null
        ? record.artefacts
        : record.artefacts.filter((candidate) => candidate.name === artefact);
    if (chosen.length === 0) {
      throw new NotFoundError('The requested resource');
    }

    return this.unitOfWork.run(async () => {
      const links: { name: string; url: string; expiresAt: Date }[] = [];
      for (const part of chosen) {
        // Through Storage's own audited path, so each artefact gets its `FILE_DOWNLOAD_ISSUED`
        // row — joined to this transaction, so it stands or falls with the rest of the bundle.
        const link = await this.storage.createVerifiedDownloadLink(
          asId(part.fileObjectId),
          part.name,
          {
            subject: {
              kind: DownloadLinkKind.AUDIT_ARTEFACT,
              exportId: String(record.id),
              artefact: part.name,
            },
            // The artefact's own type: its blob may be shared with another export's (E-8, E-9).
            mimeType: part.mediaType,
            audit: { auditExportId: String(record.id), artefact: part.name },
          },
        );
        links.push({ name: part.name, url: link.url, expiresAt: link.expiresAt });
      }

      await this.writer.write<void>(() =>
        Promise.resolve({
          result: undefined,
          change: {
            action: AuditAudit.BULK_DOWNLOAD,
            subjectType: AuditSubjectType.EXPORT,
            subjectId: id,
            operation: AdministrativeOperation.UPDATED,
            after: {
              artefacts: chosen.map((part) => part.name),
              eventCount: record.eventCount,
              // The digests, so the trail records *which* bytes were handed over rather than
              // merely that some were.
              sha256: Object.fromEntries(chosen.map((part) => [part.name, part.sha256])),
              delivery: 'VERIFIED',
            },
          },
        }),
      );
      return links;
    });
  }

  /**
   * Whether an audit artefact's download link may still be used, by the person in the current
   * context, now — the redemption half of `download`.
   *
   * `audit:export`, held now; the export, in this tenant, still `COMPLETED`; the artefact the link
   * names, in that export's own list, pointing at the link's file, with the link's name and media
   * type; and that file's digest is the one the export recorded for the artefact — what the bytes
   * are then verified against. The export record is the authority on all of it, never the blob,
   * which another export may share (E-9). Everything but yes is `NotFoundError`.
   */
  async redeemArtefactDownload(
    grant: DownloadLinkGrantOf<typeof DownloadLinkKind.AUDIT_ARTEFACT>,
  ): Promise<RedeemedDownload> {
    if (!requireContext().permissions.includes(Permission.AUDIT_EXPORT)) {
      throw new NotFoundError('the person no longer holds audit:export');
    }
    const record = await this.get(asId<AnyId>(grant.subject.exportId));
    if (record === null || record.state !== AuditExportState.COMPLETED) {
      throw new NotFoundError('the export is not this tenant’s, or not finished');
    }
    const part = record.artefacts.find((candidate) => candidate.name === grant.subject.artefact);
    if (
      part === undefined ||
      part.fileObjectId !== grant.fileObjectId ||
      part.name !== grant.filename ||
      part.mediaType !== grant.mimeType
    ) {
      throw new NotFoundError('the link does not describe an artefact of this export');
    }
    // Quarantined refuses here (409) exactly as delivery would.
    const file = await this.storage.servable(asId(part.fileObjectId));
    if (file.checksumSha256 !== part.sha256) {
      throw new NotFoundError('the artefact’s recorded digest is not its file’s');
    }
    return { audit: { auditExportId: String(record.id), artefact: part.name } };
  }

  /**
   * Produces the bundle. Called by the lane's consumer, never by a request.
   *
   * Idempotent through `claim`: a redelivered job finds the row no longer `REQUESTED` and returns,
   * rather than producing a second bundle under the same identifier.
   */
  async run(id: AnyId): Promise<void> {
    const claimed = await this.unitOfWork.run(() => this.exports.claim(id));
    if (!claimed) {
      this.logger.info('An evidence export was already claimed', { exportId: id });
      return;
    }
    const record = await this.unitOfWork.run(() => this.exports.findById(id));
    if (record === null) {
      return;
    }

    try {
      const outcome = await this.produce(record);
      await this.unitOfWork.run(async () => {
        /*
         * A reference per artefact, in the same transaction as the row that names them — Slice 101.
         *
         * `storeStreamed` inserts each `file_object` at a count of zero, exactly as `storeDerived`
         * does, and leaves the reference to whoever ends up pointing at it. That is this row.
         * Without it `retention.reclaim-blobs` — which selects `ref_count = 0` past the grace
         * period and does not exempt a derived blob — deletes the bytes of a `COMPLETED` bundle
         * and soft-deletes the rows, while the export goes on attesting `chainIntact` over
         * evidence that no longer exists. The artefacts live in a JSON column rather than behind a
         * foreign key, so not even `onDelete: Restrict` is in the way.
         *
         * A reference each rather than one per distinct blob: two artefacts that came out
         * byte-identical are one content-addressed row with two pointers at it, and each pointer
         * is owed its own.
         *
         * One transaction with `complete`, so there is no instant in which the row names bytes it
         * does not hold — and none in which a reference is held for a row that was not written.
         */
        for (const artefact of outcome.artefacts) {
          await this.storage.reference(asId<FileObjectId>(artefact.fileObjectId));
        }
        await this.exports.complete(id, outcome);
      });
      await this.unitOfWork.run(() =>
        this.outbox.publish([
          auditExportReadyEvent(id, {
            exportId: id,
            storageKey: outcome.storagePrefix,
            eventCount: outcome.eventCount,
          }),
        ]),
      );
      await this.auditOutcome(record, AuditOutcome.SUCCESS, {
        state: AuditExportState.COMPLETED,
        eventCount: outcome.eventCount,
        chainIntact: outcome.chainIntact,
        artefacts: outcome.artefacts.map((artefact) => ({
          name: artefact.name,
          sha256: artefact.sha256,
          sizeBytes: artefact.sizeBytes,
        })),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown';
      await this.unitOfWork.run(() => this.exports.fail(id, reason));
      await this.auditOutcome(record, AuditOutcome.FAILED, {
        state: AuditExportState.FAILED,
        error: reason,
      });
      throw error;
    }
  }

  /** Which CSV rendering rule this deployment writes bundles under — see `evidence-bundle.ts`. */
  private csvProfile(): EvidenceCsvProfileKey {
    return this.config.audit.evidenceCsvProfile;
  }

  /**
   * Streams the range into the bundle's artefacts and returns what was written.
   *
   * **Bounded memory, two passes, one set of rows.** The range is read a batch at a time
   * (`AUDIT_EXPORT_BATCH_SIZE`) and written as it is read; nothing holds the range whole. JSONL
   * is the first pass, which also verifies the chain and records the highest sequence it read —
   * the *ceiling*. CSV is the second pass, which reads nothing above the ceiling: the trail is
   * append-only and ordered by sequence, so an event appended in between is above it and
   * excluded, and the two passes read the same rows. That is *checked*, not assumed: each pass
   * folds every exported event's identifier and hash into a digest, and if the counts or digests
   * differ the export fails rather than producing a bundle whose two files disagree. Nothing is
   * dropped or cut short to save memory.
   */
  private async produce(record: AuditExportRecord) {
    // Storage owns the layout; audit names the bundle and its parts. Building the key here would
    // put the object store's shape in a second module, which is what the boundary lint forbids.
    const prefix = this.storage.evidencePrefix(record.id);

    const first = new RangePass();
    const jsonl = await this.write(
      record.id,
      'events.jsonl',
      'application/x-ndjson',
      this.walk(record, first, null),
      evidenceJsonlRow,
      null,
    );
    const second = new RangePass();
    const csv = await this.write(
      record.id,
      'events.csv',
      'text/csv',
      // An empty chain set no ceiling: the second pass then reads nothing, not everything.
      this.walk(record, second, first.ceiling ?? 0n),
      // The profile is read from configuration at the moment the bundle is produced, and it is
      // recorded on the manifest below — so a bundle always states the rule that wrote it rather
      // than leaving a reader to infer it from a release date.
      (row) => evidenceCsvRow(row, this.csvProfile()),
      evidenceCsvHeader(),
    );
    if (second.count !== first.count || second.identity() !== first.identity()) {
      throw new Error(
        'The two passes over the range read different events; the bundle was not produced.',
      );
    }
    const checkpoints =
      first.firstSequence === null || first.lastSequence === null
        ? []
        : (await this.checkpoints.covering(first.firstSequence, first.lastSequence)).map(
            toBundleCheckpoint,
          );
    const collected = {
      firstSequence: first.firstSequence,
      lastSequence: first.lastSequence,
      from: first.from ?? GENESIS_HASH,
      lastHash: first.lastHash,
      hashVersions: [...first.hashVersions],
      checkpoints,
      chain: first.chain,
      count: first.count,
    };

    const manifest = buildManifest({
      exportId: record.id,
      tenantId: requireContext().tenantId,
      requestedById: record.requestedById,
      requestedAt: record.requestedAt,
      producedAt: this.clock.now(),
      from: record.from,
      to: record.to,
      filters: record.filters,
      eventCount: collected.count,
      firstSequence: collected.firstSequence,
      lastSequence: collected.lastSequence,
      firstPreviousHash: collected.from,
      lastHash: collected.lastHash,
      hashVersions: collected.hashVersions,
      csvProfile: this.csvProfile(),
      chain: collected.chain,
      checkpoints: collected.checkpoints,
      artefacts: [jsonl, csv],
    });

    const body = serialiseManifest(manifest);
    const secret = this.config.audit.checkpointSecret;
    // The manifest and its signature are two objects, so the signature can be checked without
    // parsing the thing it covers — and so a verifier never has to reproduce this product's
    // serialisation to recompute it.
    const manifestArtefact = await this.writeBytes(
      record.id,
      'manifest.json',
      'application/json',
      Buffer.from(body, 'utf8'),
    );
    const artefacts: BundleArtefact[] = [jsonl, csv, manifestArtefact];

    if (secret !== null) {
      const signed = signManifest(body, secret);
      artefacts.push(
        await this.writeBytes(
          record.id,
          'manifest.sig',
          'text/plain',
          Buffer.from(`${signed.algorithm} ${signed.signature}\n`, 'utf8'),
        ),
      );
    } else {
      // Honest rather than silent: a bundle from a deployment with no signing key is still a
      // faithful copy of the trail, and it simply is not signed. Production cannot reach here.
      this.logger.warn('An evidence bundle was produced without a signature', {
        exportId: record.id,
      });
    }

    return {
      eventCount: collected.count,
      storagePrefix: prefix,
      artefacts,
      chainIntact: collected.chain.intact,
      brokenAtId: collected.chain.brokenAtEventId,
    };
  }

  /**
   * The range, read a batch at a time, verified as it goes (first pass) and yielded row by row.
   *
   * Verified over the *whole* chain each batch covers, then filtered to the range: verifying only
   * the exported rows would verify a subsequence, and a subsequence of a chain never chains — the
   * links between the rows filtered out are missing by construction. With a `ceiling`, nothing
   * above it is read (the second pass).
   */
  private async *walk(
    record: AuditExportRecord,
    pass: RangePass,
    ceiling: bigint | null,
  ): AsyncIterable<EvidenceRow> {
    let cursor = 0n;
    let previousHash: string | null = null;
    for (;;) {
      const slice = await this.unitOfWork.run(() =>
        this.repository.sliceBySequence(cursor, this.config.audit.exportBatchSize),
      );
      const events =
        ceiling === null ? slice.events : slice.events.filter((event) => event.sequence <= ceiling);
      if (events.length === 0) {
        return;
      }
      const last = events.at(-1);
      cursor = last?.sequence ?? cursor;
      if (ceiling === null) {
        pass.ceiling = cursor;
        if (pass.chain.intact) {
          const result = this.verification.verifyRange(events, previousHash ?? slice.from);
          pass.chain.verified += result.verified;
          if (!result.intact) {
            pass.chain.intact = false;
            pass.chain.brokenAtEventId = result.brokenAt;
            pass.chain.reason = result.reason;
          }
        }
        previousHash = last?.hash ?? previousHash;
      }
      for (const event of events) {
        if (!this.inRange(record, event)) {
          continue;
        }
        pass.take(event);
        yield toEvidenceRow(event);
      }
      if (ceiling !== null && cursor >= ceiling) {
        return;
      }
    }
  }

  /** The range and the filters, applied to one row. */
  private inRange(record: AuditExportRecord, event: AuditEventRecord): boolean {
    if (
      event.occurredAt.getTime() < record.from.getTime() ||
      event.occurredAt.getTime() > record.to.getTime()
    ) {
      return false;
    }
    const { action, actorId, subjectType, outcome } = record.filters;
    if (action !== undefined && event.action !== action) {
      return false;
    }
    if (actorId !== undefined && event.actorId !== actorId) {
      return false;
    }
    if (subjectType !== undefined && event.subjectType !== subjectType) {
      return false;
    }
    if (outcome !== undefined && event.outcome !== outcome) {
      return false;
    }
    return true;
  }

  /** One artefact, produced a row at a time and hashed on the way past. */
  private async write(
    exportId: AnyId,
    name: string,
    mediaType: string,
    rows: AsyncIterable<EvidenceRow>,
    render: (row: EvidenceRow) => string,
    header: string | null,
  ): Promise<BundleArtefact> {
    const digest = new StreamDigest();
    async function* body(): AsyncIterable<Uint8Array> {
      if (header !== null) {
        const chunk = Buffer.from(header, 'utf8');
        digest.update(chunk);
        yield new Uint8Array(chunk);
      }
      for await (const row of rows) {
        const chunk = Buffer.from(render(row), 'utf8');
        digest.update(chunk);
        yield new Uint8Array(chunk);
      }
    }
    const stored = await this.storage.storeStreamed({
      bundleId: exportId,
      name,
      body: body(),
      mimeType: mediaType,
    });
    return {
      name,
      storageKey: stored.storageKey,
      mediaType,
      sizeBytes: digest.sizeBytes,
      sha256: digest.digest(),
      fileObjectId: stored.id,
    };
  }

  private async writeBytes(
    exportId: AnyId,
    name: string,
    mediaType: string,
    content: Buffer,
  ): Promise<BundleArtefact> {
    const digest = new StreamDigest();
    digest.update(content);
    const stored = await this.storage.storeStreamed({
      bundleId: exportId,
      name,
      body: single(content),
      mimeType: mediaType,
    });
    return {
      name,
      storageKey: stored.storageKey,
      mediaType,
      sizeBytes: digest.sizeBytes,
      sha256: digest.digest(),
      fileObjectId: stored.id,
    };
  }

  private async auditOutcome(
    record: AuditExportRecord,
    outcome: typeof AuditOutcome.SUCCESS | typeof AuditOutcome.FAILED,
    after: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.writer.write<void>(() =>
      Promise.resolve({
        result: undefined,
        change: {
          action: AuditAudit.AUDIT_EXPORTED,
          subjectType: AuditSubjectType.EXPORT,
          subjectId: record.id,
          operation: AdministrativeOperation.UPDATED,
          after: { ...after, outcome },
        },
      }),
    );
  }
}

function toEvidenceRow(event: AuditEventRecord): EvidenceRow {
  return {
    id: event.id,
    sequence: event.sequence,
    occurredAt: event.occurredAt,
    actorId: event.actorId,
    onBehalfOfId: event.onBehalfOfId,
    channel: event.channel,
    action: event.action,
    subjectType: event.subjectType,
    subjectId: event.subjectId,
    outcome: event.outcome,
    payload: event.payload,
    reason: event.reason,
    correlationId: event.correlationId,
    ipAddress: event.ipAddress,
    userAgent: event.userAgent,
    hash: event.hash,
    previousHash: event.previousHash,
    chainHashVersion: event.chainHashVersion,
  };
}

function toBundleCheckpoint(checkpoint: {
  sequence: bigint;
  hash: string;
  verifiedAt: Date;
  signature: string;
}): BundleCheckpoint {
  return {
    sequence: checkpoint.sequence.toString(),
    hash: checkpoint.hash,
    verifiedAt: checkpoint.verifiedAt.toISOString(),
    signature: checkpoint.signature,
  };
}

// eslint-disable-next-line @typescript-eslint/require-await -- a generator, not a task
async function* single(content: Buffer): AsyncIterable<Uint8Array> {
  yield new Uint8Array(content);
}

/**
 * What one pass over the range saw: enough to describe the bundle, and a digest of exactly which
 * events it exported, so two passes can be shown to have read the same rows. Constant in size,
 * whatever the range.
 */
class RangePass {
  count = 0;
  firstSequence: bigint | null = null;
  lastSequence: bigint | null = null;
  from: string | null = null;
  lastHash: string | null = null;
  readonly hashVersions = new Set<number>();
  /** The highest sequence the first pass read — the bound the second pass reads up to. */
  ceiling: bigint | null = null;
  readonly chain: {
    intact: boolean;
    brokenAtEventId: string | null;
    reason: string | null;
    verified: number;
  } = { intact: true, brokenAtEventId: null, reason: null, verified: 0 };
  private readonly digest = createHash('sha256');

  take(event: AuditEventRecord): void {
    if (this.firstSequence === null) {
      this.firstSequence = event.sequence;
      this.from = event.previousHash;
    }
    this.lastSequence = event.sequence;
    this.lastHash = event.hash;
    this.hashVersions.add(event.chainHashVersion);
    this.count += 1;
    this.digest.update(`${event.id}:${event.hash}\n`);
  }

  identity(): string {
    return this.digest.copy().digest('hex');
  }
}
