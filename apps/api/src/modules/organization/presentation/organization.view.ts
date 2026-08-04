import type { Branch, Collection, Company, Department, Entity } from '@edms/contracts';
import { depthOf } from '@edms/domain';
import type { Page } from '@edms/utils';

import type { BranchRow, CompanyRow, DepartmentRow, EntityRow } from '../application/ports';

/**
 * Rows to wire shapes.
 *
 * A mapper rather than returning repository rows directly, and the reason is not tidiness: a
 * repository row grows a column the day somebody adds one to the schema, and a controller that
 * returns it grows a field in its public contract on the same commit — silently, with no review of
 * whether that field should be visible. Naming every field here means adding one is a decision.
 *
 * Dates leave as `Date` and are serialised to ISO-8601 by `SerializationInterceptor`, which is the
 * one place that conversion happens.
 */

interface Stamps {
  readonly id: string;
  readonly version: number;
  readonly createdAt: Date;
  readonly createdBy: string | null;
  readonly updatedAt: Date;
  readonly updatedBy: string | null;
  readonly deletedAt: Date | null;
  readonly deletedBy: string | null;
}

/**
 * The audit stamps, in the shape the contract declares.
 *
 * The timestamps are converted here rather than left as `Date` for the serialisation interceptor to
 * turn into strings. The interceptor would produce the same characters, but the contract says these
 * fields are ISO-8601 strings, and a mapper that returned `Date` while claiming `string` would be a
 * type assertion standing in for a conversion — which typechecks until somebody consumes the
 * mapper's output anywhere other than an HTTP response.
 */
function stamps(
  row: Stamps,
): Pick<
  Company,
  | 'id'
  | 'version'
  | 'createdAt'
  | 'createdBy'
  | 'updatedAt'
  | 'updatedBy'
  | 'deletedAt'
  | 'deletedBy'
> {
  return {
    id: row.id,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
    deletedAt: row.deletedAt === null ? null : row.deletedAt.toISOString(),
    deletedBy: row.deletedBy,
  };
}

export function toCompany(row: CompanyRow): Company {
  return { ...stamps(row), code: row.code, name: row.name, entityCount: row.entityCount };
}

export function toEntity(row: EntityRow): Entity {
  return {
    ...stamps(row),
    companyId: row.companyId,
    companyName: row.companyName,
    code: row.code,
    name: row.name,
    legalName: row.legalName,
    departmentCount: row.departmentCount,
    branchCount: row.branchCount,
  };
}

export function toBranch(row: BranchRow): Branch {
  return {
    ...stamps(row),
    entityId: row.entityId,
    entityName: row.entityName,
    code: row.code,
    name: row.name,
    address: row.address,
    departmentCount: row.departmentCount,
  };
}

export function toDepartment(row: DepartmentRow): Department {
  return {
    ...stamps(row),
    entityId: row.entityId,
    entityName: row.entityName,
    branchId: row.branchId,
    branchName: row.branchName,
    parentId: row.parentId,
    code: row.code,
    name: row.name,
    path: row.path,
    depth: depthOf(row.path),
    memberCount: row.memberCount,
    childCount: row.childCount,
  };
}

/**
 * A page, in the collection envelope every list endpoint returns.
 *
 * Collections are wrapped so paging metadata has somewhere to live; single resources are returned
 * bare (`15-api-architecture.md` §3).
 */
export function toCollection<TRow, TItem>(
  page: Page<TRow>,
  map: (row: TRow) => TItem,
): Collection<TItem> {
  return { data: page.data.map(map), meta: page.meta };
}
