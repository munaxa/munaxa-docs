import { Injectable } from '@nestjs/common';

import { type AnyId, type ScopeTypeKey, ScopeType, asId } from '@edms/domain';

import { requireTransaction } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';
import { subtreePattern } from '../domain/scope-tree';
import type { ScopeNodeRecord, ScopeRepository } from '../application/scope.ports';

/**
 * The scope tree's reads.
 *
 * Soft-deleted nodes are excluded everywhere. A department that was removed must stop
 * conferring access immediately, and leaving it in a chain would keep an ACL granted on it
 * alive after the thing it was granted on is gone.
 */
@Injectable()
export class PrismaScopeRepository implements ScopeRepository {
  async findNode(id: AnyId, type: ScopeTypeKey): Promise<ScopeNodeRecord | null> {
    const tx = requireTransaction();
    const { tenantId } = requireContext();
    const where = { id, tenantId, deletedAt: null };

    switch (type) {
      case ScopeType.COMPANY: {
        const row = await tx.company.findFirst({ where });
        return row
          ? {
              id: asId<AnyId>(row.id),
              type,
              code: row.code,
              name: row.name,
              parentId: null,
              path: row.id,
            }
          : null;
      }
      case ScopeType.ENTITY: {
        const row = await tx.entity.findFirst({ where });
        return row
          ? {
              id: asId<AnyId>(row.id),
              type,
              code: row.code,
              name: row.name,
              parentId: asId<AnyId>(row.companyId),
              path: row.id,
            }
          : null;
      }
      case ScopeType.DEPARTMENT: {
        const row = await tx.department.findFirst({ where });
        return row ? toDepartment(row) : null;
      }
      default:
        return null;
    }
  }

  async findDepartmentsByIds(ids: readonly string[]): Promise<readonly ScopeNodeRecord[]> {
    if (ids.length === 0) {
      return [];
    }
    const rows = await requireTransaction().department.findMany({
      where: { tenantId: requireContext().tenantId, id: { in: [...ids] }, deletedAt: null },
    });

    // Returned in the order the path names them, not the order the database happened to
    // produce: the chain's order *is* its meaning — nearest ancestor last.
    const byId = new Map(rows.map((row) => [row.id, toDepartment(row)]));
    return ids
      .map((id) => byId.get(id))
      .filter((node): node is ScopeNodeRecord => node !== undefined);
  }

  async findBranchCodeOfDepartment(departmentId: AnyId): Promise<string | null> {
    const tx = requireTransaction();
    const { tenantId } = requireContext();
    const department = await tx.department.findFirst({
      where: { id: departmentId, tenantId, deletedAt: null },
      select: { branchId: true },
    });
    if (department === null || department.branchId === null) {
      return null;
    }
    const branch = await tx.branch.findFirst({
      where: { id: department.branchId, tenantId, deletedAt: null },
      select: { code: true },
    });
    return branch?.code ?? null;
  }

  async findSubtrees(ids: readonly AnyId[]): Promise<readonly ScopeNodeRecord[]> {
    if (ids.length === 0) {
      return [];
    }
    const tx = requireTransaction();
    const { tenantId } = requireContext();

    const roots = await tx.department.findMany({
      where: { tenantId, id: { in: [...ids] }, deletedAt: null },
      select: { id: true, path: true },
    });
    if (roots.length === 0) {
      return [];
    }

    // One query for every subtree: each root matches itself, or anything whose path begins
    // with the root's path and a separator. The prefix index serves this; walking the tree
    // would be one query per level.
    const rows = await tx.department.findMany({
      where: {
        tenantId,
        deletedAt: null,
        OR: roots.flatMap((root) => [
          { id: root.id },
          // `subtreePattern` ends in the SQL wildcard; `startsWith` wants the literal prefix,
          // so the wildcard comes off. The separator stays, which is what stops `a.bc` from
          // matching as a descendant of `a.b`.
          { path: { startsWith: subtreePattern(root.path).slice(0, -1) } },
        ]),
      },
    });
    return rows.map(toDepartment);
  }
}

interface DepartmentRow {
  id: string;
  code: string;
  name: string;
  parentId: string | null;
  entityId: string;
  path: string;
}

function toDepartment(row: DepartmentRow): ScopeNodeRecord {
  return {
    id: asId<AnyId>(row.id),
    type: ScopeType.DEPARTMENT,
    code: row.code,
    name: row.name,
    parentId: row.parentId ? asId<AnyId>(row.parentId) : null,
    path: row.path,
    entityId: asId<AnyId>(row.entityId),
  };
}
