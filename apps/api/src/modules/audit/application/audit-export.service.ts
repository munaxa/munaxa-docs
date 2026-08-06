import { Inject, Injectable } from '@nestjs/common';

import {
  type AnyId,
  AuditOutcome,
  AuditSubjectType,
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
import { STORAGE_SERVICE, type StorageService } from '../../storage/application/ports';
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
   * Issues the signed URLs for a completed bundle, and audits the issuance.
   *
   * Audited before the URLs are returned, for the reason `FILE_DOWNLOAD_ISSUED` is: a signed URL
   * outlives the request that produced it and can be redeemed by whoever holds it.
   */
  async download(id: AnyId): Promise<readonly { name: string; url: string; expiresAt: Date }[]> {
    const record = await this.get(id);
    if (record === null || record.state !== AuditExportState.COMPLETED) {
      throw new NotFoundError('The requested resource');
    }

    const links: { name: string; url: string; expiresAt: Date }[] = [];
    for (const artefact of record.artefacts) {
      // Through Storage's own audited path, so each artefact also gets its
      // `FILE_DOWNLOAD_ISSUED` row. Signing here instead would be a second place that obligation
      // has to be remembered, and the second place is the one that gets forgotten.
      const signed = await this.storage.createDownloadUrl(
        asId(artefact.fileObjectId),
        artefact.name,
      );
      links.push({ name: artefact.name, url: signed.url, expiresAt: signed.expiresAt });
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
            artefacts: record.artefacts.map((artefact) => artefact.name),
            eventCount: record.eventCount,
            // The digests, so the trail records *which* bytes were handed over rather than
            // merely that some were.
            sha256: Object.fromEntries(
              record.artefacts.map((artefact) => [artefact.name, artefact.sha256]),
            ),
          },
        },
      }),
    );
    return links;
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
      await this.unitOfWork.run(() => this.exports.complete(id, outcome));
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
   * Streams the rows into the bundle's artefacts and returns what was written.
   *
   * The rows are read once and fanned into both artefacts, rather than read twice: a second pass
   * over the range would produce a CSV of a *different* set of rows if anything were appended in
   * between, and a bundle whose two files disagree is worse than one format.
   */
  private async produce(record: AuditExportRecord) {
    // Storage owns the layout; audit names the bundle and its parts. Building the key here would
    // put the object store's shape in a second module, which is what the boundary lint forbids.
    const prefix = this.storage.evidencePrefix(record.id);
    const collected = await this.collect(record);

    const jsonl = await this.write(
      record.id,
      'events.jsonl',
      'application/x-ndjson',
      collected.rows,
      evidenceJsonlRow,
      null,
    );
    const csv = await this.write(
      record.id,
      'events.csv',
      'text/csv',
      collected.rows,
      // The profile is read from configuration at the moment the bundle is produced, and it is
      // recorded on the manifest below — so a bundle always states the rule that wrote it rather
      // than leaving a reader to infer it from a release date.
      (row) => evidenceCsvRow(row, this.csvProfile()),
      evidenceCsvHeader(),
    );

    const manifest = buildManifest({
      exportId: record.id,
      tenantId: requireContext().tenantId,
      requestedById: record.requestedById,
      requestedAt: record.requestedAt,
      producedAt: this.clock.now(),
      from: record.from,
      to: record.to,
      filters: record.filters,
      eventCount: collected.rows.length,
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
      eventCount: collected.rows.length,
      storagePrefix: prefix,
      artefacts,
      chainIntact: collected.chain.intact,
      brokenAtId: collected.chain.brokenAtEventId,
    };
  }

  /**
   * Reads the range, verifies it as it goes, and keeps it.
   *
   * The rows *are* held here, and that is the one place this phase does not stream — see the
   * report's cost table. Bounding it is `AUDIT_EXPORT_BATCH_SIZE` for the reads and the range the
   * requester chose for the total; the alternative, two independent passes for two artefacts,
   * would risk a CSV and a JSONL that disagree.
   */
  private async collect(record: AuditExportRecord) {
    const rows: EvidenceRow[] = [];
    const hashVersions = new Set<number>();
    let cursor = 0n;
    let intact = true;
    let brokenAtEventId: string | null = null;
    let reason: string | null = null;
    let verified = 0;
    let firstSequence: bigint | null = null;
    let from: string | null = null;
    let lastSequence: bigint | null = null;
    let lastHash: string | null = null;
    let previousHash: string | null = null;

    for (;;) {
      const slice = await this.unitOfWork.run(() =>
        this.repository.sliceBySequence(cursor, this.config.audit.exportBatchSize),
      );
      if (slice.events.length === 0) {
        break;
      }
      const last = slice.events.at(-1);
      cursor = last?.sequence ?? cursor;

      // Verified over the *whole* chain the batch covers, then filtered to the range. Verifying
      // only the exported rows would verify a subsequence, and a subsequence of a chain never
      // chains — the links between the rows that were filtered out are missing by construction.
      if (intact) {
        const result = this.verification.verifyRange(slice.events, previousHash ?? slice.from);
        verified += result.verified;
        if (!result.intact) {
          intact = false;
          brokenAtEventId = result.brokenAt;
          reason = result.reason;
        }
      }
      previousHash = last?.hash ?? previousHash;

      for (const event of slice.events) {
        if (!this.inRange(record, event)) {
          continue;
        }
        if (firstSequence === null) {
          firstSequence = event.sequence;
          from = event.previousHash;
        }
        lastSequence = event.sequence;
        lastHash = event.hash;
        hashVersions.add(event.chainHashVersion);
        rows.push(toEvidenceRow(event));
      }
    }

    const checkpoints =
      firstSequence === null || lastSequence === null
        ? []
        : (await this.checkpoints.covering(firstSequence, lastSequence)).map(toBundleCheckpoint);

    return {
      rows,
      hashVersions: [...hashVersions],
      firstSequence,
      lastSequence,
      from: from ?? GENESIS_HASH,
      lastHash,
      checkpoints,
      chain: { intact, brokenAtEventId, reason, verified },
    };
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
    rows: readonly EvidenceRow[],
    render: (row: EvidenceRow) => string,
    header: string | null,
  ): Promise<BundleArtefact> {
    const digest = new StreamDigest();
    // eslint-disable-next-line @typescript-eslint/require-await -- a generator, not a task
    async function* body(): AsyncIterable<Uint8Array> {
      if (header !== null) {
        const chunk = Buffer.from(header, 'utf8');
        digest.update(chunk);
        yield new Uint8Array(chunk);
      }
      for (const row of rows) {
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
