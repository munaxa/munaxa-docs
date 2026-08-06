import { Inject, Injectable } from '@nestjs/common';

import { asId, type AnyId, type DomainEventDraft } from '@edms/domain';

import { APP_CONFIG, type AppConfig } from '../../../core/config';
import {
  CURRENT_CHAIN_HASH_VERSION,
  type ChainLink,
  GENESIS_HASH,
  isChainHashVersion,
  verifyChain,
} from '../../../core/audit/hash-chain';
import { LOGGER, type Logger } from '../../../core/observability/logger';
import { METRICS, MetricName, type Metrics } from '../../../core/observability/metrics';
import { OUTBOX_WRITER, type OutboxWriter } from '../../../core/outbox/outbox.port';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../core/prisma';
import { requireContext } from '../../../core/tenancy/tenant-context';
import { CLOCK_PORT, type ClockPort } from '../../../ports/clock.port';
import { auditChainBrokenEvent, auditChainVerifiedEvent } from '../domain/events';
import { signCheckpoint } from '../infrastructure/storage-checkpoint.store';
import {
  AUDIT_CHECKPOINT_STORE,
  AUDIT_REPOSITORY,
  type AuditCheckpoint,
  type AuditCheckpointStore,
  type AuditEventRecord,
  type AuditRepository,
  type ChainVerification,
} from './ports';

/**
 * The daily verification of `13-audit-architecture.md` §4, and the checkpoint it records.
 *
 * ## What a pass does
 *
 * It resumes from the last signed checkpoint rather than from genesis, walks forward in batches by
 * sequence, and stops at the tail or at `AUDIT_VERIFY_MAX_EVENTS`, whichever comes first. Then it
 * writes a checkpoint at wherever it got to, so the next pass starts there. A deployment whose
 * first pass meets seven years of trail catches up over a few nights and afterwards verifies one
 * day at a time — which is what "a daily job verifies the chain" costs when the chain is real.
 *
 * Resuming from a checkpoint is only sound because the checkpoint is *authenticated*: the store
 * refuses to return one whose signature does not recompute, so "start from sequence 84,213 with
 * digest 9c2f…" is a claim signed with a key held in neither the database nor the bucket. Resuming
 * from an unsigned marker would let an attacker who reached the database move the starting point
 * past the rows they had rewritten.
 *
 * ## What it checks, and what each failure means
 *
 * Three distinct accusations, and they are reported separately because they call for different
 * responses. A **digest mismatch** means a field was altered. A **link mismatch** means a record
 * was inserted or removed mid-chain. A **sequence gap** means a record was removed and took its
 * link with it — the hole the hash alone cannot see, and the reason the sequence exists.
 *
 * ## Two events, one of them the highest severity in the product
 *
 * `audit.chain-verified` carries the range and the count; `audit.chain-broken` carries where and
 * why. Both go through the outbox, which is the only publication path this product has, and
 * *delivering* the alert is Phase 12's — the notification phase. That is the same position Phase 4
 * took for reminders and Phase 8 for rebuild completion: the row is the record until a consumer
 * exists. A break is also logged at error, because a compliance failure that waits for a
 * notification phase to be built is a compliance failure nobody hears.
 */
@Injectable()
export class AuditVerificationService {
  constructor(
    @Inject(AUDIT_REPOSITORY) private readonly repository: AuditRepository,
    @Inject(AUDIT_CHECKPOINT_STORE) private readonly checkpoints: AuditCheckpointStore,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriter,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK_PORT) private readonly clock: ClockPort,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(METRICS) private readonly metrics: Metrics,
  ) {}

  async verify(): Promise<ChainVerification> {
    const { tenantId } = requireContext();
    const resume = await this.checkpoints.latest();
    const startSequence = resume?.sequence ?? 0n;

    const walk = await this.walkFrom(startSequence, resume?.hash ?? GENESIS_HASH);

    if (!walk.result.intact) {
      // Not a checkpoint: a checkpoint over a broken range would attest the break as though it
      // were history, and the next pass would resume from inside it and find nothing wrong.
      // The counter, on both paths, with `intact` as its only label. 20 §5 pages on an audit chain
      // break at the highest severity, and a metric that were only emitted on success would make
      // the alerting condition "the number stopped moving" — indistinguishable from a deployment
      // where the verification job is not running at all, which is the failure it must detect.
      this.metrics.increment(
        MetricName.AUDIT_CHAIN_VERIFIED,
        { intact: 'false' },
        walk.result.verified,
      );
      this.logger.error('The audit chain failed verification', {
        tenantId,
        brokenAtEventId: walk.result.brokenAt,
        reason: walk.result.reason,
        fromSequence: startSequence.toString(),
      });
      await this.publish(
        auditChainBrokenEvent(asId<AnyId>(walk.result.brokenAt ?? tenantId), {
          brokenAtEventId: walk.result.brokenAt ?? '',
          expectedHash: walk.result.expectedHash ?? '',
          actualHash: walk.result.actualHash ?? '',
          reason: walk.result.reason ?? 'UNKNOWN',
        }),
      );
      return {
        intact: false,
        brokenAt: walk.result.brokenAt,
        reason: walk.result.reason,
        eventsVerified: walk.result.verified,
        fromSequence: startSequence,
        toSequence: startSequence + BigInt(walk.result.verified),
        checkpointed: false,
      };
    }

    const checkpointed = await this.checkpoint(
      walk.lastSequence,
      walk.lastHash,
      walk.result.verified,
    );
    await this.publish(
      auditChainVerifiedEvent(asId<AnyId>(tenantId), {
        from: startSequence.toString(),
        to: walk.lastSequence.toString(),
        eventsVerified: walk.result.verified,
        checkpointed,
      }),
    );
    this.metrics.increment(
      MetricName.AUDIT_CHAIN_VERIFIED,
      { intact: 'true' },
      walk.result.verified,
    );
    this.logger.info('The audit chain verified', {
      tenantId,
      eventsVerified: walk.result.verified,
      toSequence: walk.lastSequence.toString(),
      checkpointed,
    });

    return {
      intact: true,
      brokenAt: null,
      reason: null,
      eventsVerified: walk.result.verified,
      fromSequence: startSequence,
      toSequence: walk.lastSequence,
      checkpointed,
    };
  }

  /**
   * Verifies a range on behalf of an evidence bundle.
   *
   * Separate from `verify` because it answers a different question: not "is the trail sound as far
   * as we have checked" but "does this particular range, the one being exported, chain". It writes
   * no checkpoint and moves no resume point — an export is a read, and a read that advanced the
   * verifier's position would let anyone with `audit:export` skip a night's verification.
   */
  verifyRange(events: readonly AuditEventRecord[], from: string) {
    return verifyChain(events.map(toLink), {
      from,
      ...(events[0] === undefined ? {} : { fromSequence: events[0].sequence }),
    });
  }

  /**
   * The walk itself, in batches, holding one batch at a time.
   *
   * Keyset by sequence rather than offset: both this and the export read the whole range in order,
   * and an offset scan would re-read the prefix on every batch — over millions of rows that is the
   * difference between a pass and an outage.
   */
  private async walkFrom(startSequence: bigint, startHash: string) {
    const budget = this.config.audit.verifyMaxEvents;
    const batchSize = this.config.audit.verifyBatchSize;

    let cursor = startSequence;
    let previousHash = startHash;
    let lastSequence = startSequence;
    let lastHash = startHash;
    let verified = 0;

    for (;;) {
      const remaining = budget - verified;
      if (remaining <= 0) {
        break;
      }
      const slice = await this.unitOfWork.run(() =>
        this.repository.sliceBySequence(cursor, Math.min(batchSize, remaining)),
      );
      if (slice.events.length === 0) {
        break;
      }
      // The digest carried forward, never `slice.from`. On the first batch that digest comes
      // from the resume checkpoint, which is *signed*; on later batches it is the last verified
      // row's. Taking it from the slice instead would verify the batch against itself, and a
      // forged row carrying a consistent `previousHash` would pass.
      const result = verifyChain(slice.events.map(toLink), {
        from: previousHash,
        fromSequence: cursor + 1n,
      });
      verified += result.verified;
      if (!result.intact) {
        return { result: { ...result, verified }, lastSequence, lastHash };
      }
      const last = slice.events.at(-1);
      if (last === undefined) {
        break;
      }
      cursor = last.sequence;
      previousHash = last.hash;
      lastSequence = last.sequence;
      lastHash = last.hash;
    }

    return {
      result: {
        intact: true,
        brokenAt: null,
        reason: null,
        expectedHash: null,
        actualHash: null,
        verified,
      },
      lastSequence,
      lastHash,
    };
  }

  /**
   * Records where the chain had got to, signed, outside the database.
   *
   * Returns false rather than throwing when the deployment cannot write one — no key, or no object
   * store. The pass still ran and still alerts; what it could not do is leave something an auditor
   * can hold against a later reading of the table, and the honest report of that is `false` in the
   * result rather than a silent success. Production refuses to boot without a key, so the only
   * deployments that see `false` are the ones where it is true.
   */
  private async checkpoint(
    sequence: bigint,
    hash: string,
    eventsVerified: number,
  ): Promise<boolean> {
    const secret = this.config.audit.checkpointSecret;
    if (secret === null || !this.checkpoints.available || sequence === 0n) {
      return false;
    }
    const checkpoint: AuditCheckpoint = signCheckpoint(
      {
        tenantId: requireContext().tenantId,
        sequence,
        hash,
        verifiedAt: this.clock.now(),
        eventsVerified,
      },
      secret,
    );
    try {
      await this.checkpoints.write(checkpoint);
      return true;
    } catch (error) {
      // A store that refused is worth an alert and is not worth failing the pass over: the
      // verification's finding — that the chain is sound — is the valuable half, and losing it
      // because a bucket was briefly unavailable would be trading evidence for tidiness.
      this.logger.error('The audit checkpoint could not be written', {
        sequence: sequence.toString(),
        reason: error instanceof Error ? error.message : 'unknown',
      });
      return false;
    }
  }

  private async publish(event: DomainEventDraft): Promise<void> {
    await this.unitOfWork.run(() => this.outbox.publish([event]));
  }
}

function toLink(event: AuditEventRecord): ChainLink {
  return {
    hash: event.hash,
    previousHash: event.previousHash,
    // A row carrying a version this build does not know is treated as the widest one it does,
    // which fails verification rather than passing it. An unknown digest is not a digest to trust.
    version: isChainHashVersion(event.chainHashVersion)
      ? event.chainHashVersion
      : CURRENT_CHAIN_HASH_VERSION,
    event: {
      eventId: event.id,
      tenantId: event.tenantId,
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
      apiClientId: event.apiClientId,
    },
  };
}

export { toLink as toChainLink };
