import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { type UserId, asId } from '@edms/domain';

import { VersionConflictError } from '../../../core/errors/application-errors';
import { RecordStamps } from '../../../core/persistence/record-stamps';
import { requireTransaction } from '../../../core/prisma';
import { requireContext } from '../../../core/tenancy/tenant-context';
import type {
  RecentSearchRecord,
  RecentSearchRepository,
  SavedSearchRecord,
  SavedSearchRepository,
  SearchRebuildRecord,
  SearchRebuildRepository,
  SearchRebuildStateKey,
} from '../application/ports';

/** One person's named searches. Soft-deleted and versioned like every aggregate root. */
@Injectable()
export class PrismaSavedSearchRepository implements SavedSearchRepository {
  constructor(private readonly stamps: RecordStamps) {}

  async findById(id: string): Promise<SavedSearchRecord | null> {
    const row = await requireTransaction().savedSearch.findFirst({
      where: { id, tenantId: this.tenantId(), deletedAt: null },
    });
    return row === null ? null : toSavedSearch(row);
  }

  async listFor(ownerId: UserId): Promise<readonly SavedSearchRecord[]> {
    const rows = await requireTransaction().savedSearch.findMany({
      where: { tenantId: this.tenantId(), ownerUserId: ownerId, deletedAt: null },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    });
    return rows.map(toSavedSearch);
  }

  async create(record: {
    readonly id: string;
    readonly ownerId: UserId;
    readonly name: string;
    readonly query: string;
    readonly filters: Readonly<Record<string, readonly string[]>>;
  }): Promise<void> {
    await requireTransaction().savedSearch.create({
      data: {
        id: record.id,
        tenantId: this.tenantId(),
        ownerUserId: record.ownerId,
        name: record.name,
        query: record.query,
        filters: record.filters,
        ...this.stamps.creation(),
      },
    });
  }

  async update(
    id: string,
    expectedVersion: number,
    changes: {
      readonly name?: string;
      readonly query?: string;
      readonly filters?: Readonly<Record<string, readonly string[]>>;
    },
  ): Promise<void> {
    const result = await requireTransaction().savedSearch.updateMany({
      where: { id, tenantId: this.tenantId(), deletedAt: null, version: expectedVersion },
      data: {
        ...(changes.name === undefined ? {} : { name: changes.name }),
        ...(changes.query === undefined ? {} : { query: changes.query }),
        ...(changes.filters === undefined ? {} : { filters: changes.filters }),
        version: { increment: 1 },
        ...this.stamps.update(),
      },
    });
    if (result.count === 0) {
      // The row moved between the service's read and this write — a same-instant race.
      throw new VersionConflictError(expectedVersion, -1);
    }
  }

  async softDelete(id: string, expectedVersion: number): Promise<void> {
    const result = await requireTransaction().savedSearch.updateMany({
      where: { id, tenantId: this.tenantId(), deletedAt: null, version: expectedVersion },
      data: { version: { increment: 1 }, ...this.stamps.deletion() },
    });
    if (result.count === 0) {
      // The row moved between the service's read and this write — a same-instant race.
      throw new VersionConflictError(expectedVersion, -1);
    }
  }

  private tenantId(): string {
    return requireContext().tenantId;
  }
}

/**
 * One person's recent queries: refreshed on repetition, pruned to the cap on every write.
 * The digest keys "identical": same trimmed query, same filters, one row.
 */
@Injectable()
export class PrismaRecentSearchRepository implements RecentSearchRepository {
  async record(
    userId: UserId,
    entry: { readonly id: string } & RecentSearchRecord,
    keep: number,
  ): Promise<void> {
    const tx = requireTransaction();
    const tenantId = requireContext().tenantId;
    const queryHash = digestOf(entry.query, entry.filters);
    await tx.recentSearch.upsert({
      where: { tenantId_userId_queryHash: { tenantId, userId, queryHash } },
      create: {
        id: entry.id,
        tenantId,
        userId,
        query: entry.query,
        filters: entry.filters,
        queryHash,
        searchedAt: entry.searchedAt,
      },
      update: { searchedAt: entry.searchedAt, filters: entry.filters },
    });
    // Prune past the cap, oldest first — in the same transaction, so the list can never
    // grow without bound between requests.
    const stale = await tx.recentSearch.findMany({
      where: { tenantId, userId },
      orderBy: [{ searchedAt: 'desc' }, { id: 'desc' }],
      skip: keep,
      select: { id: true },
    });
    if (stale.length > 0) {
      await tx.recentSearch.deleteMany({ where: { id: { in: stale.map((row) => row.id) } } });
    }
  }

  async listFor(userId: UserId, limit: number): Promise<readonly RecentSearchRecord[]> {
    const rows = await requireTransaction().recentSearch.findMany({
      where: { tenantId: requireContext().tenantId, userId },
      orderBy: [{ searchedAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return rows.map((row) => ({
      query: row.query,
      filters: filtersOf(row.filters),
      searchedAt: row.searchedAt,
    }));
  }
}

/** The rebuild's state row — what makes a rebuild resumable rather than restartable. */
@Injectable()
export class PrismaSearchRebuildRepository implements SearchRebuildRepository {
  constructor(private readonly stamps: RecordStamps) {}

  async findRunning(): Promise<SearchRebuildRecord | null> {
    const row = await requireTransaction().searchRebuild.findFirst({
      where: { tenantId: requireContext().tenantId, state: 'RUNNING' },
    });
    return row === null ? null : toRebuild(row);
  }

  async findLatest(): Promise<SearchRebuildRecord | null> {
    const row = await requireTransaction().searchRebuild.findFirst({
      where: { tenantId: requireContext().tenantId },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    });
    return row === null ? null : toRebuild(row);
  }

  async findById(id: string): Promise<SearchRebuildRecord | null> {
    const row = await requireTransaction().searchRebuild.findFirst({
      where: { id, tenantId: requireContext().tenantId },
    });
    return row === null ? null : toRebuild(row);
  }

  async start(id: string, startedAt: Date): Promise<void> {
    await requireTransaction().searchRebuild.create({
      data: {
        id,
        tenantId: requireContext().tenantId,
        state: 'RUNNING',
        startedAt,
        ...this.stamps.creation(),
      },
    });
  }

  async advance(id: string, cursorDocumentId: string, documentsIndexed: number): Promise<void> {
    await requireTransaction().searchRebuild.update({
      where: { id },
      data: {
        cursorDocumentId,
        documentsIndexed: { increment: documentsIndexed },
        ...this.stamps.update(),
      },
    });
  }

  async complete(id: string, completedAt: Date): Promise<void> {
    await requireTransaction().searchRebuild.update({
      where: { id },
      data: { state: 'COMPLETED', completedAt, ...this.stamps.update() },
    });
  }

  async fail(id: string, completedAt: Date, error: string): Promise<void> {
    await requireTransaction().searchRebuild.update({
      where: { id },
      data: { state: 'FAILED', completedAt, error: error.slice(0, 500), ...this.stamps.update() },
    });
  }
}

type SavedSearchRow = {
  id: string;
  ownerUserId: string;
  name: string;
  query: string;
  filters: unknown;
  updatedAt: Date;
  version: number;
};

function toSavedSearch(row: SavedSearchRow): SavedSearchRecord {
  return {
    id: row.id,
    ownerId: asId<UserId>(row.ownerUserId),
    name: row.name,
    query: row.query,
    filters: filtersOf(row.filters),
    updatedAt: row.updatedAt,
    version: row.version,
  };
}

type RebuildRow = {
  id: string;
  state: string;
  cursorDocumentId: string | null;
  documentsIndexed: number;
  startedAt: Date;
  completedAt: Date | null;
  error: string | null;
};

function toRebuild(row: RebuildRow): SearchRebuildRecord {
  return {
    id: row.id,
    state: row.state as SearchRebuildStateKey,
    cursorDocumentId: row.cursorDocumentId,
    documentsIndexed: row.documentsIndexed,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    error: row.error,
  };
}

/** The stored `jsonb`, narrowed back to the wire shape without trusting it blindly. */
function filtersOf(stored: unknown): Readonly<Record<string, readonly string[]>> {
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) {
    return {};
  }
  const filters: Record<string, readonly string[]> = {};
  for (const [key, value] of Object.entries(stored)) {
    if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      filters[key] = value;
    }
  }
  return filters;
}

function digestOf(query: string, filters: Readonly<Record<string, readonly string[]>>): string {
  const hash = createHash('sha256');
  hash.update(query.trim().toLowerCase());
  hash.update('\n');
  const keys = Object.keys(filters).sort();
  for (const key of keys) {
    hash.update(`${key}=${[...(filters[key] ?? [])].sort().join(',')};`);
  }
  return hash.digest('hex');
}
