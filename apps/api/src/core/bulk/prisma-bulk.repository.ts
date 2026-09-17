import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import {
  type AnyId,
  type BulkItemOutcomeKey,
  BulkOperationState,
  type BulkOperationKindKey,
  type BulkOperationStateKey,
  type BulkTally,
  type ErrorCodeKey,
  type UserId,
  asId,
} from '@edms/domain';
import { type Page, type PageRequest, skipFor, toPage } from '@edms/utils';

import { RecordStamps } from '../persistence/record-stamps';
import { requireTransaction } from '../prisma/unit-of-work';
import { requireContext } from '../tenancy/tenant-context';
import type {
  BulkItemResult,
  BulkOperationRecord,
  BulkOperationRepository,
  QueuedWork,
} from './bulk.port';

/**
 * The bulk operation record, in the database.
 *
 * Two tables, in `core/` rather than in a module, for the same reason the outbox and the audit
 * trail are: the record is *about* an act rather than about a document, five modules produce one,
 * and none of them owns it. Putting it in Document would have made the workflow module's bulk
 * approval reach into another module's repository, which is precisely the cross-module call the
 * boundary lint forbids.
 */
@Injectable()
export class PrismaBulkOperationRepository implements BulkOperationRepository {
  constructor(private readonly stamps: RecordStamps) {}

  async open(input: {
    readonly id: string;
    readonly kind: BulkOperationKindKey;
    readonly requestedById: string;
    readonly requestedAt: Date;
    readonly parameters: Readonly<Record<string, unknown>>;
    readonly requested: number;
    readonly payload?: QueuedWork | undefined;
  }): Promise<void> {
    await requireTransaction().bulkOperation.create({
      data: {
        id: input.id,
        tenantId: this.tenantId(),
        kind: input.kind,
        requestedById: input.requestedById,
        requestedAt: input.requestedAt,
        parameters: input.parameters as Prisma.InputJsonObject,
        // Phase 6.2: written only for a queued operation, and never copied into the audit row.
        ...(input.payload !== undefined && {
          payload: input.payload as unknown as Prisma.InputJsonObject,
        }),
        requested: input.requested,
        ...this.stamps.creation(),
      },
    });
  }

  /** The queued job's own input. Null for a synchronous operation, which has nothing to rebuild. */
  async payloadOf(id: string): Promise<QueuedWork | null> {
    const row = await requireTransaction().bulkOperation.findFirst({
      where: { id, tenantId: this.tenantId() },
      select: { payload: true },
    });
    return (row?.payload ?? null) as QueuedWork | null;
  }

  /**
   * The targets this operation has already settled.
   *
   * Served by `ix_bulk_operation_item_outcome` as a prefix scan on `(tenant_id, operation_id)`.
   * Read once per delivery rather than per object: five thousand existence checks would be five
   * thousand round trips to answer a question one query answers.
   */
  async settledTargets(operationId: string): Promise<ReadonlySet<string>> {
    const rows = await requireTransaction().bulkOperationItem.findMany({
      where: { tenantId: this.tenantId(), operationId },
      select: { targetId: true },
    });
    return new Set(rows.map((row) => row.targetId));
  }

  /** The tally so far. Deliberately does not touch `state` — the consumer owns that. */
  async progress(id: string, tally: BulkTally): Promise<void> {
    await requireTransaction().bulkOperation.updateMany({
      where: { id, tenantId: this.tenantId() },
      data: {
        requested: tally.requested,
        applied: tally.applied,
        refused: tally.refused,
        blocked: tally.blocked,
        failed: tally.failed,
        ...this.stamps.update(),
      },
    });
  }

  /**
   * The tally, counted from the item rows.
   *
   * One grouped query rather than five counts, and read at completion rather than accumulated in
   * memory — so a resumed operation's final counts describe every delivery that contributed to it.
   */
  async tallyOf(operationId: string): Promise<BulkTally> {
    const rows = await requireTransaction().bulkOperationItem.groupBy({
      by: ['outcome'],
      where: { tenantId: this.tenantId(), operationId },
      _count: { _all: true },
    });
    const counted = (outcome: string): number =>
      rows.find((row) => row.outcome === outcome)?._count._all ?? 0;
    const applied = counted('APPLIED');
    const refused = counted('REFUSED');
    const blocked = counted('BLOCKED');
    const failed = counted('FAILED');
    return { requested: applied + refused + blocked + failed, applied, refused, blocked, failed };
  }

  /**
   * Records that the *operation* did not finish — the lane died, a plan factory is missing, the
   * requester was suspended while it ran.
   *
   * `state: { not: COMPLETED }` is the same write-once rule `finish` carries, and it is here for
   * the case `finish`'s predicate does not cover — Slice 97. The lane delivers at least once and a
   * stalled handler keeps running, so two deliveries of one operation overlap; that much is the
   * accepted design, and the per-object work converges under it. But a delivery that overlapped
   * one which *finished* can still reach this method without throwing anything, because
   * `BulkRequesterDirectory` answers null for a requester who is no longer `ACTIVE` and the
   * consumer's answer to that is to fail the operation. Without the predicate it failed a run that
   * had already completed, and already told its requester so.
   *
   * `FAILED` is what tells a reader the per-object counts are incomplete rather than final. A
   * completed operation's counts are final, so this must not reach one. No caller reads the count:
   * nothing is published or recorded on the strength of this write, and the database refusing it
   * is the whole of what was needed.
   */
  async markFailed(id: string, reason: string, at: Date): Promise<void> {
    await requireTransaction().bulkOperation.updateMany({
      where: {
        id,
        tenantId: this.tenantId(),
        state: { not: BulkOperationState.COMPLETED },
      },
      data: { state: 'FAILED', completedAt: at, error: reason, ...this.stamps.update() },
    });
  }

  async start(id: string, at: Date): Promise<void> {
    await requireTransaction().bulkOperation.updateMany({
      where: { id, tenantId: this.tenantId() },
      data: { state: 'RUNNING', startedAt: at, ...this.stamps.update() },
    });
  }

  /**
   * Upserted on `(operation_id, target_id)`.
   *
   * A queued job that is redelivered re-runs its objects, and the second pass must overwrite the
   * first outcome rather than fail on the unique index — a duplicate-key error here would turn a
   * harmless redelivery into a dead-lettered operation. Overwriting is right rather than merely
   * convenient: the second pass is the more recent answer.
   */
  async recordItem(input: {
    readonly id: string;
    readonly operationId: string;
    readonly targetId: string;
    readonly outcome: BulkItemOutcomeKey;
    readonly errorCode: string | null;
    readonly detail: string | null;
  }): Promise<void> {
    await requireTransaction().bulkOperationItem.upsert({
      where: {
        operationId_targetId: { operationId: input.operationId, targetId: input.targetId },
      },
      create: {
        id: input.id,
        tenantId: this.tenantId(),
        operationId: input.operationId,
        targetId: input.targetId,
        outcome: input.outcome,
        errorCode: input.errorCode,
        detail: input.detail,
      },
      update: {
        outcome: input.outcome,
        errorCode: input.errorCode,
        detail: input.detail,
      },
    });
  }

  /**
   * Settles the operation, and answers whether *this* delivery is the one that settled it.
   *
   * `state: { not: COMPLETED }` is the claim — Slice 95, and `settle`'s idiom for `settle`'s
   * reason. The lane delivers at least once and a stalled handler keeps running, so two deliveries
   * of one operation overlap: the consumer's `record.state === COMPLETED` guard turns away the one
   * that arrives after the first finished, and cannot turn away the one that arrives while it is
   * still running. Both then reach here.
   *
   * Their per-object work converges by design — `recordItem` upserts and `settledTargets` makes
   * the successor skip what is settled — and that is deliberately untouched. What does not
   * converge is the announcement beside this call, which is why the affected-row count is now the
   * caller's answer rather than something thrown away.
   */
  async finish(input: {
    readonly id: string;
    readonly state: BulkOperationStateKey;
    readonly tally: BulkTally;
    readonly at: Date;
    readonly error: string | null;
  }): Promise<boolean> {
    const { count } = await requireTransaction().bulkOperation.updateMany({
      where: {
        id: input.id,
        tenantId: this.tenantId(),
        state: { not: BulkOperationState.COMPLETED },
      },
      data: {
        state: input.state,
        requested: input.tally.requested,
        applied: input.tally.applied,
        refused: input.tally.refused,
        blocked: input.tally.blocked,
        failed: input.tally.failed,
        completedAt: input.at,
        error: input.error,
        ...this.stamps.update(),
      },
    });
    return count > 0;
  }

  /**
   * Attaches the export's artefact, and answers the blob it displaced — Slice 99.
   *
   * The row is taken `FOR UPDATE` before it is read, which is what makes the answer true rather
   * than a moment old. Two deliveries of one export both store a manifest and both take a
   * reference on it; without the lock both would read the same pointer and neither would learn it
   * had replaced the other's.
   *
   * The caller releases whatever comes back. That is `PreviewArtifactRepository.save`'s contract —
   * "a fresh row claims its blob, a replacement also releases the displaced one" — and without it
   * the displaced manifest keeps a reference nothing points at, so `listReclaimable` never selects
   * it and the bytes can never be disposed of.
   */
  async attachArtifact(input: {
    readonly id: string;
    readonly fileObjectId: string;
    readonly sizeBytes: number;
    readonly sha256: string;
  }): Promise<{ readonly displacedFileObjectId: string | null }> {
    const tx = requireTransaction();
    const tenantId = this.tenantId();
    const held = await tx.$queryRaw<{ file_object_id: string | null }[]>`
      SELECT file_object_id FROM bulk_operation
      WHERE id = ${input.id}::uuid AND tenant_id = ${tenantId}::uuid
      FOR UPDATE`;
    const displaced = held[0]?.file_object_id ?? null;
    await tx.bulkOperation.updateMany({
      where: { id: input.id, tenantId },
      data: {
        fileObjectId: input.fileObjectId,
        sizeBytes: BigInt(input.sizeBytes),
        sha256: input.sha256,
        ...this.stamps.update(),
      },
    });
    return { displacedFileObjectId: displaced };
  }

  async findById(id: string): Promise<BulkOperationRecord | null> {
    const row = await requireTransaction().bulkOperation.findFirst({
      where: { id, tenantId: this.tenantId() },
    });
    return row === null ? null : toRecord(row);
  }

  /**
   * One person's own operations.
   *
   * Scoped to the requester rather than to the tenant, and there is no parameter by which to ask
   * about anybody else — Phase 13's shape for a personal list, for the same reason: an operation
   * record names what somebody selected, and a tenant-wide list of them is a list of what every
   * colleague has been working through. The tenant-wide reading is a *report*, gated on its own
   * permission, and Phase 15 owns reports.
   */
  async listFor(requestedById: UserId, page: PageRequest): Promise<Page<BulkOperationRecord>> {
    const tx = requireTransaction();
    const where = { tenantId: this.tenantId(), requestedById: requestedById as string };
    const [rows, total] = await Promise.all([
      tx.bulkOperation.findMany({
        where,
        orderBy: { requestedAt: 'desc' },
        skip: skipFor(page),
        take: page.pageSize,
      }),
      tx.bulkOperation.count({ where }),
    ]);
    return toPage(rows.map(toRecord), total, page);
  }

  async itemsOf(operationId: string, page: PageRequest): Promise<Page<BulkItemResult>> {
    const tx = requireTransaction();
    const where = { tenantId: this.tenantId(), operationId };
    const [rows, total] = await Promise.all([
      tx.bulkOperationItem.findMany({
        where,
        // By outcome first, so the refusals and blocks — the rows somebody opened this screen to
        // read — are the first page rather than scattered through the applied ones.
        orderBy: [{ outcome: 'asc' }, { targetId: 'asc' }],
        skip: skipFor(page),
        take: page.pageSize,
      }),
      tx.bulkOperationItem.count({ where }),
    ]);
    return toPage(
      rows.map((row) => ({
        targetId: row.targetId,
        outcome: row.outcome,
        errorCode: row.errorCode as ErrorCodeKey | null,
        detail: row.detail,
      })),
      total,
      page,
    );
  }

  private tenantId(): string {
    return requireContext().tenantId;
  }
}

interface BulkRow {
  id: string;
  kind: string;
  state: string;
  requestedById: string;
  requestedAt: Date;
  parameters: unknown;
  requested: number;
  applied: number;
  refused: number;
  blocked: number;
  failed: number;
  fileObjectId: string | null;
  sizeBytes: bigint;
  sha256: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  error: string | null;
}

function toRecord(row: BulkRow): BulkOperationRecord {
  return {
    id: asId<AnyId>(row.id),
    kind: row.kind as BulkOperationKindKey,
    state: row.state as BulkOperationStateKey,
    requestedById: asId<UserId>(row.requestedById),
    requestedAt: row.requestedAt,
    parameters: (row.parameters ?? {}) as Readonly<Record<string, unknown>>,
    tally: {
      requested: row.requested,
      applied: row.applied,
      refused: row.refused,
      blocked: row.blocked,
      failed: row.failed,
    },
    fileObjectId: row.fileObjectId,
    sizeBytes: Number(row.sizeBytes),
    sha256: row.sha256,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    error: row.error,
  };
}
