import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import {
  type DocumentId,
  type RevisionId,
  type RevisionStatusKey,
  type ScanStatusKey,
  asId,
  calendarDay,
} from '@edms/domain';

import { requireTransaction } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';
import type { RevisionHistoryRow, RevisionQuery, SnapshotEntry } from '../application/ports';

/**
 * The revision history, read whole.
 *
 * One query with its joins — the file, the author's name, the restore source's label — never
 * a query per row: a history of forty revisions is one screen, and forty file lookups is how
 * a document system starts feeling slow at exactly the scale customers reach.
 *
 * Discarded revisions are in the list. Their ordinals are spent, and a history that hides
 * them is a history with unexplained gaps — the opposite of evidence.
 */
@Injectable()
export class PrismaRevisionQueryRepository implements RevisionQuery {
  async historyFor(documentId: DocumentId): Promise<readonly RevisionHistoryRow[]> {
    const rows = await requireTransaction().documentRevision.findMany({
      where: { documentId, tenantId: this.tenantId(), deletedAt: null },
      orderBy: { ordinal: Prisma.SortOrder.asc },
      include: INCLUDE,
    });
    const names = await this.authorNames(rows.map((row) => row.createdBy));
    return rows.map((row) => toHistoryRow(row as JoinedRevision, names));
  }

  async byOrdinal(documentId: DocumentId, ordinal: number): Promise<RevisionHistoryRow | null> {
    const row = await requireTransaction().documentRevision.findFirst({
      where: { documentId, ordinal, tenantId: this.tenantId(), deletedAt: null },
      include: INCLUDE,
    });
    if (row === null) {
      return null;
    }
    const names = await this.authorNames([row.createdBy]);
    return toHistoryRow(row, names);
  }

  /**
   * The authors' display names, one batched read. `created_by` is an audit stamp rather than
   * a foreign key — a departed author must never block a revision row — so the join is by
   * hand, and a name that no longer resolves renders as absent rather than failing the list.
   */
  private async authorNames(ids: readonly (string | null)[]): Promise<ReadonlyMap<string, string>> {
    const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
    if (wanted.length === 0) {
      return new Map();
    }
    const users = await requireTransaction().user.findMany({
      where: { id: { in: wanted }, tenantId: this.tenantId() },
      select: { id: true, displayName: true },
    });
    return new Map(users.map((user) => [user.id, user.displayName]));
  }

  private tenantId(): string {
    return requireContext().tenantId;
  }
}

const INCLUDE = {
  fileObject: true,
  restoredFrom: { select: { label: true } },
} as const;

interface JoinedRevision {
  id: string;
  ordinal: number;
  label: string;
  status: string;
  changeNote: string | null;
  createdAt: Date;
  createdBy: string | null;
  publishedAt: Date | null;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
  restoredFromRevisionId: string | null;
  metadataSnapshot: unknown;
  filename: string;
  fileObject: {
    id: string;
    mimeType: string;
    sizeBytes: bigint;
    checksumSha256: string;
    scanStatus: string;
  };
  restoredFrom: { label: string } | null;
}

function toHistoryRow(row: JoinedRevision, names: ReadonlyMap<string, string>): RevisionHistoryRow {
  return {
    id: asId<RevisionId>(row.id),
    ordinal: row.ordinal,
    label: row.label,
    status: row.status as RevisionStatusKey,
    changeNote: row.changeNote,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    createdByName: row.createdBy === null ? null : (names.get(row.createdBy) ?? null),
    publishedAt: row.publishedAt,
    // Stored as `date` columns; rendered back to the calendar day they are. The UTC clock is
    // correct here because the column carries midnight UTC of the stored day by construction.
    effectiveFrom: row.effectiveFrom === null ? null : calendarDay(row.effectiveFrom, 'UTC'),
    effectiveTo: row.effectiveTo === null ? null : calendarDay(row.effectiveTo, 'UTC'),
    restoredFromRevisionId: row.restoredFromRevisionId,
    restoredFromLabel: row.restoredFrom?.label ?? null,
    metadataSnapshot: asSnapshot(row.metadataSnapshot),
    file: {
      fileObjectId: row.fileObject.id,
      filename: row.filename,
      mimeType: row.fileObject.mimeType,
      sizeBytes: Number(row.fileObject.sizeBytes),
      checksumSha256: row.fileObject.checksumSha256,
      scanStatus: row.fileObject.scanStatus as ScanStatusKey,
    },
  };
}

/** The snapshot publication wrote, narrowed from `jsonb` without trusting it blindly. */
function asSnapshot(raw: unknown): Readonly<Record<string, SnapshotEntry>> | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const snapshot: Record<string, SnapshotEntry> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value !== null && typeof value === 'object' && 'value' in value) {
      const entry = value as { name?: unknown; dataType?: unknown; value: unknown };
      snapshot[key] = {
        name: typeof entry.name === 'string' ? entry.name : key,
        dataType: typeof entry.dataType === 'string' ? entry.dataType : 'TEXT',
        value: entry.value,
      };
    }
  }
  return snapshot;
}
