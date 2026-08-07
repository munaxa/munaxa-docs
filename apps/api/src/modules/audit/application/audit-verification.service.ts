import { Inject, Injectable } from '@nestjs/common';

import { asId, type AnyId, type DomainEventDraft } from '@edms/domain';

import { APP_CONFIG, type AppConfig } from '../../../core/config';
import { GENESIS_HASH } from '../../../core/audit/hash-chain';
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
  CHAIN_VERIFIER,
  isTampering,
  type AuditCheckpoint,
  type AuditCheckpointStore,
  type AuditEventRecord,
  type AuditRepository,
  type ChainTail,
  type ChainVerification,
  type ChainVerifier,
  type SliceVerification,
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
    @Inject(CHAIN_VERIFIER) private readonly verifier: ChainVerifier,
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
      // Two different messages, because they are two different findings. A tamper report says
      // somebody altered the trail; an unverifiable record says this build could not check it —
      // an unrecognised canonical format, or a record missing an identifier its format hashes.
      // Both fail the pass and both refuse a checkpoint, because a range that was not verified
      // must not be attested as though it were. Only one of them accuses anybody.
      const tampering = walk.result.reason !== null && isTampering(walk.result.reason);
      this.logger.error(
        tampering ? 'The audit chain failed verification' : 'The audit chain could not be verified',
        {
          tenantId,
          brokenAtEventId: walk.result.brokenAt,
          reason: walk.result.reason,
          tampering,
          fromSequence: startSequence.toString(),
        },
      );
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
  verifyRange(events: readonly AuditEventRecord[], from: string): SliceVerification {
    const first = events[0];
    // The head the batch must continue from: the digest the caller carried forward, at the
    // position immediately before the batch's own first record. Exactly what this method asserted
    // before the migration, when it passed `from` and `fromSequence` as two arguments.
    const head: ChainTail | null =
      first === undefined ? null : { sequence: first.sequence - 1n, hash: from };
    return this.verifier.verify(
      events,
      head?.hash === GENESIS_HASH && head.sequence === 0n ? null : head,
    );
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

    // One value now, not two: a resume point is a position *and* a digest, and the Platform's
    // `from` takes both together. Threading them separately is what made a record removed from
    // the front of a batch invisible before this migration.
    let head: ChainTail | null =
      startSequence === 0n && startHash === GENESIS_HASH
        ? null
        : { sequence: startSequence, hash: startHash };
    let lastSequence = startSequence;
    let lastHash = startHash;
    let verified = 0;

    for (;;) {
      const remaining = budget - verified;
      if (remaining <= 0) {
        break;
      }
      const slice = await this.unitOfWork.run(() =>
        this.repository.sliceBySequence(head?.sequence ?? 0n, Math.min(batchSize, remaining)),
      );
      if (slice.events.length === 0) {
        break;
      }
      // The head carried forward, never `slice.from`. On the first batch it comes from the resume
      // checkpoint, which is *signed*; on later batches it is the last verified row's. Taking it
      // from the slice instead would verify the batch against itself, and a forged row carrying a
      // consistent `previousHash` would pass.
      const result = this.verifier.verify(slice.events, head);
      verified += result.verified;
      if (!result.intact) {
        return { result: { ...result, verified }, lastSequence, lastHash };
      }
      const last = slice.events.at(-1);
      if (last === undefined) {
        break;
      }
      head = { sequence: last.sequence, hash: last.hash };
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
