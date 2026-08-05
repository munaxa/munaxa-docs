import { Injectable } from '@nestjs/common';

import { type AnyId, type ReportDefinitionId, type UserId, asId } from '@edms/domain';
import { type Page, type PageRequest, skipFor, toPage } from '@edms/utils';

import { RecordStamps } from '../../../core/persistence';
import { requireTransaction } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';
import { ExportFormat, isExportFormat } from '../domain/report-catalogue';
import {
  ReportExportState,
  type ReportDefinitionRecord,
  type ReportDefinitionRepository,
  type ReportExportRecord,
  type ReportExportRepository,
  type ReportExportStateKey,
} from '../application/ports';

/**
 * Reporting's own two tables, and the only Prisma in this module.
 *
 * The rule at the head of `application/ports.ts` is that nothing here reads another module's table,
 * and this file is where that would be broken if it were going to be — a repository is exactly the
 * place somebody would add a `document.findMany` because it is right there. It has two models on it
 * and the unit test asserts the count, which is the closest a module that genuinely owns rows can
 * get to Phase 13's enforcement-by-having-no-`infrastructure/`.
 */
@Injectable()
export class PrismaReportDefinitionRepository implements ReportDefinitionRepository {
  constructor(private readonly stamps: RecordStamps) {}

  async findById(id: ReportDefinitionId): Promise<ReportDefinitionRecord | null> {
    const row = await requireTransaction().reportDefinition.findFirst({
      where: { id, tenantId: requireContext().tenantId, deletedAt: null },
    });
    return row === null ? null : toDefinition(row);
  }

  /**
   * By the *definition's* name, scoped to the caller.
   *
   * `findByKey` is Phase 0.5's declared method and its parameter is called `key`, which reads as
   * the catalogue key — and cannot be, because a catalogue key is shared by every saved definition
   * over it and the method returns one row. What it is is the name a person gave their saved
   * report, unique per owner among live rows by `uq_report_definition_name`. It is scoped to the
   * acting caller for the same reason `listFor` takes an owner: a definition is personal, and a
   * lookup that crossed owners would let one person read another's saved filters — which for the
   * deleted-documents report is a list of what somebody has been looking for.
   */
  async findByKey(key: string): Promise<ReportDefinitionRecord | null> {
    const context = requireContext();
    const row = await requireTransaction().reportDefinition.findFirst({
      where: {
        tenantId: context.tenantId,
        ownerUserId: context.userId ?? NO_SUCH_ID,
        name: key,
        deletedAt: null,
      },
    });
    return row === null ? null : toDefinition(row);
  }

  async listFor(ownerId: UserId, page: PageRequest): Promise<Page<ReportDefinitionRecord>> {
    const tx = requireTransaction();
    const where = {
      tenantId: requireContext().tenantId,
      ownerUserId: ownerId as string,
      deletedAt: null,
    };
    const total = await tx.reportDefinition.count({ where });
    if (total === 0) {
      return toPage([], 0, page);
    }
    const rows = await tx.reportDefinition.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      skip: skipFor(page),
      take: page.pageSize,
    });
    return toPage(rows.map(toDefinition), total, page);
  }

  /**
   * Upsert, because `save` is the declared verb and a definition's identifier is chosen by its
   * caller. Renaming one to a name the owner already uses is refused by the partial unique index
   * rather than by a read-then-write, which would have a race in it.
   */
  async save(definition: ReportDefinitionRecord): Promise<void> {
    const tenantId = requireContext().tenantId;
    await requireTransaction().reportDefinition.upsert({
      where: { id: definition.id },
      create: {
        id: definition.id,
        tenantId,
        ownerUserId: definition.ownerId,
        key: definition.key,
        name: definition.name,
        query: definition.query as never,
        ...this.stamps.creation(),
      },
      update: {
        key: definition.key,
        name: definition.name,
        query: definition.query as never,
        ...this.stamps.update(),
      },
    });
  }

  /** Soft delete, like every other administered row — the bin lists documents and folders only. */
  async softDelete(id: ReportDefinitionId): Promise<boolean> {
    const { count } = await requireTransaction().reportDefinition.updateMany({
      where: { id, tenantId: requireContext().tenantId, deletedAt: null },
      data: this.stamps.deletion(),
    });
    return count === 1;
  }
}

/**
 * The export jobs.
 *
 * Ordinary mutable rows: an export is a job with a lifecycle, not a fact in the past tense. What
 * makes it trustworthy is the digest it records of the bytes actually written, and the two
 * `REPORT_EXPORTED` rows in a trail that cannot be rewritten.
 */
@Injectable()
export class PrismaReportExportRepository implements ReportExportRepository {
  constructor(private readonly stamps: RecordStamps) {}

  async insert(record: ReportExportRecord): Promise<void> {
    await requireTransaction().reportExport.create({
      data: {
        id: record.id,
        tenantId: requireContext().tenantId,
        reportKey: record.reportKey,
        format: record.format,
        state: record.state,
        parameters: record.parameters as never,
        requestedById: record.requestedById,
        requestedAt: record.requestedAt,
        ...this.stamps.creation(),
      },
    });
  }

  async findById(id: AnyId): Promise<ReportExportRecord | null> {
    const row = await requireTransaction().reportExport.findFirst({
      where: { id, tenantId: requireContext().tenantId },
    });
    return row === null ? null : toExport(row);
  }

  async list(page: PageRequest): Promise<Page<ReportExportRecord>> {
    const tx = requireTransaction();
    const where = { tenantId: requireContext().tenantId };
    const total = await tx.reportExport.count({ where });
    if (total === 0) {
      return toPage([], 0, page);
    }
    const rows = await tx.reportExport.findMany({
      where,
      orderBy: { requestedAt: 'desc' },
      skip: skipFor(page),
      take: page.pageSize,
    });
    return toPage(rows.map(toExport), total, page);
  }

  /**
   * `REQUESTED → RUNNING`, conditional on the current state.
   *
   * The condition is what makes at-least-once delivery harmless: a redelivered job updates zero
   * rows and the consumer returns, rather than producing a second file under one identifier and
   * overwriting the first one's digest with a different set of bytes.
   */
  async claim(id: AnyId): Promise<boolean> {
    const claimed = await requireTransaction().reportExport.updateMany({
      where: { id, tenantId: requireContext().tenantId, state: ReportExportState.REQUESTED },
      data: { state: ReportExportState.RUNNING, ...this.stamps.update() },
    });
    return claimed.count === 1;
  }

  async complete(
    id: AnyId,
    outcome: {
      readonly rowCount: number;
      readonly storageKey: string;
      readonly fileObjectId: string;
      readonly sizeBytes: number;
      readonly sha256: string;
      readonly truncated: boolean;
      readonly substitutions: number;
    },
  ): Promise<void> {
    await requireTransaction().reportExport.updateMany({
      where: { id, tenantId: requireContext().tenantId },
      data: {
        state: ReportExportState.COMPLETED,
        rowCount: outcome.rowCount,
        storageKey: outcome.storageKey,
        fileObjectId: outcome.fileObjectId,
        sizeBytes: BigInt(outcome.sizeBytes),
        sha256: outcome.sha256,
        truncated: outcome.truncated,
        substitutions: outcome.substitutions,
        completedAt: this.stamps.now(),
        error: null,
        ...this.stamps.update(),
      },
    });
  }

  async fail(id: AnyId, error: string): Promise<void> {
    await requireTransaction().reportExport.updateMany({
      where: { id, tenantId: requireContext().tenantId },
      data: {
        state: ReportExportState.FAILED,
        completedAt: this.stamps.now(),
        // Bounded, because the message reaches an operator's screen and a stack trace pasted into
        // a column is a column nobody reads.
        error: error.slice(0, 1_000),
        ...this.stamps.update(),
      },
    });
  }
}

/** Matches nothing. A caller with no user has no saved definitions rather than everybody's. */
const NO_SUCH_ID = '00000000-0000-0000-0000-000000000000';

interface DefinitionRow {
  id: string;
  key: string;
  name: string;
  ownerUserId: string;
  query: unknown;
}

function toDefinition(row: DefinitionRow): ReportDefinitionRecord {
  return {
    id: asId<ReportDefinitionId>(row.id),
    key: row.key,
    name: row.name,
    ownerId: asId<UserId>(row.ownerUserId),
    query: (row.query ?? {}) as Readonly<Record<string, unknown>>,
  };
}

interface ExportRow {
  id: string;
  reportKey: string;
  format: string;
  state: string;
  parameters: unknown;
  requestedById: string;
  requestedAt: Date;
  rowCount: number;
  storageKey: string | null;
  fileObjectId: string | null;
  sizeBytes: bigint;
  sha256: string | null;
  truncated: boolean;
  substitutions: number;
  completedAt: Date | null;
  error: string | null;
}

function toExport(row: ExportRow): ReportExportRecord {
  return {
    id: asId<AnyId>(row.id),
    reportKey: row.reportKey,
    // Narrowed rather than cast. The column is an enum and cannot hold anything else, but the row
    // arrives as a string and a widening cast here would be the one place a value the catalogue
    // does not know could enter the service.
    format: isExportFormat(row.format) ? row.format : ExportFormat.CSV,
    state: row.state as ReportExportStateKey,
    parameters: (row.parameters ?? {}) as Readonly<Record<string, string>>,
    requestedById: asId<UserId>(row.requestedById),
    requestedAt: row.requestedAt,
    rowCount: row.rowCount,
    storageKey: row.storageKey,
    fileObjectId: row.fileObjectId,
    // `bigint` on the wire is a serialisation hazard and a byte count fits a double comfortably
    // past any file this lane will produce — the same narrowing `file_object.size_bytes` gets.
    sizeBytes: Number(row.sizeBytes),
    sha256: row.sha256,
    truncated: row.truncated,
    substitutions: row.substitutions,
    completedAt: row.completedAt,
    error: row.error,
  };
}
