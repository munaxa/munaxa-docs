import { Injectable } from '@nestjs/common';

import { type AnyId, type UserId, asId } from '@edms/domain';
import { type Page, type PageRequest, skipFor, toPage } from '@edms/utils';

import { requireTransaction } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';
import {
  type AuditExportArtefact,
  type AuditExportRecord,
  type AuditExportRepository,
  AuditExportState,
  type AuditExportStateKey,
} from '../application/ports';

/**
 * The export jobs.
 *
 * Ordinary mutable rows, unlike everything else this module owns — an export is a job with a
 * lifecycle, not a fact in the past tense. What makes it trustworthy is not immutability here but
 * the signed manifest it produces, which is checked against the trail rather than against this row.
 */
@Injectable()
export class PrismaAuditExportRepository implements AuditExportRepository {
  async insert(record: AuditExportRecord): Promise<void> {
    await requireTransaction().auditExport.create({
      data: {
        id: record.id,
        tenantId: requireContext().tenantId,
        state: record.state,
        fromDate: record.from,
        toDate: record.to,
        filters: record.filters as never,
        requestedById: record.requestedById,
        requestedAt: record.requestedAt,
      },
    });
  }

  async findById(id: AnyId): Promise<AuditExportRecord | null> {
    const row = await requireTransaction().auditExport.findFirst({
      where: { id, tenantId: requireContext().tenantId },
    });
    return row === null ? null : toRecord(row);
  }

  async list(page: PageRequest): Promise<Page<AuditExportRecord>> {
    const tx = requireTransaction();
    const where = { tenantId: requireContext().tenantId };

    const total = await tx.auditExport.count({ where });
    if (total === 0) {
      return toPage([], 0, page);
    }
    const rows = await tx.auditExport.findMany({
      where,
      orderBy: { requestedAt: 'desc' },
      skip: skipFor(page),
      take: page.pageSize,
    });
    return toPage(rows.map(toRecord), total, page);
  }

  /**
   * `REQUESTED → RUNNING`, conditional on the current state.
   *
   * The condition is what makes at-least-once delivery harmless: a redelivered job updates zero
   * rows and the consumer returns, rather than producing a second bundle under one identifier and
   * overwriting the first one's manifest with a different set of digests.
   */
  async claim(id: AnyId): Promise<boolean> {
    const claimed = await requireTransaction().auditExport.updateMany({
      where: { id, tenantId: requireContext().tenantId, state: AuditExportState.REQUESTED },
      data: { state: AuditExportState.RUNNING },
    });
    return claimed.count === 1;
  }

  async complete(
    id: AnyId,
    outcome: {
      readonly eventCount: number;
      readonly storagePrefix: string;
      readonly artefacts: readonly AuditExportArtefact[];
      readonly chainIntact: boolean;
      readonly brokenAtId: string | null;
    },
  ): Promise<void> {
    await requireTransaction().auditExport.updateMany({
      where: { id, tenantId: requireContext().tenantId },
      data: {
        state: AuditExportState.COMPLETED,
        eventCount: outcome.eventCount,
        storagePrefix: outcome.storagePrefix,
        artefacts: outcome.artefacts as never,
        chainIntact: outcome.chainIntact,
        brokenAtId: outcome.brokenAtId,
        completedAt: new Date(),
        error: null,
      },
    });
  }

  async fail(id: AnyId, error: string): Promise<void> {
    await requireTransaction().auditExport.updateMany({
      where: { id, tenantId: requireContext().tenantId },
      data: {
        state: AuditExportState.FAILED,
        completedAt: new Date(),
        // Bounded, because the message reaches an operator's screen and a stack trace pasted into
        // a column is a column nobody reads.
        error: error.slice(0, 1_000),
      },
    });
  }
}

interface ExportRow {
  id: string;
  state: string;
  fromDate: Date;
  toDate: Date;
  filters: unknown;
  requestedById: string;
  requestedAt: Date;
  eventCount: number;
  storagePrefix: string | null;
  artefacts: unknown;
  chainIntact: boolean | null;
  brokenAtId: string | null;
  completedAt: Date | null;
  error: string | null;
}

function toRecord(row: ExportRow): AuditExportRecord {
  return {
    id: asId<AnyId>(row.id),
    state: row.state as AuditExportStateKey,
    from: row.fromDate,
    to: row.toDate,
    filters: (row.filters ?? {}) as Readonly<Record<string, string>>,
    requestedById: asId<UserId>(row.requestedById),
    requestedAt: row.requestedAt,
    eventCount: row.eventCount,
    storagePrefix: row.storagePrefix,
    artefacts: (Array.isArray(row.artefacts) ? row.artefacts : []) as AuditExportArtefact[],
    chainIntact: row.chainIntact,
    brokenAtId: row.brokenAtId,
    completedAt: row.completedAt,
    error: row.error,
  };
}
