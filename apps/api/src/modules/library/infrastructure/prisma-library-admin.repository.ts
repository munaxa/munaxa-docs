import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { ScopeType, type ScopeTypeKey, subtreePrefix } from '@edms/domain';
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
  FolderListRequest,
  FolderRow,
  FolderSubtreeNode,
  LibraryAdminRepository,
  LibraryListRequest,
  LibraryRow,
} from '../application/administration.ports';

/**
 * Libraries and folders, in the database.
 *
 * Two things here are specific to this module.
 *
 * **The owner scope is polymorphic, so its name is resolved by a switch rather than a join.** There is
 * no foreign key to follow — `(owner_scope_type, owner_scope_id)` can point at a company, an entity or
 * a department — so the names are fetched per kind, in one query per kind present on the page, rather
 * than one per row.
 *
 * **A cascade delete is one `updateMany` over a path prefix.** Not a loop: a partially cascaded delete
 * leaves a tree in which some folders are gone and their parents are not, and every ACL resolved in
 * between would be resolved against it.
 */
@Injectable()
export class PrismaLibraryAdminRepository implements LibraryAdminRepository {
  constructor(private readonly stamps: RecordStamps) {}

  // --- Libraries -------------------------------------------------------------------------

  async listLibraries(request: LibraryListRequest): Promise<Page<LibraryRow>> {
    const tx = requireTransaction();
    const where: Prisma.LibraryWhereInput = {
      tenantId: this.tenantId(),
      deletedAt: deletedCondition(request.deleted),
      ...(request.ownerScopeType !== undefined && {
        ownerScopeType: request.ownerScopeType as Prisma.LibraryWhereInput['ownerScopeType'],
      }),
      ...(request.ownerScopeId !== undefined && { ownerScopeId: request.ownerScopeId }),
      OR: searchConditions(request.search, ['name', 'code', 'description']),
    };

    const [rows, total] = await Promise.all([
      tx.library.findMany({
        where,
        orderBy: orderByFor(request.sortBy as 'name' | undefined, request.sortDirection, 'name'),
        ...pageArgs(request),
        include: LIBRARY_COUNTS,
      }),
      tx.library.count({ where }),
    ]);

    const names = await this.ownerNames(rows);
    return toPage(
      rows.map((row) => toLibraryRow(row, names)),
      total,
      request,
    );
  }

  async findLibrary(id: string, includeDeleted: boolean): Promise<LibraryRow | null> {
    const row = await requireTransaction().library.findFirst({
      where: this.identity(id, includeDeleted),
      include: LIBRARY_COUNTS,
    });
    if (!row) {
      return null;
    }
    return toLibraryRow(row, await this.ownerNames([row]));
  }

  async libraryCodeTaken(code: string, exceptId: string | null): Promise<boolean> {
    const found = await requireTransaction().library.findFirst({
      where: {
        tenantId: this.tenantId(),
        deletedAt: null,
        code: { equals: code, mode: 'insensitive' },
        ...(exceptId !== null && { id: { not: exceptId } }),
      },
      select: { id: true },
    });
    return found !== null;
  }

  async insertLibraryWithRoot(input: {
    libraryId: string;
    rootFolderId: string;
    code: string;
    name: string;
    description: string | null;
    ownerScopeType: ScopeTypeKey;
    ownerScopeId: string | null;
    rootFolderName: string;
  }): Promise<void> {
    const tx = requireTransaction();
    const tenantId = this.tenantId();
    const created = this.stamps.creation();

    // The library first, with no root yet: the folder's foreign key points at the library, so it
    // cannot be written before one exists.
    await tx.library.create({
      data: {
        id: input.libraryId,
        tenantId,
        code: input.code,
        name: input.name,
        description: input.description,
        ownerScopeType: input.ownerScopeType as Prisma.LibraryCreateInput['ownerScopeType'],
        ownerScopeId: input.ownerScopeId,
        ...created,
      },
    });

    await tx.folder.create({
      data: {
        id: input.rootFolderId,
        tenantId,
        libraryId: input.libraryId,
        parentId: null,
        name: input.rootFolderName,
        // A root's path is its own identifier, and its depth is 1 — the same convention as every
        // other tree in the product.
        path: input.rootFolderId,
        depth: 1,
        isRoot: true,
        inheritAcl: true,
        ...created,
      },
    });

    // And now the link back. All three statements are in the caller's transaction, so a reader never
    // observes a library without a root.
    await tx.library.update({
      where: { id: input.libraryId },
      data: { rootFolderId: input.rootFolderId },
    });
  }

  async updateLibrary(
    id: string,
    version: number,
    patch: { code?: string; name?: string; description?: string | null },
  ): Promise<void> {
    const { count } = await requireTransaction().library.updateMany({
      where: { id, tenantId: this.tenantId(), version, deletedAt: null },
      data: { ...patch, ...this.stamps.update(), version: { increment: 1 } },
    });
    this.requireOneRow(count, version);
  }

  async setLibraryDeleted(id: string, version: number, deleted: boolean): Promise<void> {
    const tx = requireTransaction();
    const stamps = deleted ? this.stamps.deletion() : this.stamps.restoration();
    const { count } = await tx.library.updateMany({
      where: { id, tenantId: this.tenantId(), version },
      data: { ...stamps, version: { increment: 1 } },
    });
    this.requireOneRow(count, version);

    // The root folder follows the library. Leaving it live would put an orphan at the top of a list of
    // folders whose library is in the recycle bin.
    await tx.folder.updateMany({
      where: { tenantId: this.tenantId(), libraryId: id, isRoot: true },
      data: stamps,
    });
  }

  async countLibraryFolders(libraryId: string): Promise<number> {
    // The root does not count: it is created with the library and removed with it.
    return requireTransaction().folder.count({
      where: { tenantId: this.tenantId(), libraryId, deletedAt: null, isRoot: false },
    });
  }

  // --- Folders ---------------------------------------------------------------------------

  async listFolders(request: FolderListRequest): Promise<Page<FolderRow>> {
    const tx = requireTransaction();
    const where: Prisma.FolderWhereInput = {
      tenantId: this.tenantId(),
      deletedAt: deletedCondition(request.deleted),
      ...(request.libraryId !== undefined && { libraryId: request.libraryId }),
      ...(request.parentId !== undefined && {
        parentId: request.parentId === 'null' ? null : request.parentId,
      }),
      ...(await this.folderUnder(request.underId)),
      OR: searchConditions(request.search, ['name', 'description']),
    };

    const [rows, total] = await Promise.all([
      tx.folder.findMany({
        where,
        // Path order, so a flat list reads as a tree.
        orderBy: orderByFor(request.sortBy as 'path' | undefined, request.sortDirection, 'path'),
        ...pageArgs(request),
        include: FOLDER_RELATIONS,
      }),
      tx.folder.count({ where }),
    ]);

    return toPage(rows.map(toFolderRow), total, request);
  }

  async findFolder(id: string, includeDeleted: boolean): Promise<FolderRow | null> {
    const row = await requireTransaction().folder.findFirst({
      where: this.identity(id, includeDeleted),
      include: FOLDER_RELATIONS,
    });
    return row ? toFolderRow(row) : null;
  }

  async folderSiblingNameTaken(
    parentId: string,
    name: string,
    exceptId: string | null,
  ): Promise<boolean> {
    const found = await requireTransaction().folder.findFirst({
      where: {
        tenantId: this.tenantId(),
        deletedAt: null,
        parentId,
        name: { equals: name, mode: 'insensitive' },
        ...(exceptId !== null && { id: { not: exceptId } }),
      },
      select: { id: true },
    });
    return found !== null;
  }

  async insertFolder(input: {
    id: string;
    libraryId: string;
    parentId: string;
    name: string;
    description: string | null;
    path: string;
    depth: number;
    inheritAcl: boolean;
  }): Promise<void> {
    await requireTransaction().folder.create({
      data: { ...input, isRoot: false, tenantId: this.tenantId(), ...this.stamps.creation() },
    });
  }

  async updateFolder(
    id: string,
    version: number,
    patch: { name?: string; description?: string | null; inheritAcl?: boolean },
  ): Promise<void> {
    const { count } = await requireTransaction().folder.updateMany({
      where: { id, tenantId: this.tenantId(), version, deletedAt: null },
      data: { ...patch, ...this.stamps.update(), version: { increment: 1 } },
    });
    this.requireOneRow(count, version);
  }

  async folderSubtree(path: string): Promise<readonly FolderSubtreeNode[]> {
    return requireTransaction().folder.findMany({
      where: {
        tenantId: this.tenantId(),
        deletedAt: null,
        OR: [{ path }, { path: { startsWith: subtreePrefix(path) } }],
      },
      select: { id: true, path: true, depth: true },
    });
  }

  async moveFolder(input: {
    id: string;
    version: number;
    parentId: string;
    nodes: readonly FolderSubtreeNode[];
  }): Promise<void> {
    const tx = requireTransaction();
    const stamps = this.stamps.update();
    const own = input.nodes.find((node) => node.id === input.id);
    if (!own) {
      throw new Error('The rewritten subtree does not contain the folder being moved.');
    }

    const { count } = await tx.folder.updateMany({
      where: { id: input.id, tenantId: this.tenantId(), version: input.version, deletedAt: null },
      data: {
        parentId: input.parentId,
        path: own.path,
        depth: own.depth,
        ...stamps,
        version: { increment: 1 },
      },
    });
    this.requireOneRow(count, input.version);

    for (const node of input.nodes) {
      if (node.id === input.id) {
        continue;
      }
      // No version guard on a descendant: path and depth are derived data this module owns, not fields
      // anybody edits, so there is no concurrent edit to lose to.
      await tx.folder.updateMany({
        where: { id: node.id, tenantId: this.tenantId(), deletedAt: null },
        data: { path: node.path, depth: node.depth, ...stamps },
      });
    }
  }

  async cascadeDeleteFolder(input: {
    id: string;
    version: number;
    path: string;
    cascadeId: string;
  }): Promise<number> {
    const tx = requireTransaction();
    const tenantId = this.tenantId();
    const stamps = this.stamps.deletion();

    // The named folder first, version-guarded: if it loses the race, nothing under it is touched.
    const { count } = await tx.folder.updateMany({
      where: { id: input.id, tenantId, version: input.version, deletedAt: null },
      data: { ...stamps, deleteCascadeId: input.cascadeId, version: { increment: 1 } },
    });
    this.requireOneRow(count, input.version);

    // Then the whole subtree, in one statement rather than a loop. Every row carries the same cascade
    // identifier, which is what makes the restore exact.
    const { count: descendants } = await tx.folder.updateMany({
      where: {
        tenantId,
        deletedAt: null,
        path: { startsWith: subtreePrefix(input.path) },
      },
      data: { ...stamps, deleteCascadeId: input.cascadeId },
    });

    return count + descendants;
  }

  async restoreCascade(cascadeId: string): Promise<number> {
    const { count } = await requireTransaction().folder.updateMany({
      where: { tenantId: this.tenantId(), deleteCascadeId: cascadeId, deletedAt: { not: null } },
      // The cascade identifier is cleared with the restore: leaving it would make a later delete of
      // the same subtree indistinguishable from this one.
      data: { ...this.stamps.restoration(), deleteCascadeId: null },
    });
    return count;
  }

  async restoreFolderOnly(id: string, version: number): Promise<void> {
    const { count } = await requireTransaction().folder.updateMany({
      where: { id, tenantId: this.tenantId(), version },
      data: { ...this.stamps.restoration(), deleteCascadeId: null, version: { increment: 1 } },
    });
    this.requireOneRow(count, version);
  }

  async cascadeIdOf(id: string): Promise<string | null> {
    const row = await requireTransaction().folder.findFirst({
      where: { id, tenantId: this.tenantId() },
      select: { deleteCascadeId: true },
    });
    return row?.deleteCascadeId ?? null;
  }

  // --- Internals -------------------------------------------------------------------------

  /**
   * The names of the organisation nodes a page of libraries hangs from.
   *
   * One query per *kind* present, not one per row: a page of 25 libraries owned by 25 departments is
   * one query, and the polymorphic reference is why a join cannot do it.
   *
   * Read directly rather than through Organisation's service, and that is the one place this module
   * touches another's tables — deliberately, and only for a display label. Asking the service would
   * mean a call per row, because its contract answers about one node at a time; and the alternative,
   * adding a bulk name lookup to a service whose job is resolving permission chains, would widen an
   * interface that is narrow on purpose. A missing name renders as an empty string rather than failing
   * the list.
   */
  private async ownerNames(
    rows: readonly { ownerScopeType: string; ownerScopeId: string | null }[],
  ): Promise<ReadonlyMap<string, string>> {
    const tx = requireTransaction();
    const tenantId = this.tenantId();
    const names = new Map<string, string>();

    const idsFor = (type: string): string[] => [
      ...new Set(
        rows
          .filter((row) => row.ownerScopeType === type && row.ownerScopeId !== null)
          .map((row) => row.ownerScopeId as string),
      ),
    ];

    const companies = idsFor(ScopeType.COMPANY);
    const entities = idsFor(ScopeType.ENTITY);
    const departments = idsFor(ScopeType.DEPARTMENT);

    const [companyRows, entityRows, departmentRows] = await Promise.all([
      companies.length > 0
        ? tx.company.findMany({
            where: { tenantId, id: { in: companies } },
            select: { id: true, name: true },
          })
        : Promise.resolve([]),
      entities.length > 0
        ? tx.entity.findMany({
            where: { tenantId, id: { in: entities } },
            select: { id: true, name: true },
          })
        : Promise.resolve([]),
      departments.length > 0
        ? tx.department.findMany({
            where: { tenantId, id: { in: departments } },
            select: { id: true, name: true },
          })
        : Promise.resolve([]),
    ]);

    for (const row of [...companyRows, ...entityRows, ...departmentRows]) {
      names.set(row.id, row.name);
    }
    return names;
  }

  /** Everything at or below a folder, resolved to a prefix here rather than accepted as one. */
  private async folderUnder(
    underId: string | undefined,
  ): Promise<{ OR?: Prisma.FolderWhereInput[] } | Record<never, never>> {
    if (underId === undefined) {
      return {};
    }
    const root = await requireTransaction().folder.findFirst({
      where: { id: underId, tenantId: this.tenantId(), deletedAt: null },
      select: { path: true },
    });
    if (!root) {
      return { OR: [{ id: '00000000-0000-0000-0000-000000000000' }] };
    }
    return { OR: [{ id: underId }, { path: { startsWith: subtreePrefix(root.path) } }] };
  }

  private identity(
    id: string,
    includeDeleted: boolean,
  ): { id: string; tenantId: string; deletedAt?: null } {
    return { id, tenantId: this.tenantId(), ...(includeDeleted ? {} : { deletedAt: null }) };
  }

  private tenantId(): string {
    return requireContext().tenantId;
  }

  private requireOneRow(count: number, expectedVersion: number): void {
    if (count === 0) {
      throw new VersionConflictError(expectedVersion, -1);
    }
  }
}

const LIBRARY_COUNTS = {
  // The root is excluded, so `folderCount` is what an administrator sees as "folders in this library"
  // and also what blocks deleting it.
  _count: { select: { folders: { where: { deletedAt: null, isRoot: false } } } },
} as const;

const FOLDER_RELATIONS = {
  library: { select: { name: true } },
  _count: { select: { children: { where: { deletedAt: null } } } },
} as const;

// --- Mappers ------------------------------------------------------------------------------

interface Stamps {
  id: string;
  createdAt: Date;
  createdBy: string | null;
  updatedAt: Date;
  updatedBy: string | null;
  deletedAt: Date | null;
  deletedBy: string | null;
  version: number;
}

function stampsOf(row: Stamps): Stamps {
  return {
    id: row.id,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
    deletedAt: row.deletedAt,
    deletedBy: row.deletedBy,
    version: row.version,
  };
}

function toLibraryRow(
  row: Stamps & {
    code: string;
    name: string;
    description: string | null;
    ownerScopeType: string;
    ownerScopeId: string | null;
    rootFolderId: string | null;
    _count: { folders: number };
  },
  names: ReadonlyMap<string, string>,
): LibraryRow {
  if (row.rootFolderId === null) {
    // Unreachable through the repository, which writes both rows in one transaction. Refused rather
    // than mapped, because a library nothing can be filed in is worse to hand out than an error: every
    // caller would have to handle a null root that the contract says cannot happen.
    throw new Error(`Library ${row.id} has no root folder; its creation did not complete.`);
  }
  return {
    ...stampsOf(row),
    code: row.code,
    name: row.name,
    description: row.description,
    ownerScopeType: row.ownerScopeType as ScopeTypeKey,
    ownerScopeId: row.ownerScopeId,
    ownerScopeName:
      row.ownerScopeId === null
        ? // A tenant-wide library names no node; the screen renders its own label for this.
          ''
        : (names.get(row.ownerScopeId) ?? ''),
    rootFolderId: row.rootFolderId,
    folderCount: row._count.folders,
  };
}

function toFolderRow(
  row: Stamps & {
    libraryId: string;
    parentId: string | null;
    name: string;
    description: string | null;
    path: string;
    depth: number;
    inheritAcl: boolean;
    isRoot: boolean;
    library: { name: string };
    _count: { children: number };
  },
): FolderRow {
  return {
    ...stampsOf(row),
    libraryId: row.libraryId,
    libraryName: row.library.name,
    parentId: row.parentId,
    name: row.name,
    description: row.description,
    path: row.path,
    depth: row.depth,
    inheritAcl: row.inheritAcl,
    isRoot: row.isRoot,
    childCount: row._count.children,
  };
}
