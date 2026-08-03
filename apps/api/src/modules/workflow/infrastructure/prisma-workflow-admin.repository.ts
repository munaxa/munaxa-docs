import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { WorkflowVersionState, type WorkflowVersionStateKey } from '@edms/domain';
import { type Page, toPage } from '@edms/utils';

import { VersionConflictError } from '../../../core/errors/application-errors';
import {
  RecordStamps,
  deletedCondition,
  orderByFor,
  pageArgs,
  searchConditions,
} from '../../../core/persistence';
import { requireTransaction } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';
import type {
  WorkflowAdminRepository,
  WorkflowDefinitionRow,
  WorkflowListRequest,
  WorkflowVersionRow,
} from '../application/administration.ports';

/**
 * Workflow definitions and their versions.
 *
 * The version number is allocated as `max + 1` inside the caller's transaction. Not from a PostgreSQL
 * sequence, for the same reason the audit chain is not: a sequence gaps on rollback, and a gap in a
 * version history reads as a version somebody removed.
 *
 * `instanceCount` is zero everywhere for now — there are no instances until the engine exists — and it
 * is on the row rather than absent so the immutability rule reads the same way once there are. Phase 4
 * fills it in from `workflow_instance` and nothing else about this file changes.
 */
@Injectable()
export class PrismaWorkflowAdminRepository implements WorkflowAdminRepository {
  constructor(private readonly stamps: RecordStamps) {}

  async list(request: WorkflowListRequest): Promise<Page<WorkflowDefinitionRow>> {
    const tx = requireTransaction();
    const where: Prisma.WorkflowDefinitionWhereInput = {
      tenantId: this.tenantId(),
      deletedAt: deletedCondition(request.deleted),
      ...(request.isActive !== undefined && { isActive: request.isActive }),
      ...(request.state !== undefined && {
        versions: { some: { state: request.state as Prisma.WorkflowVersionWhereInput['state'] } },
      }),
      OR: searchConditions(request.search, ['name', 'key', 'description']),
    };

    const [rows, total] = await Promise.all([
      tx.workflowDefinition.findMany({
        where,
        orderBy: orderByFor(request.sortBy as 'name' | undefined, request.sortDirection, 'name'),
        ...pageArgs(request),
        include: DEFINITION_RELATIONS,
      }),
      tx.workflowDefinition.count({ where }),
    ]);

    return toPage(rows.map(toDefinitionRow), total, request);
  }

  async find(id: string, includeDeleted: boolean): Promise<WorkflowDefinitionRow | null> {
    const row = await requireTransaction().workflowDefinition.findFirst({
      where: { id, tenantId: this.tenantId(), ...(includeDeleted ? {} : { deletedAt: null }) },
      include: DEFINITION_RELATIONS,
    });
    return row ? toDefinitionRow(row) : null;
  }

  async keyTaken(key: string, exceptId: string | null): Promise<boolean> {
    const found = await requireTransaction().workflowDefinition.findFirst({
      where: {
        tenantId: this.tenantId(),
        deletedAt: null,
        key: { equals: key, mode: 'insensitive' },
        ...(exceptId !== null && { id: { not: exceptId } }),
      },
      select: { id: true },
    });
    return found !== null;
  }

  async insertWithFirstVersion(input: {
    definitionId: string;
    versionId: string;
    key: string;
    name: string;
    description: string | null;
    definition: unknown;
  }): Promise<void> {
    const tx = requireTransaction();
    const tenantId = this.tenantId();
    const created = this.stamps.creation();

    await tx.workflowDefinition.create({
      data: {
        id: input.definitionId,
        tenantId,
        key: input.key,
        name: input.name,
        description: input.description,
        isActive: true,
        ...created,
      },
    });
    await tx.workflowVersion.create({
      data: {
        id: input.versionId,
        tenantId,
        definitionId: input.definitionId,
        version: 1,
        state: WorkflowVersionState.DRAFT,
        definition: input.definition as Prisma.InputJsonValue,
        createdAt: created.createdAt,
        createdBy: created.createdBy,
        updatedAt: created.updatedAt,
        updatedBy: created.updatedBy,
      },
    });
  }

  async update(
    id: string,
    recordVersion: number,
    patch: { name?: string; description?: string | null; isActive?: boolean },
  ): Promise<void> {
    const { count } = await requireTransaction().workflowDefinition.updateMany({
      where: { id, tenantId: this.tenantId(), version: recordVersion, deletedAt: null },
      data: { ...patch, ...this.stamps.update(), version: { increment: 1 } },
    });
    this.requireOneRow(count, recordVersion);
  }

  async setDeleted(id: string, recordVersion: number, deleted: boolean): Promise<void> {
    const { count } = await requireTransaction().workflowDefinition.updateMany({
      where: { id, tenantId: this.tenantId(), version: recordVersion },
      data: {
        ...(deleted ? this.stamps.deletion() : this.stamps.restoration()),
        version: { increment: 1 },
      },
    });
    this.requireOneRow(count, recordVersion);
  }

  // --- Versions --------------------------------------------------------------------------

  async findVersion(definitionId: string, versionId: string): Promise<WorkflowVersionRow | null> {
    const row = await requireTransaction().workflowVersion.findFirst({
      // Both identifiers, so a version of another definition cannot be reached by naming it directly.
      where: { id: versionId, definitionId, tenantId: this.tenantId() },
    });
    return row ? toVersionRow(row) : null;
  }

  async insertVersion(input: {
    definitionId: string;
    versionId: string;
    definition: unknown;
  }): Promise<number> {
    const tx = requireTransaction();
    const created = this.stamps.creation();

    const highest = await tx.workflowVersion.aggregate({
      where: { tenantId: this.tenantId(), definitionId: input.definitionId },
      _max: { version: true },
    });
    const next = (highest._max.version ?? 0) + 1;

    await tx.workflowVersion.create({
      data: {
        id: input.versionId,
        tenantId: this.tenantId(),
        definitionId: input.definitionId,
        version: next,
        state: WorkflowVersionState.DRAFT,
        definition: input.definition as Prisma.InputJsonValue,
        createdAt: created.createdAt,
        createdBy: created.createdBy,
        updatedAt: created.updatedAt,
        updatedBy: created.updatedBy,
      },
    });
    return next;
  }

  async updateDraft(versionId: string, definition: unknown): Promise<void> {
    const stamps = this.stamps.update();
    const { count } = await requireTransaction().workflowVersion.updateMany({
      // `state: DRAFT` in the `WHERE`, not only in the service's check. The immutability of a published
      // version is the engine's most important property, so the statement that would violate it matches
      // no rows rather than relying on a check that ran a moment earlier.
      where: { id: versionId, tenantId: this.tenantId(), state: WorkflowVersionState.DRAFT },
      data: {
        definition: definition as Prisma.InputJsonValue,
        updatedAt: stamps.updatedAt,
        updatedBy: stamps.updatedBy,
      },
    });
    if (count === 0) {
      throw new VersionConflictError(-1, -1);
    }
  }

  async publish(versionId: string, at: Date, by: string | null): Promise<void> {
    const { count } = await requireTransaction().workflowVersion.updateMany({
      where: { id: versionId, tenantId: this.tenantId(), state: WorkflowVersionState.DRAFT },
      data: {
        state: WorkflowVersionState.PUBLISHED,
        publishedAt: at,
        publishedBy: by,
        updatedAt: at,
        updatedBy: by,
      },
    });
    if (count === 0) {
      // Somebody published it between the service's check and this statement. Reported rather than
      // shrugged off: publishing twice would deprecate the version that had just gone live.
      throw new VersionConflictError(-1, -1);
    }
  }

  async deprecateOthers(definitionId: string, exceptVersionId: string): Promise<void> {
    const stamps = this.stamps.update();
    await requireTransaction().workflowVersion.updateMany({
      where: {
        tenantId: this.tenantId(),
        definitionId,
        id: { not: exceptVersionId },
        state: WorkflowVersionState.PUBLISHED,
      },
      data: {
        state: WorkflowVersionState.DEPRECATED,
        updatedAt: stamps.updatedAt,
        updatedBy: stamps.updatedBy,
      },
    });
  }

  async deprecate(versionId: string): Promise<void> {
    const stamps = this.stamps.update();
    const tx = requireTransaction();
    const version = await tx.workflowVersion.findFirst({
      where: { id: versionId, tenantId: this.tenantId() },
      select: { state: true },
    });

    await tx.workflowVersion.updateMany({
      where: { id: versionId, tenantId: this.tenantId() },
      data: {
        state: WorkflowVersionState.DEPRECATED,
        // A draft retired without ever being published still needs a publication stamp, because the
        // check constraint requires one for any state other than DRAFT. The instant it was retired is
        // the honest value: it is when the version stopped being a candidate.
        ...(version?.state === WorkflowVersionState.DRAFT && {
          publishedAt: stamps.updatedAt,
          publishedBy: stamps.updatedBy,
        }),
        updatedAt: stamps.updatedAt,
        updatedBy: stamps.updatedBy,
      },
    });
  }

  async countAttachedTypes(definitionId: string): Promise<number> {
    return requireTransaction().documentType.count({
      where: { tenantId: this.tenantId(), workflowDefinitionId: definitionId, deletedAt: null },
    });
  }

  // --- Internals -------------------------------------------------------------------------

  private tenantId(): string {
    return requireContext().tenantId;
  }

  private requireOneRow(count: number, expectedVersion: number): void {
    if (count === 0) {
      throw new VersionConflictError(expectedVersion, -1);
    }
  }
}

const DEFINITION_RELATIONS = {
  versions: { orderBy: { version: 'asc' } },
  _count: { select: { documentTypes: { where: { deletedAt: null } } } },
} as const;

// --- Mappers ------------------------------------------------------------------------------

interface VersionSelection {
  id: string;
  version: number;
  state: WorkflowVersionStateKey;
  definition: unknown;
  publishedAt: Date | null;
  publishedBy: string | null;
  createdAt: Date;
  createdBy: string | null;
}

function toVersionRow(row: VersionSelection): WorkflowVersionRow {
  return {
    id: row.id,
    version: row.version,
    state: row.state,
    definition: row.definition,
    publishedAt: row.publishedAt,
    publishedBy: row.publishedBy,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    // No instances until the engine exists. On the row rather than absent, so the immutability rule
    // reads the same way once Phase 4 fills it in.
    instanceCount: 0,
  };
}

function toDefinitionRow(row: {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isActive: boolean;
  createdAt: Date;
  createdBy: string | null;
  updatedAt: Date;
  updatedBy: string | null;
  deletedAt: Date | null;
  deletedBy: string | null;
  version: number;
  versions: VersionSelection[];
  _count: { documentTypes: number };
}): WorkflowDefinitionRow {
  const versions = row.versions.map(toVersionRow);
  const published = versions.filter((version) => version.state === WorkflowVersionState.PUBLISHED);

  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    isActive: row.isActive,
    // Exactly one is published at a time, so the highest is the only one — taken as a maximum anyway,
    // because reading `[0]` would quietly pick a wrong answer if that invariant ever broke.
    publishedVersion:
      published.length === 0 ? null : Math.max(...published.map((version) => version.version)),
    latestVersion:
      versions.length === 0 ? 1 : Math.max(...versions.map((version) => version.version)),
    versions,
    documentTypeCount: row._count.documentTypes,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
    deletedAt: row.deletedAt,
    deletedBy: row.deletedBy,
    // Named `recordVersion` on the row, because `version` on a workflow already means the workflow
    // version number. Two different numbers with one name in one type is a defect waiting for a hurry.
    recordVersion: row.version,
  };
}
