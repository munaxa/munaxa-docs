import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { type AnyId, asId } from '@edms/domain';
import { type Page, toPage } from '@edms/utils';

import {
  RecordStamps,
  deletedCondition,
  orderByFor,
  pageArgs,
  searchConditions,
} from '../../../core/persistence';
import { VersionConflictError } from '../../../core/errors/application-errors';
import { requireTransaction } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';
import type {
  DocumentTemplateListRequest,
  DocumentTemplateRecord,
  DocumentTemplateRepository,
  NewDocumentTemplate,
} from '../application/template.ports';

/**
 * Templates, in the database.
 *
 * An administered row, so it follows Phase 2's shape exactly: soft delete, an optimistic version in
 * the `WHERE` of every write, a three-way `deleted` filter on the list, and a name uniqueness check
 * over live rows only — so a deleted template gives its name back.
 *
 * **There is no ACL predicate here, and that is the decision rather than an omission.** A template
 * is tenant configuration: it hangs from no folder, is not in the scope tree, and has nothing for
 * `visibilityFilter` to filter on. What governs it is `template:manage`, tenant-wide, checked at
 * the route — which is exactly how every other administered list in this product works. The reach
 * question arrives when a template is *used*, and it is asked there, at the folder, by `create`.
 */
@Injectable()
export class PrismaDocumentTemplateRepository implements DocumentTemplateRepository {
  constructor(private readonly stamps: RecordStamps) {}

  async findById(id: string, includeDeleted: boolean): Promise<DocumentTemplateRecord | null> {
    const row = await requireTransaction().documentTemplate.findFirst({
      where: {
        id,
        tenantId: this.tenantId(),
        ...(includeDeleted ? {} : { deletedAt: null }),
      },
      include: TEMPLATE_INCLUDE,
    });
    return row === null ? null : toRecord(row);
  }

  async list(request: DocumentTemplateListRequest): Promise<Page<DocumentTemplateRecord>> {
    const tx = requireTransaction();
    const where = {
      tenantId: this.tenantId(),
      deletedAt: deletedCondition(request.deleted),
      ...(request.documentTypeId !== undefined && { documentTypeId: request.documentTypeId }),
      OR: searchConditions(request.search, ['name', 'description']),
    };
    const [rows, total] = await Promise.all([
      tx.documentTemplate.findMany({
        where,
        orderBy: orderByFor(request.sortBy as 'name' | undefined, request.sortDirection, 'name'),
        ...pageArgs(request),
        include: TEMPLATE_INCLUDE,
      }),
      tx.documentTemplate.count({ where }),
    ]);
    return toPage(rows.map(toRecord), total, request);
  }

  async insert(template: NewDocumentTemplate): Promise<void> {
    await requireTransaction().documentTemplate.create({
      data: {
        id: template.id,
        tenantId: this.tenantId(),
        name: template.name,
        description: template.description,
        documentTypeId: template.documentTypeId,
        categoryId: template.categoryId,
        confidentialityId: template.confidentialityId,
        defaultFolderId: template.defaultFolderId,
        fileObjectId: template.fileObjectId,
        filename: template.filename,
        defaultMetadata: template.defaultMetadata as Prisma.InputJsonObject,
        isActive: template.isActive,
        ...this.stamps.creation(),
      },
    });
  }

  async update(
    id: string,
    expectedVersion: number,
    patch: Partial<Omit<NewDocumentTemplate, 'id'>>,
  ): Promise<void> {
    await this.versioned(id, expectedVersion, { ...patch });
  }

  async setDeleted(id: string, expectedVersion: number, deleted: boolean): Promise<void> {
    await this.versioned(
      id,
      expectedVersion,
      deleted ? this.stamps.deletion() : { deletedAt: null, deletedBy: null },
      true,
    );
  }

  async nameTaken(name: string, excludingId: string | null): Promise<boolean> {
    const found = await requireTransaction().documentTemplate.findFirst({
      where: {
        tenantId: this.tenantId(),
        name,
        deletedAt: null,
        ...(excludingId !== null && { NOT: { id: excludingId } }),
      },
      select: { id: true },
    });
    return found !== null;
  }

  private async versioned(
    id: string,
    expectedVersion: number,
    data: Record<string, unknown>,
    includeDeleted = false,
  ): Promise<void> {
    const { count } = await requireTransaction().documentTemplate.updateMany({
      where: {
        id,
        tenantId: this.tenantId(),
        version: expectedVersion,
        ...(includeDeleted ? {} : { deletedAt: null }),
      },
      data: { ...data, version: expectedVersion + 1, ...this.stamps.update() },
    });
    if (count === 0) {
      throw new VersionConflictError(expectedVersion, expectedVersion + 1);
    }
  }

  private tenantId(): string {
    return requireContext().tenantId;
  }
}

const TEMPLATE_INCLUDE = {
  documentType: { select: { name: true } },
  confidentiality: { select: { name: true } },
  defaultFolder: { select: { path: true } },
} as const;

interface TemplateRow {
  id: string;
  name: string;
  description: string | null;
  documentTypeId: string;
  categoryId: string | null;
  confidentialityId: string;
  defaultFolderId: string | null;
  fileObjectId: string | null;
  filename: string | null;
  defaultMetadata: unknown;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  version: number;
  documentType: { name: string };
  confidentiality: { name: string };
  defaultFolder: { path: string } | null;
}

function toRecord(row: TemplateRow): DocumentTemplateRecord {
  return {
    id: asId<AnyId>(row.id),
    name: row.name,
    description: row.description,
    documentTypeId: row.documentTypeId,
    documentTypeName: row.documentType.name,
    categoryId: row.categoryId,
    confidentialityId: row.confidentialityId,
    confidentialityName: row.confidentiality.name,
    defaultFolderId: row.defaultFolderId,
    defaultFolderPath: row.defaultFolder?.path ?? null,
    fileObjectId: row.fileObjectId,
    filename: row.filename,
    defaultMetadata: (row.defaultMetadata ?? {}) as Readonly<Record<string, unknown>>,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
    version: row.version,
  };
}
