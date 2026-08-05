import { Injectable } from '@nestjs/common';

import {
  type ActorChannelKey,
  type AnyId,
  type AuditOutcomeKey,
  type AuditSubjectTypeKey,
  type TenantId,
  type UserId,
  asId,
} from '@edms/domain';
import { type Page, type PageRequest, skipFor, toPage } from '@edms/utils';

import { GENESIS_HASH } from '../../../core/audit/hash-chain';
import { requireTransaction } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';
import type {
  AuditEventRecord,
  AuditRepository,
  AuditSearchCriteria,
  ChainSlice,
  ChainTail,
} from '../application/ports';

/**
 * The audit trail's only writer, and its reader.
 *
 * There is no `update` and no `delete` here, and there is nowhere to add one: the application
 * role holds `INSERT` and `SELECT` on this table and nothing else, and a trigger refuses both
 * verbs even for the owner. The interface simply agrees with the database.
 */
@Injectable()
export class PrismaAuditRepository implements AuditRepository {
  /**
   * Serialises audit appends for this tenant, then reads the tail.
   *
   * `pg_advisory_xact_lock` rather than `SELECT … FOR UPDATE`: row locks need privileges the
   * application role deliberately does not have on this table, and there is no row to lock
   * before the first event anyway. The lock is keyed on the tenant, so tenants never wait on
   * each other, and it releases at commit whatever the outcome.
   */
  async lockAndReadTail(): Promise<ChainTail> {
    const tx = requireTransaction();
    const { tenantId } = requireContext();

    await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', tenantId);

    return this.readTail();
  }

  /**
   * The tail, without the lock.
   *
   * For the verifier and the exporter, which append nothing: taking the per-tenant append lock
   * to answer "where does the chain end" would put a nightly pass over millions of rows in
   * front of every write that tenant makes while it runs.
   */
  async readTail(): Promise<ChainTail> {
    const tail = await requireTransaction().auditEvent.findFirst({
      where: { tenantId: requireContext().tenantId },
      orderBy: { sequence: 'desc' },
      select: { sequence: true, hash: true },
    });

    return tail
      ? { sequence: tail.sequence, hash: tail.hash }
      : { sequence: 0n, hash: GENESIS_HASH };
  }

  async append(event: AuditEventRecord): Promise<void> {
    await requireTransaction().auditEvent.create({ data: toRow(event) });
  }

  /**
   * A batch that was chained together before it arrived.
   *
   * One statement rather than N, because the read buffer's whole purpose is to stop a page view
   * costing a round trip. `createMany` is safe here for the reason it usually is not: the rows
   * were assigned their sequences and digests under the same advisory lock that this insert
   * commits within, so there is nothing for a second writer to interleave.
   */
  async appendMany(events: readonly AuditEventRecord[]): Promise<void> {
    if (events.length === 0) {
      return;
    }
    await requireTransaction().auditEvent.createMany({ data: events.map(toRow) });
  }

  async listForSubject(subjectId: AnyId, page: PageRequest): Promise<Page<AuditEventRecord>> {
    const tx = requireTransaction();
    const where = { tenantId: requireContext().tenantId, subjectId };

    const total = await tx.auditEvent.count({ where });
    if (total === 0) {
      return toPage([], 0, page);
    }

    const rows = await tx.auditEvent.findMany({
      where,
      orderBy: [{ occurredAt: 'desc' }, { sequence: 'desc' }],
      skip: skipFor(page),
      take: page.pageSize,
    });
    return toPage(rows.map(toRecord), total, page);
  }

  async listForActor(actorId: UserId, page: PageRequest): Promise<Page<AuditEventRecord>> {
    const tx = requireTransaction();
    const where = { tenantId: requireContext().tenantId, actorId };

    const total = await tx.auditEvent.count({ where });
    if (total === 0) {
      return toPage([], 0, page);
    }
    const rows = await tx.auditEvent.findMany({
      where,
      orderBy: [{ occurredAt: 'desc' }, { sequence: 'desc' }],
      skip: skipFor(page),
      take: page.pageSize,
    });
    return toPage(rows.map(toRecord), total, page);
  }

  async listForVerification(from: Date, to: Date): Promise<readonly AuditEventRecord[]> {
    const rows = await requireTransaction().auditEvent.findMany({
      where: { tenantId: requireContext().tenantId, occurredAt: { gte: from, lte: to } },
      // Sequence, not time: two events in the same millisecond still have one true order, and
      // verifying them in the wrong one would report a break that is not there.
      orderBy: { sequence: 'asc' },
    });
    return rows.map(toRecord);
  }

  /**
   * A window of the chain, and the digest it must chain from.
   *
   * The `from` is read separately rather than inferred from the batch's own first
   * `previousHash`, because taking it from the batch would make the walk verify the batch
   * against itself: a forged row carrying a consistent `previousHash` would pass. It comes
   * from the row *before* the window, or from genesis when there is none.
   */
  async sliceBySequence(afterSequence: bigint, limit: number): Promise<ChainSlice> {
    const tx = requireTransaction();
    const tenantId = requireContext().tenantId;

    const [previous, rows] = await Promise.all([
      afterSequence === 0n
        ? Promise.resolve(null)
        : tx.auditEvent.findFirst({
            where: { tenantId, sequence: afterSequence },
            select: { hash: true },
          }),
      tx.auditEvent.findMany({
        where: { tenantId, sequence: { gt: afterSequence } },
        orderBy: { sequence: 'asc' },
        take: limit,
      }),
    ]);

    return { events: rows.map(toRecord), from: previous?.hash ?? GENESIS_HASH };
  }

  async search(criteria: AuditSearchCriteria, page: PageRequest): Promise<Page<AuditEventRecord>> {
    const tx = requireTransaction();
    const where = {
      tenantId: requireContext().tenantId,
      ...(criteria.actorId === null ? {} : { actorId: criteria.actorId }),
      ...(criteria.actions.length === 0 ? {} : { action: { in: [...criteria.actions] } }),
      ...(criteria.subjectType === null ? {} : { subjectType: criteria.subjectType }),
      ...(criteria.subjectId === null ? {} : { subjectId: criteria.subjectId }),
      ...(criteria.outcome === null ? {} : { outcome: criteria.outcome }),
      ...(criteria.correlationId === null ? {} : { correlationId: criteria.correlationId }),
      ...(criteria.from === null && criteria.to === null
        ? {}
        : {
            occurredAt: {
              ...(criteria.from === null ? {} : { gte: criteria.from }),
              ...(criteria.to === null ? {} : { lte: criteria.to }),
            },
          }),
    };

    const total = await tx.auditEvent.count({ where });
    if (total === 0) {
      return toPage([], 0, page);
    }
    const rows = await tx.auditEvent.findMany({
      where,
      orderBy: [{ occurredAt: 'desc' }, { sequence: 'desc' }],
      skip: skipFor(page),
      take: page.pageSize,
    });
    return toPage(rows.map(toRecord), total, page);
  }

  async distinctActions(): Promise<readonly string[]> {
    const rows = await requireTransaction().auditEvent.findMany({
      where: { tenantId: requireContext().tenantId },
      select: { action: true },
      distinct: ['action'],
      orderBy: { action: 'asc' },
    });
    return rows.map((row) => row.action);
  }
}

interface AuditRow {
  id: string;
  tenantId: string;
  sequence: bigint;
  occurredAt: Date;
  actorId: string | null;
  onBehalfOfId: string | null;
  channel: string;
  action: string;
  subjectType: string;
  subjectId: string;
  outcome: string;
  payload: unknown;
  reason: string | null;
  correlationId: string;
  ipAddress: string | null;
  userAgent: string | null;
  apiClientId: string | null;
  hash: string;
  previousHash: string;
  chainHashVersion: number;
}

function toRow(event: AuditEventRecord) {
  return {
    id: event.id,
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
    payload: event.payload as never,
    reason: event.reason,
    correlationId: event.correlationId,
    ipAddress: event.ipAddress,
    userAgent: event.userAgent,
    apiClientId: event.apiClientId,
    hash: event.hash,
    previousHash: event.previousHash,
    chainHashVersion: event.chainHashVersion,
  };
}

function toRecord(row: AuditRow): AuditEventRecord {
  return {
    id: asId<AnyId>(row.id),
    tenantId: asId<TenantId>(row.tenantId),
    sequence: row.sequence,
    occurredAt: row.occurredAt,
    actorId: row.actorId ? asId<UserId>(row.actorId) : null,
    onBehalfOfId: row.onBehalfOfId ? asId<UserId>(row.onBehalfOfId) : null,
    channel: row.channel as ActorChannelKey,
    action: row.action,
    subjectType: row.subjectType as AuditSubjectTypeKey,
    subjectId: asId<AnyId>(row.subjectId),
    outcome: row.outcome as AuditOutcomeKey,
    payload: (row.payload ?? {}) as Readonly<Record<string, unknown>>,
    reason: row.reason,
    correlationId: row.correlationId,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    apiClientId: row.apiClientId ? asId<AnyId>(row.apiClientId) : null,
    hash: row.hash,
    previousHash: row.previousHash,
    chainHashVersion: row.chainHashVersion,
  };
}
