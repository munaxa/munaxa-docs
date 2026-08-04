import type { DeletedFilter, SortDirection } from '@edms/contracts';
import type { AnyId, ScopeTypeKey } from '@edms/domain';
import type { Page, PageRequest } from '@edms/utils';

import type { OrganizationNodeKindKey } from '../domain/node-kind';

/**
 * Organisation's contracts: the read side other modules call, and the write side administration
 * screens drive.
 *
 * The two are separate interfaces on purpose, and the separation is not decorative. A module that
 * could reach the write side could reorganise the tree while resolving an ACL against it, so
 * `OrganizationService` — the only thing this module exports — carries three read methods and
 * nothing else. The write side has exactly one consumer: this module's own controllers.
 *
 * Phase 0.5 sketched four repositories here returning `unknown`. They are replaced rather than
 * filled in: callers ask questions about *nodes* ("what is under this", "is this code taken"), and
 * four repositories would push the job of knowing which one to ask into every caller — the same
 * reasoning that gave the read side one `ScopeRepository`.
 */

export const ORGANIZATION_SERVICE = Symbol('OrganizationService');
export const SCOPE_ADMIN_SERVICE = Symbol('ScopeAdminService');
export const SCOPE_ADMIN_REPOSITORY = Symbol('ScopeAdminRepository');

/** The stamps every administered row carries. Nullable actors: provisioning writes the first rows. */
interface AdministeredRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly createdAt: Date;
  readonly createdBy: string | null;
  readonly updatedAt: Date;
  readonly updatedBy: string | null;
  readonly deletedAt: Date | null;
  readonly deletedBy: string | null;
  readonly version: number;
}

export interface CompanyRow extends AdministeredRow {
  /** Live entities directly under it — what a list shows, and what blocks a delete. */
  readonly entityCount: number;
}

export interface EntityRow extends AdministeredRow {
  readonly companyId: string;
  readonly companyName: string;
  readonly legalName: string | null;
  readonly departmentCount: number;
  readonly branchCount: number;
}

export interface BranchRow extends AdministeredRow {
  readonly entityId: string;
  readonly entityName: string;
  readonly address: string | null;
  readonly departmentCount: number;
}

export interface DepartmentRow extends AdministeredRow {
  readonly entityId: string;
  readonly entityName: string;
  readonly branchId: string | null;
  readonly branchName: string | null;
  readonly parentId: string | null;
  readonly path: string;
  readonly depth: number;
  readonly memberCount: number;
  readonly childCount: number;
}

/**
 * A list request, once the wire schema has validated it.
 *
 * `sortBy` is a plain string here rather than the contract's literal union. The union belongs to
 * the endpoint, which has already allow-listed it; repeating it through three layers would mean
 * four places to edit when a column becomes sortable. The repository maps it against its own
 * allow-list, so an unexpected value produces the default order rather than reaching SQL.
 */
export interface ListRequest extends PageRequest {
  readonly search?: string | undefined;
  readonly sortBy?: string | undefined;
  readonly sortDirection: SortDirection;
  readonly deleted: DeletedFilter;
}

export interface EntityListRequest extends ListRequest {
  readonly companyId?: string | undefined;
}

export interface BranchListRequest extends ListRequest {
  readonly entityId?: string | undefined;
}

export interface DepartmentListRequest extends ListRequest {
  readonly entityId?: string | undefined;
  readonly branchId?: string | undefined;
  /** `'null'` selects an entity's roots, since a real absence cannot be spelled in a query string. */
  readonly parentId?: string | undefined;
  readonly underId?: string | undefined;
}

/** A node of a subtree, as a move or a delete needs to see it. */
export interface SubtreeNode {
  readonly id: string;
  readonly path: string;
}

export interface ScopeAdminRepository {
  // --- Companies ---
  listCompanies(request: ListRequest): Promise<Page<CompanyRow>>;
  findCompany(id: string, includeDeleted: boolean): Promise<CompanyRow | null>;
  /** Live rows only: a code freed by a soft delete is available again. */
  companyCodeTaken(code: string, exceptId: string | null): Promise<boolean>;
  insertCompany(input: {
    readonly id: string;
    readonly code: string;
    readonly name: string;
  }): Promise<void>;
  updateCompany(
    id: string,
    version: number,
    patch: { readonly code?: string; readonly name?: string },
  ): Promise<void>;

  // --- Entities ---
  listEntities(request: EntityListRequest): Promise<Page<EntityRow>>;
  findEntity(id: string, includeDeleted: boolean): Promise<EntityRow | null>;
  /** Scoped to the company, not the tenant: two companies may each have an "OPS". */
  entityCodeTaken(companyId: string, code: string, exceptId: string | null): Promise<boolean>;
  insertEntity(input: {
    readonly id: string;
    readonly companyId: string;
    readonly code: string;
    readonly name: string;
    readonly legalName: string | null;
  }): Promise<void>;
  updateEntity(
    id: string,
    version: number,
    patch: {
      readonly code?: string;
      readonly name?: string;
      readonly legalName?: string | null;
    },
  ): Promise<void>;

  // --- Branches ---
  listBranches(request: BranchListRequest): Promise<Page<BranchRow>>;
  findBranch(id: string, includeDeleted: boolean): Promise<BranchRow | null>;
  branchCodeTaken(entityId: string, code: string, exceptId: string | null): Promise<boolean>;
  insertBranch(input: {
    readonly id: string;
    readonly entityId: string;
    readonly code: string;
    readonly name: string;
    readonly address: string | null;
  }): Promise<void>;
  updateBranch(
    id: string,
    version: number,
    patch: {
      readonly code?: string;
      readonly name?: string;
      readonly address?: string | null;
    },
  ): Promise<void>;

  // --- Departments ---
  listDepartments(request: DepartmentListRequest): Promise<Page<DepartmentRow>>;
  findDepartment(id: string, includeDeleted: boolean): Promise<DepartmentRow | null>;
  departmentCodeTaken(entityId: string, code: string, exceptId: string | null): Promise<boolean>;
  insertDepartment(input: {
    readonly id: string;
    readonly entityId: string;
    readonly branchId: string | null;
    readonly parentId: string | null;
    readonly code: string;
    readonly name: string;
    readonly path: string;
  }): Promise<void>;
  updateDepartment(
    id: string,
    version: number,
    patch: {
      readonly code?: string;
      readonly name?: string;
      readonly branchId?: string | null;
    },
  ): Promise<void>;
  /** Everything at or below a department, by path prefix. Live rows only. */
  departmentSubtree(path: string): Promise<readonly SubtreeNode[]>;
  /**
   * Re-parents a department and rewrites its whole subtree's paths, atomically.
   *
   * The subtree is rewritten in the same transaction rather than node by node afterwards: a move
   * that updated half a subtree would leave a tree in which some nodes are unreachable and others
   * reachable twice, and every ACL resolved in between would be resolved against that.
   */
  moveDepartment(input: {
    readonly id: string;
    readonly version: number;
    readonly parentId: string | null;
    readonly paths: readonly SubtreeNode[];
  }): Promise<void>;

  // --- Shared ---
  /**
   * Soft-deletes or restores one node.
   *
   * `type` selects the table, so no service branches on it four times. Nothing cascades: a node
   * with live children is refused by the service, with a message naming what is in the way. That
   * is a deliberate difference from folders, where a cascade *is* the expected behaviour — moving
   * a department is a reorganisation somebody should have to be explicit about, and silently
   * deleting the twelve departments under it is not a confirmation dialogue anybody reads.
   */
  setDeleted(
    kind: OrganizationNodeKindKey,
    id: string,
    version: number,
    deleted: boolean,
  ): Promise<void>;
  /** What stands in the way of deleting a node, by kind, so the refusal can name it. */
  dependentsOf(
    kind: OrganizationNodeKindKey,
    id: string,
  ): Promise<Readonly<Record<string, number>>>;
}

/**
 * The read side, unchanged from Phase 1: what the permission model and numbering ask.
 *
 * Named as an interface so consumers depend on the shape rather than on
 * `DefaultOrganizationService`, and so the export list of this module states three methods rather
 * than a class with more.
 */
export interface OrganizationService {
  scopeChainFor(nodeId: AnyId, nodeType: ScopeTypeKey): Promise<readonly ScopeNodeSummary[]>;
  exists(nodeId: AnyId, nodeType: ScopeTypeKey): Promise<boolean>;
  departmentsReachedBy(departmentIds: readonly AnyId[]): Promise<readonly ScopeNodeSummary[]>;
}

export interface ScopeNodeSummary {
  readonly id: AnyId;
  readonly type: ScopeTypeKey;
  readonly code: string;
  readonly name: string;
  readonly parentId: AnyId | null;
  readonly path: string;
}
