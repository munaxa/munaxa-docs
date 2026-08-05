import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import {
  type DispositionKey,
  type DocumentId,
  type LegalHoldId,
  type RetentionPolicyId,
  type UserId,
  RetentionScheduleState,
  type RetentionScheduleStateKey,
  type RetentionTriggerKey,
  asId,
} from '@edms/domain';
import { type Page, type PageRequest, normalizePageRequest, skipFor, toPage } from '@edms/utils';

import { RecordStamps } from '../../../core/persistence';
import { requireTransaction } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';
import type {
  LegalHoldRecord,
  LegalHoldRepository,
  NewRetentionSchedule,
  RetentionPolicyReader,
  RetentionScheduleRecord,
  RetentionScheduleRepository,
  TombstoneRecord,
  TombstoneRepository,
} from '../application/ports';

/** The states in which a schedule is still somebody's future work. */
const LIVE_STATES: readonly RetentionScheduleStateKey[] = [
  RetentionScheduleState.PENDING,
  RetentionScheduleState.IN_REVIEW,
  RetentionScheduleState.SUSPENDED,
];

/**
 * The disposition schedule, in the database.
 *
 * `save` is an upsert on the live `(document, trigger)` row rather than an insert, and
 * `uq_retention_schedule_live` is what referees it. The outbox redelivers, publication can be
 * retried, and a folder restore can re-trigger a delete — every one of those must converge on one
 * schedule per fact rather than a queue of duplicates the sweep would execute in turn.
 */
@Injectable()
export class PrismaRetentionScheduleRepository implements RetentionScheduleRepository {
  constructor(private readonly stamps: RecordStamps) {}

  async findForDocument(documentId: DocumentId): Promise<readonly RetentionScheduleRecord[]> {
    const rows = await requireTransaction().retentionSchedule.findMany({
      where: { tenantId: this.tenantId(), documentId },
      orderBy: { createdAt: Prisma.SortOrder.desc },
    });
    return rows.map(toScheduleRecord);
  }

  async findLive(
    documentId: DocumentId,
    trigger: RetentionTriggerKey,
  ): Promise<RetentionScheduleRecord | null> {
    const row = await requireTransaction().retentionSchedule.findFirst({
      where: { tenantId: this.tenantId(), documentId, trigger, state: { in: [...LIVE_STATES] } },
    });
    return row === null ? null : toScheduleRecord(row);
  }

  async findById(id: string): Promise<RetentionScheduleRecord | null> {
    const row = await requireTransaction().retentionSchedule.findFirst({
      where: { id, tenantId: this.tenantId() },
    });
    return row === null ? null : toScheduleRecord(row);
  }

  async listDue(at: Date, limit: number): Promise<readonly RetentionScheduleRecord[]> {
    const rows = await requireTransaction().retentionSchedule.findMany({
      // `SUSPENDED` is deliberately absent: a held schedule is not due, it is waiting, and the
      // release is what puts it back. `ix_retention_schedule_due` covers exactly this predicate.
      where: {
        tenantId: this.tenantId(),
        dueAt: { lte: at },
        state: { in: [RetentionScheduleState.PENDING, RetentionScheduleState.IN_REVIEW] },
      },
      orderBy: { dueAt: Prisma.SortOrder.asc },
      take: limit,
    });
    return rows.map(toScheduleRecord);
  }

  async save(schedule: NewRetentionSchedule): Promise<RetentionScheduleRecord> {
    const tx = requireTransaction();
    const tenantId = this.tenantId();

    const existing = await tx.retentionSchedule.findFirst({
      where: {
        tenantId,
        documentId: schedule.documentId,
        trigger: schedule.trigger,
        state: { in: [...LIVE_STATES] },
      },
    });

    if (existing !== null) {
      // The same trigger fired again — a redelivery, or a genuine re-occurrence (a document
      // deleted, restored and deleted again). The clock restarts from the newer instant, which is
      // the honest reading: the later event is the one the period runs from.
      const updated = await tx.retentionSchedule.update({
        where: { id: existing.id },
        data: {
          policyId: schedule.policyId,
          triggerAt: schedule.triggerAt,
          dueAt: schedule.dueAt,
          disposition: schedule.disposition,
          reviewRequired: schedule.reviewRequired,
          state: RetentionScheduleState.PENDING,
          reviewedById: null,
          reviewedAt: null,
          reviewNote: null,
          version: { increment: 1 },
          ...this.stamps.update(),
        },
      });
      return toScheduleRecord(updated);
    }

    const created = await tx.retentionSchedule.create({
      data: {
        id: this.stamps.nextId(),
        tenantId,
        documentId: schedule.documentId,
        policyId: schedule.policyId,
        trigger: schedule.trigger,
        triggerAt: schedule.triggerAt,
        dueAt: schedule.dueAt,
        disposition: schedule.disposition,
        reviewRequired: schedule.reviewRequired,
        state: RetentionScheduleState.PENDING,
        ...this.stamps.creation(),
      },
    });
    return toScheduleRecord(created);
  }

  async moveState(input: {
    id: string;
    state: RetentionScheduleStateKey;
    reviewedById?: string | null;
    reviewedAt?: Date | null;
    reviewNote?: string | null;
    executedAt?: Date | null;
  }): Promise<void> {
    await requireTransaction().retentionSchedule.updateMany({
      // Guarded by liveness rather than by a version: the sweep is the only writer of terminal
      // states and it runs at concurrency 1, but a redelivered job must find zero live rows and
      // write nothing — moving `EXECUTED` back out of `EXECUTED` is the redelivery bug this
      // predicate exists to make impossible.
      where: { id: input.id, tenantId: this.tenantId(), state: { in: [...LIVE_STATES] } },
      data: {
        state: input.state,
        ...(input.reviewedById !== undefined && { reviewedById: input.reviewedById }),
        ...(input.reviewedAt !== undefined && { reviewedAt: input.reviewedAt }),
        ...(input.reviewNote !== undefined && { reviewNote: input.reviewNote }),
        ...(input.executedAt !== undefined && { executedAt: input.executedAt }),
        version: { increment: 1 },
        ...this.stamps.update(),
      },
    });
  }

  async cancelForTrigger(documentId: DocumentId, trigger: RetentionTriggerKey): Promise<number> {
    const { count } = await requireTransaction().retentionSchedule.updateMany({
      where: {
        tenantId: this.tenantId(),
        documentId,
        trigger,
        state: { in: [...LIVE_STATES] },
      },
      data: {
        state: RetentionScheduleState.CANCELLED,
        version: { increment: 1 },
        ...this.stamps.update(),
      },
    });
    return count;
  }

  async deleteForDocument(documentId: DocumentId): Promise<number> {
    const { count } = await requireTransaction().retentionSchedule.deleteMany({
      where: { tenantId: this.tenantId(), documentId },
    });
    return count;
  }

  async setSuspended(documentId: DocumentId, suspended: boolean): Promise<number> {
    const tx = requireTransaction();
    if (suspended) {
      const { count } = await tx.retentionSchedule.updateMany({
        where: {
          tenantId: this.tenantId(),
          documentId,
          state: { in: [RetentionScheduleState.PENDING, RetentionScheduleState.IN_REVIEW] },
        },
        data: {
          state: RetentionScheduleState.SUSPENDED,
          version: { increment: 1 },
          ...this.stamps.update(),
        },
      });
      return count;
    }
    const { count } = await tx.retentionSchedule.updateMany({
      where: { tenantId: this.tenantId(), documentId, state: RetentionScheduleState.SUSPENDED },
      // Back to `PENDING`, never back to `IN_REVIEW`: an approval given before the matter began
      // is not an approval of the record as it stands after however long the matter ran, so the
      // disposition is re-confirmed rather than resumed.
      data: {
        state: RetentionScheduleState.PENDING,
        reviewedById: null,
        reviewedAt: null,
        reviewNote: null,
        version: { increment: 1 },
        ...this.stamps.update(),
      },
    });
    return count;
  }

  private tenantId(): string {
    return requireContext().tenantId;
  }
}

/**
 * Legal holds, in the database.
 *
 * `release` is a guarded update — `released_at IS NULL` in the predicate — so two people releasing
 * the same hold produce one release and one "already released", the same shape as a task decided
 * once (`05-database-design.md` §6).
 */
@Injectable()
export class PrismaLegalHoldRepository implements LegalHoldRepository {
  constructor(private readonly stamps: RecordStamps) {}

  async listLiveFor(documentId: DocumentId): Promise<readonly LegalHoldRecord[]> {
    const rows = await requireTransaction().legalHold.findMany({
      where: { tenantId: this.tenantId(), documentId, releasedAt: null },
      orderBy: { placedAt: Prisma.SortOrder.asc },
    });
    return rows.map(toHoldRecord);
  }

  async listFor(documentId: DocumentId): Promise<readonly LegalHoldRecord[]> {
    const rows = await requireTransaction().legalHold.findMany({
      where: { tenantId: this.tenantId(), documentId },
      orderBy: { placedAt: Prisma.SortOrder.desc },
    });
    return rows.map(toHoldRecord);
  }

  async findById(id: LegalHoldId): Promise<LegalHoldRecord | null> {
    const row = await requireTransaction().legalHold.findFirst({
      where: { id, tenantId: this.tenantId() },
    });
    return row === null ? null : toHoldRecord(row);
  }

  async heldAmong(documentIds: readonly string[]): Promise<ReadonlySet<string>> {
    if (documentIds.length === 0) {
      return new Set();
    }
    const rows = await requireTransaction().legalHold.findMany({
      where: { tenantId: this.tenantId(), documentId: { in: [...documentIds] }, releasedAt: null },
      select: { documentId: true },
    });
    return new Set(rows.map((row) => row.documentId));
  }

  async place(hold: {
    id: string;
    documentId: string;
    reason: string;
    placedById: string;
    placedAt: Date;
  }): Promise<void> {
    await requireTransaction().legalHold.create({
      data: {
        id: hold.id,
        tenantId: this.tenantId(),
        documentId: hold.documentId,
        reason: hold.reason,
        placedById: hold.placedById,
        placedAt: hold.placedAt,
        ...this.stamps.creation(),
      },
    });
  }

  async deleteForDocument(documentId: DocumentId): Promise<number> {
    const { count } = await requireTransaction().legalHold.deleteMany({
      // Released holds only would be a comforting predicate and a wrong one: the purge has already
      // refused while a live hold existed, inside this same transaction, so an unfiltered delete
      // here removes exactly the released history — and if that reasoning were ever wrong, the
      // integration suite's hold-refuses-purge assertion is what would catch it.
      where: { tenantId: this.tenantId(), documentId },
    });
    return count;
  }

  async release(id: LegalHoldId, releasedBy: string, reason: string, at: Date): Promise<boolean> {
    const { count } = await requireTransaction().legalHold.updateMany({
      where: { id, tenantId: this.tenantId(), releasedAt: null },
      data: {
        releasedAt: at,
        releasedById: releasedBy,
        releaseReason: reason,
        version: { increment: 1 },
        ...this.stamps.update(),
      },
    });
    return count === 1;
  }

  private tenantId(): string {
    return requireContext().tenantId;
  }
}

/**
 * What a purged document leaves behind.
 *
 * `write` is an upsert on the document identifier rather than an insert. A purge retried after a
 * partial failure would otherwise fail on the primary key of the row its first attempt committed —
 * and a tombstone is idempotent by nature: there is only one destruction to describe.
 */
@Injectable()
export class PrismaTombstoneRepository implements TombstoneRepository {
  async write(tombstone: {
    documentId: string;
    documentNumber: string | null;
    title: string;
    documentTypeId: string | null;
    documentTypeName: string | null;
    folderPath: string | null;
    deletedAt: Date | null;
    purgedAt: Date;
    purgedById: string | null;
    scheduleId: string | null;
    policyId: string | null;
    approvedById: string | null;
    revisionsRemoved: number;
    blobsDereferenced: number;
  }): Promise<void> {
    const tenantId = this.tenantId();
    await requireTransaction().documentTombstone.upsert({
      where: { documentId: tombstone.documentId },
      create: { tenantId, ...tombstone },
      update: {},
    });
  }

  async findByDocument(documentId: DocumentId): Promise<TombstoneRecord | null> {
    const row = await requireTransaction().documentTombstone.findFirst({
      where: { documentId, tenantId: this.tenantId() },
    });
    return row === null ? null : toTombstoneRecord(row);
  }

  async list(request: PageRequest): Promise<Page<TombstoneRecord>> {
    const normalized = normalizePageRequest(request);
    const tx = requireTransaction();
    const where = { tenantId: this.tenantId() };
    const [rows, total] = await Promise.all([
      tx.documentTombstone.findMany({
        where,
        orderBy: { purgedAt: Prisma.SortOrder.desc },
        skip: skipFor(normalized),
        take: normalized.pageSize,
      }),
      tx.documentTombstone.count({ where }),
    ]);
    return toPage(rows.map(toTombstoneRecord), total, normalized);
  }

  private tenantId(): string {
    return requireContext().tenantId;
  }
}

// --- Mapping --------------------------------------------------------------------------------

interface ScheduleRow {
  id: string;
  documentId: string;
  policyId: string | null;
  trigger: string;
  triggerAt: Date;
  dueAt: Date;
  disposition: string;
  state: string;
  reviewRequired: boolean;
  reviewedById: string | null;
  reviewedAt: Date | null;
  reviewNote: string | null;
  executedAt: Date | null;
  version: number;
}

function toScheduleRecord(row: ScheduleRow): RetentionScheduleRecord {
  return {
    id: row.id,
    documentId: asId(row.documentId),
    policyId: row.policyId === null ? null : asId<RetentionPolicyId>(row.policyId),
    trigger: row.trigger as RetentionScheduleRecord['trigger'],
    triggerAt: row.triggerAt,
    dueAt: row.dueAt,
    disposition: row.disposition as RetentionScheduleRecord['disposition'],
    state: row.state as RetentionScheduleRecord['state'],
    reviewRequired: row.reviewRequired,
    reviewedById: row.reviewedById === null ? null : asId<UserId>(row.reviewedById),
    reviewedAt: row.reviewedAt,
    reviewNote: row.reviewNote,
    executedAt: row.executedAt,
    version: row.version,
  };
}

interface HoldRow {
  id: string;
  documentId: string;
  reason: string;
  placedById: string;
  placedAt: Date;
  releasedAt: Date | null;
  releasedById: string | null;
  releaseReason: string | null;
  version: number;
}

function toHoldRecord(row: HoldRow): LegalHoldRecord {
  return {
    id: asId(row.id),
    documentId: asId(row.documentId),
    reason: row.reason,
    placedBy: asId<UserId>(row.placedById),
    placedAt: row.placedAt,
    releasedAt: row.releasedAt,
    releasedById: row.releasedById === null ? null : asId<UserId>(row.releasedById),
    releaseReason: row.releaseReason,
    version: row.version,
  };
}

interface TombstoneRow {
  documentId: string;
  documentNumber: string | null;
  title: string;
  documentTypeName: string | null;
  folderPath: string | null;
  deletedAt: Date | null;
  purgedAt: Date;
  purgedById: string | null;
  revisionsRemoved: number;
  blobsDereferenced: number;
}

function toTombstoneRecord(row: TombstoneRow): TombstoneRecord {
  return {
    documentId: asId(row.documentId),
    documentNumber: row.documentNumber,
    title: row.title,
    documentTypeName: row.documentTypeName,
    folderPath: row.folderPath,
    deletedAt: row.deletedAt,
    purgedAt: row.purgedAt,
    purgedById: row.purgedById === null ? null : asId<UserId>(row.purgedById),
    revisionsRemoved: row.revisionsRemoved,
    blobsDereferenced: row.blobsDereferenced,
  };
}

/**
 * Retention's read of the policy register.
 *
 * Rows-as-rows, like Search's source reader: `retention_policy` is administered by
 * Administration and *consumed* here, at trigger time, where its terms are copied onto the
 * schedule (ADR-0010 §7). A soft-deleted policy still answers — a document that froze a policy
 * before somebody retired it is still governed by what it froze.
 */
@Injectable()
export class PrismaRetentionPolicyReader implements RetentionPolicyReader {
  async read(policyId: string): Promise<{
    readonly id: string;
    readonly trigger: RetentionTriggerKey;
    readonly periodMonths: number;
    readonly disposition: DispositionKey;
    readonly reviewRequired: boolean;
  } | null> {
    const row = await requireTransaction().retentionPolicy.findFirst({
      where: { id: policyId, tenantId: requireContext().tenantId },
      select: {
        id: true,
        trigger: true,
        periodMonths: true,
        disposition: true,
        reviewRequired: true,
      },
    });
    return row === null
      ? null
      : {
          id: row.id,
          trigger: row.trigger,
          periodMonths: row.periodMonths,
          disposition: row.disposition,
          reviewRequired: row.reviewRequired,
        };
  }
}
