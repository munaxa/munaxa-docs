import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { depthOf, subtreePrefix } from '@edms/domain';
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
import { OrganizationNodeKind, type OrganizationNodeKindKey } from '../domain/node-kind';
import type {
  BranchListRequest,
  BranchRow,
  CompanyRow,
  DepartmentListRequest,
  DepartmentRow,
  EntityListRequest,
  EntityRow,
  ListRequest,
  ScopeAdminRepository,
  SubtreeNode,
} from '../application/ports';

/**
 * The scope tree's writes.
 *
 * Two things here are worth reading carefully, because they are the correctness of the module
 * rather than its plumbing.
 *
 * **Every update is guarded by the version in its `WHERE`.** The service checks the version too,
 * and that check is not enough on its own: between reading a row and writing it, another
 * transaction can commit. `updateMany({ where: { id, version } })` makes the loser's update match
 * zero rows, and zero rows is reported as a conflict rather than shrugged off as success. Without
 * it, optimistic locking would be advisory — which is the same as absent.
 *
 * **Counts come from the database, not from loading children.** A list of twelve companies needs
 * twelve entity counts, and `include` would fetch every entity to call `.length` on the array.
 * `_count` is one aggregate per query.
 */
@Injectable()
export class PrismaScopeAdminRepository implements ScopeAdminRepository {
  constructor(private readonly stamps: RecordStamps) {}

  // --- Companies -------------------------------------------------------------------------

  async listCompanies(request: ListRequest): Promise<Page<CompanyRow>> {
    const tx = requireTransaction();
    const where: Prisma.CompanyWhereInput = {
      tenantId: this.tenantId(),
      deletedAt: deletedCondition(request.deleted),
      OR: searchConditions(request.search, ['name', 'code']),
    };

    const [rows, total] = await Promise.all([
      tx.company.findMany({
        where,
        orderBy: orderByFor(
          request.sortBy as 'name' | undefined,
          request.sortDirection,
          'createdAt',
        ),
        ...pageArgs(request),
        include: { _count: { select: { entities: { where: { deletedAt: null } } } } },
      }),
      tx.company.count({ where }),
    ]);

    return toPage(rows.map(toCompanyRow), total, request);
  }

  async findCompany(id: string, includeDeleted: boolean): Promise<CompanyRow | null> {
    const row = await requireTransaction().company.findFirst({
      where: this.identity(id, includeDeleted),
      include: { _count: { select: { entities: { where: { deletedAt: null } } } } },
    });
    return row ? toCompanyRow(row) : null;
  }

  async companyCodeTaken(code: string, exceptId: string | null): Promise<boolean> {
    const found = await requireTransaction().company.findFirst({
      where: {
        tenantId: this.tenantId(),
        deletedAt: null,
        // `mode: 'insensitive'` rather than `lower(code)`: it is the same comparison the partial
        // unique index makes, expressed in the only way Prisma can express it.
        code: { equals: code, mode: 'insensitive' },
        ...(exceptId !== null && { id: { not: exceptId } }),
      },
      select: { id: true },
    });
    return found !== null;
  }

  async insertCompany(input: { id: string; code: string; name: string }): Promise<void> {
    await requireTransaction().company.create({
      data: { ...input, tenantId: this.tenantId(), ...this.stamps.creation() },
    });
  }

  async updateCompany(
    id: string,
    version: number,
    patch: { code?: string; name?: string },
  ): Promise<void> {
    const { count } = await requireTransaction().company.updateMany({
      where: { id, tenantId: this.tenantId(), version, deletedAt: null },
      data: { ...patch, ...this.stamps.update(), version: { increment: 1 } },
    });
    this.requireOneRow(count, version);
  }

  // --- Entities --------------------------------------------------------------------------

  async listEntities(request: EntityListRequest): Promise<Page<EntityRow>> {
    const tx = requireTransaction();
    const where: Prisma.EntityWhereInput = {
      tenantId: this.tenantId(),
      deletedAt: deletedCondition(request.deleted),
      ...(request.companyId !== undefined && { companyId: request.companyId }),
      OR: searchConditions(request.search, ['name', 'code', 'legalName']),
    };

    const [rows, total] = await Promise.all([
      tx.entity.findMany({
        where,
        orderBy: orderByFor(
          request.sortBy as 'name' | undefined,
          request.sortDirection,
          'createdAt',
        ),
        ...pageArgs(request),
        include: {
          company: { select: { name: true } },
          _count: {
            select: {
              departments: { where: { deletedAt: null } },
              branches: { where: { deletedAt: null } },
            },
          },
        },
      }),
      tx.entity.count({ where }),
    ]);

    return toPage(rows.map(toEntityRow), total, request);
  }

  async findEntity(id: string, includeDeleted: boolean): Promise<EntityRow | null> {
    const row = await requireTransaction().entity.findFirst({
      where: this.identity(id, includeDeleted),
      include: {
        company: { select: { name: true } },
        _count: {
          select: {
            departments: { where: { deletedAt: null } },
            branches: { where: { deletedAt: null } },
          },
        },
      },
    });
    return row ? toEntityRow(row) : null;
  }

  async entityCodeTaken(
    companyId: string,
    code: string,
    exceptId: string | null,
  ): Promise<boolean> {
    const found = await requireTransaction().entity.findFirst({
      where: {
        tenantId: this.tenantId(),
        companyId,
        deletedAt: null,
        code: { equals: code, mode: 'insensitive' },
        ...(exceptId !== null && { id: { not: exceptId } }),
      },
      select: { id: true },
    });
    return found !== null;
  }

  async insertEntity(input: {
    id: string;
    companyId: string;
    code: string;
    name: string;
    legalName: string | null;
  }): Promise<void> {
    await requireTransaction().entity.create({
      data: { ...input, tenantId: this.tenantId(), ...this.stamps.creation() },
    });
  }

  async updateEntity(
    id: string,
    version: number,
    patch: { code?: string; name?: string; legalName?: string | null },
  ): Promise<void> {
    const { count } = await requireTransaction().entity.updateMany({
      where: { id, tenantId: this.tenantId(), version, deletedAt: null },
      data: { ...patch, ...this.stamps.update(), version: { increment: 1 } },
    });
    this.requireOneRow(count, version);
  }

  // --- Branches --------------------------------------------------------------------------

  async listBranches(request: BranchListRequest): Promise<Page<BranchRow>> {
    const tx = requireTransaction();
    const where: Prisma.BranchWhereInput = {
      tenantId: this.tenantId(),
      deletedAt: deletedCondition(request.deleted),
      ...(request.entityId !== undefined && { entityId: request.entityId }),
      OR: searchConditions(request.search, ['name', 'code', 'address']),
    };

    const [rows, total] = await Promise.all([
      tx.branch.findMany({
        where,
        orderBy: orderByFor(
          request.sortBy as 'name' | undefined,
          request.sortDirection,
          'createdAt',
        ),
        ...pageArgs(request),
        include: {
          entity: { select: { name: true } },
          _count: { select: { departments: { where: { deletedAt: null } } } },
        },
      }),
      tx.branch.count({ where }),
    ]);

    return toPage(rows.map(toBranchRow), total, request);
  }

  async findBranch(id: string, includeDeleted: boolean): Promise<BranchRow | null> {
    const row = await requireTransaction().branch.findFirst({
      where: this.identity(id, includeDeleted),
      include: {
        entity: { select: { name: true } },
        _count: { select: { departments: { where: { deletedAt: null } } } },
      },
    });
    return row ? toBranchRow(row) : null;
  }

  async branchCodeTaken(entityId: string, code: string, exceptId: string | null): Promise<boolean> {
    const found = await requireTransaction().branch.findFirst({
      where: {
        tenantId: this.tenantId(),
        entityId,
        deletedAt: null,
        code: { equals: code, mode: 'insensitive' },
        ...(exceptId !== null && { id: { not: exceptId } }),
      },
      select: { id: true },
    });
    return found !== null;
  }

  async insertBranch(input: {
    id: string;
    entityId: string;
    code: string;
    name: string;
    address: string | null;
  }): Promise<void> {
    await requireTransaction().branch.create({
      data: { ...input, tenantId: this.tenantId(), ...this.stamps.creation() },
    });
  }

  async updateBranch(
    id: string,
    version: number,
    patch: { code?: string; name?: string; address?: string | null },
  ): Promise<void> {
    const { count } = await requireTransaction().branch.updateMany({
      where: { id, tenantId: this.tenantId(), version, deletedAt: null },
      data: { ...patch, ...this.stamps.update(), version: { increment: 1 } },
    });
    this.requireOneRow(count, version);
  }

  // --- Departments -----------------------------------------------------------------------

  async listDepartments(request: DepartmentListRequest): Promise<Page<DepartmentRow>> {
    const tx = requireTransaction();
    const where: Prisma.DepartmentWhereInput = {
      tenantId: this.tenantId(),
      deletedAt: deletedCondition(request.deleted),
      ...(request.entityId !== undefined && { entityId: request.entityId }),
      ...(request.branchId !== undefined && { branchId: request.branchId }),
      // `'null'` is how a query string spells an absent parent, and it means "the roots of this
      // entity" rather than "any department".
      ...(request.parentId !== undefined && {
        parentId: request.parentId === 'null' ? null : request.parentId,
      }),
      ...(await this.underCondition(request.underId)),
      OR: searchConditions(request.search, ['name', 'code']),
    };

    const [rows, total] = await Promise.all([
      tx.department.findMany({
        where,
        orderBy: orderByFor(
          request.sortBy as 'name' | 'path' | undefined,
          request.sortDirection,
          'path',
        ),
        ...pageArgs(request),
        include: {
          entity: { select: { name: true } },
          branch: { select: { name: true } },
          _count: {
            select: {
              members: true,
              children: { where: { deletedAt: null } },
            },
          },
        },
      }),
      tx.department.count({ where }),
    ]);

    return toPage(rows.map(toDepartmentRow), total, request);
  }

  async findDepartment(id: string, includeDeleted: boolean): Promise<DepartmentRow | null> {
    const row = await requireTransaction().department.findFirst({
      where: this.identity(id, includeDeleted),
      include: {
        entity: { select: { name: true } },
        branch: { select: { name: true } },
        _count: { select: { members: true, children: { where: { deletedAt: null } } } },
      },
    });
    return row ? toDepartmentRow(row) : null;
  }

  async departmentCodeTaken(
    entityId: string,
    code: string,
    exceptId: string | null,
  ): Promise<boolean> {
    const found = await requireTransaction().department.findFirst({
      where: {
        tenantId: this.tenantId(),
        entityId,
        deletedAt: null,
        code: { equals: code, mode: 'insensitive' },
        ...(exceptId !== null && { id: { not: exceptId } }),
      },
      select: { id: true },
    });
    return found !== null;
  }

  async insertDepartment(input: {
    id: string;
    entityId: string;
    branchId: string | null;
    parentId: string | null;
    code: string;
    name: string;
    path: string;
  }): Promise<void> {
    await requireTransaction().department.create({
      data: { ...input, tenantId: this.tenantId(), ...this.stamps.creation() },
    });
  }

  async updateDepartment(
    id: string,
    version: number,
    patch: { code?: string; name?: string; branchId?: string | null },
  ): Promise<void> {
    const { count } = await requireTransaction().department.updateMany({
      where: { id, tenantId: this.tenantId(), version, deletedAt: null },
      data: { ...patch, ...this.stamps.update(), version: { increment: 1 } },
    });
    this.requireOneRow(count, version);
  }

  async departmentSubtree(path: string): Promise<readonly SubtreeNode[]> {
    const rows = await requireTransaction().department.findMany({
      where: {
        tenantId: this.tenantId(),
        deletedAt: null,
        // The node itself, or anything whose path begins with its path *and a separator*. The
        // separator is what stops `a.bc` counting as a descendant of `a.b`.
        OR: [{ path }, { path: { startsWith: subtreePrefix(path) } }],
      },
      select: { id: true, path: true },
    });
    return rows;
  }

  async moveDepartment(input: {
    id: string;
    version: number;
    parentId: string | null;
    paths: readonly SubtreeNode[];
  }): Promise<void> {
    const tx = requireTransaction();
    const stamps = this.stamps.update();

    // The moved node first, guarded by its version: if it loses the race, nothing below is written.
    const { count } = await tx.department.updateMany({
      where: { id: input.id, tenantId: this.tenantId(), version: input.version, deletedAt: null },
      data: {
        parentId: input.parentId,
        path: pathOf(input.paths, input.id),
        ...stamps,
        version: { increment: 1 },
      },
    });
    this.requireOneRow(count, input.version);

    // Then the descendants. Same transaction, so a reader either sees the whole subtree at its old
    // paths or the whole subtree at its new ones — never a tree with two roots.
    for (const node of input.paths) {
      if (node.id === input.id) {
        continue;
      }
      await tx.department.updateMany({
        where: { id: node.id, tenantId: this.tenantId(), deletedAt: null },
        // No version guard on a descendant, and deliberately: its *path* is derived data owned by
        // this module, not a field anybody edits, so there is no concurrent edit to lose to. The
        // guard belongs on the node the administrator actually acted on.
        data: { path: node.path, ...stamps },
      });
    }
  }

  // --- Shared ----------------------------------------------------------------------------

  async setDeleted(
    kind: OrganizationNodeKindKey,
    id: string,
    version: number,
    deleted: boolean,
  ): Promise<void> {
    const tx = requireTransaction();
    const where = { id, tenantId: this.tenantId(), version };
    const data = {
      ...(deleted ? this.stamps.deletion() : this.stamps.restoration()),
      version: { increment: 1 },
    };

    const { count } = await (() => {
      switch (kind) {
        case OrganizationNodeKind.COMPANY:
          return tx.company.updateMany({ where, data });
        case OrganizationNodeKind.ENTITY:
          return tx.entity.updateMany({ where, data });
        case OrganizationNodeKind.BRANCH:
          return tx.branch.updateMany({ where, data });
        case OrganizationNodeKind.DEPARTMENT:
          return tx.department.updateMany({ where, data });
        default:
          return Promise.resolve({ count: 0 });
      }
    })();
    this.requireOneRow(count, version);
  }

  /**
   * What still hangs from a node, by kind.
   *
   * Live rows only. A company whose only remaining entity is already in the recycle bin can be
   * deleted, because restoring that entity afterwards is a decision somebody will make explicitly
   * — and refusing on the strength of a deleted row would make the recycle bin a place things go
   * to block other work.
   */
  async dependentsOf(
    kind: OrganizationNodeKindKey,
    id: string,
  ): Promise<Readonly<Record<string, number>>> {
    const tx = requireTransaction();
    const tenantId = this.tenantId();
    const live = { tenantId, deletedAt: null };

    switch (kind) {
      case OrganizationNodeKind.COMPANY:
        return { entities: await tx.entity.count({ where: { ...live, companyId: id } }) };

      case OrganizationNodeKind.ENTITY: {
        const [departments, branches, libraries] = await Promise.all([
          tx.department.count({ where: { ...live, entityId: id } }),
          tx.branch.count({ where: { ...live, entityId: id } }),
          tx.library.count({ where: { ...live, ownerScopeType: 'ENTITY', ownerScopeId: id } }),
        ]);
        return { departments, branches, libraries };
      }

      case OrganizationNodeKind.BRANCH:
        // A branch holds departments by location. Deleting it would leave them pointing at a row
        // whose code still appears in issued document numbers.
        return { departments: await tx.department.count({ where: { ...live, branchId: id } }) };

      case OrganizationNodeKind.DEPARTMENT: {
        const [children, members, libraries] = await Promise.all([
          tx.department.count({ where: { ...live, parentId: id } }),
          // Membership, not a soft-deletable row: somebody still in the department is a reason to
          // stop, because deleting it would silently remove their routing and numbering defaults.
          tx.userDepartment.count({ where: { tenantId, departmentId: id } }),
          tx.library.count({ where: { ...live, ownerScopeType: 'DEPARTMENT', ownerScopeId: id } }),
        ]);
        return { subDepartments: children, members, libraries };
      }

      default:
        return {};
    }
  }

  // --- Internals -------------------------------------------------------------------------

  /**
   * Everything at or below a node, for the tree view's single call.
   *
   * Resolved to a path prefix here rather than accepted as one from the caller: a client that could
   * send a prefix could send `''` and read the whole tenant's tree in one page.
   */
  private async underCondition(
    underId: string | undefined,
  ): Promise<{ OR?: Prisma.DepartmentWhereInput[] } | Record<never, never>> {
    if (underId === undefined) {
      return {};
    }
    const root = await requireTransaction().department.findFirst({
      where: { id: underId, tenantId: this.tenantId(), deletedAt: null },
      select: { path: true },
    });
    if (!root) {
      // An unknown node reaches nothing, rather than reaching everything — which is what an empty
      // prefix would do.
      return { OR: [{ id: '00000000-0000-0000-0000-000000000000' }] };
    }
    return { OR: [{ id: underId }, { path: { startsWith: subtreePrefix(root.path) } }] };
  }

  private identity(
    id: string,
    includeDeleted: boolean,
  ): { id: string; tenantId: string; deletedAt?: null } {
    return {
      id,
      tenantId: this.tenantId(),
      // Row-level security scopes this too; the explicit filter is what makes the intent readable
      // and what holds if the policy is ever relaxed for a maintenance role.
      ...(includeDeleted ? {} : { deletedAt: null }),
    };
  }

  private tenantId(): string {
    return requireContext().tenantId;
  }

  /**
   * Zero rows means the version moved between the service's check and this write.
   *
   * Reported rather than ignored. `updateMany` returning 0 is the *only* signal that optimistic
   * locking did its job, and swallowing it would make every guard above decorative.
   */
  private requireOneRow(count: number, expectedVersion: number): void {
    if (count === 0) {
      throw new VersionConflictError(expectedVersion, -1);
    }
  }
}

// --- Mappers ------------------------------------------------------------------------------

interface Stamped {
  id: string;
  code: string;
  name: string;
  createdAt: Date;
  createdBy: string | null;
  updatedAt: Date;
  updatedBy: string | null;
  deletedAt: Date | null;
  deletedBy: string | null;
  version: number;
}

function stampsOf(row: Stamped): Stamped {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
    deletedAt: row.deletedAt,
    deletedBy: row.deletedBy,
    version: row.version,
  };
}

function toCompanyRow(row: Stamped & { _count: { entities: number } }): CompanyRow {
  return { ...stampsOf(row), entityCount: row._count.entities };
}

function toEntityRow(
  row: Stamped & {
    companyId: string;
    legalName: string | null;
    company: { name: string };
    _count: { departments: number; branches: number };
  },
): EntityRow {
  return {
    ...stampsOf(row),
    companyId: row.companyId,
    companyName: row.company.name,
    legalName: row.legalName,
    departmentCount: row._count.departments,
    branchCount: row._count.branches,
  };
}

function toBranchRow(
  row: Stamped & {
    entityId: string;
    address: string | null;
    entity: { name: string };
    _count: { departments: number };
  },
): BranchRow {
  return {
    ...stampsOf(row),
    entityId: row.entityId,
    entityName: row.entity.name,
    address: row.address,
    departmentCount: row._count.departments,
  };
}

function toDepartmentRow(
  row: Stamped & {
    entityId: string;
    branchId: string | null;
    parentId: string | null;
    path: string;
    entity: { name: string };
    branch: { name: string } | null;
    _count: { members: number; children: number };
  },
): DepartmentRow {
  return {
    ...stampsOf(row),
    entityId: row.entityId,
    entityName: row.entity.name,
    branchId: row.branchId,
    branchName: row.branch?.name ?? null,
    parentId: row.parentId,
    path: row.path,
    // Derived from the path rather than stored: departments have no `depth` column, and the two
    // could then disagree after a move. Folders do store one, because their ceiling is 32 and the
    // check runs on a subtree rather than a single node.
    depth: depthOf(row.path),
    memberCount: row._count.members,
    childCount: row._count.children,
  };
}

/** The new path of one node in a rewritten subtree. */
function pathOf(paths: readonly SubtreeNode[], id: string): string {
  const found = paths.find((node) => node.id === id);
  if (!found) {
    // The subtree was computed from this node's own path, so it always contains it. Reaching here
    // would mean the rewrite lost its root, and writing a partial move would corrupt the tree.
    throw new Error('The rewritten subtree does not contain the node being moved.');
  }
  return found.path;
}
