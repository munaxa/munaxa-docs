import type { BranchId, CompanyId, DepartmentId, EntityId } from '@edms/domain';

/**
 * The scope tree's persistence contracts.
 *
 * `path` is materialised ancestry (`ltree`), maintained by the application on move. Without
 * it, resolving an ACL is a recursive CTE on every request
 * (`docs/architecture/05-database-design.md` §8).
 */
export const COMPANY_REPOSITORY = Symbol('CompanyRepository');
export const ENTITY_REPOSITORY = Symbol('EntityRepository');
export const BRANCH_REPOSITORY = Symbol('BranchRepository');
export const DEPARTMENT_REPOSITORY = Symbol('DepartmentRepository');

export interface ScopeNode {
  readonly id: CompanyId | EntityId | BranchId | DepartmentId;
  readonly code: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly path: string;
}

export interface CompanyRepository {
  findById(id: CompanyId): Promise<ScopeNode | null>;
  findByCode(code: string): Promise<ScopeNode | null>;
  save(company: ScopeNode): Promise<void>;
  listAll(): Promise<readonly ScopeNode[]>;
}

export interface EntityRepository {
  findById(id: EntityId): Promise<ScopeNode | null>;
  listByCompany(companyId: CompanyId): Promise<readonly ScopeNode[]>;
  save(entity: ScopeNode): Promise<void>;
}

export interface BranchRepository {
  findById(id: BranchId): Promise<ScopeNode | null>;
  listByEntity(entityId: EntityId): Promise<readonly ScopeNode[]>;
  save(branch: ScopeNode): Promise<void>;
}

export interface DepartmentRepository {
  findById(id: DepartmentId): Promise<ScopeNode | null>;
  /** One query, using the materialised path — not a walk. */
  listAncestors(id: DepartmentId): Promise<readonly ScopeNode[]>;
  listSubtree(id: DepartmentId): Promise<readonly ScopeNode[]>;
  save(department: ScopeNode): Promise<void>;
}

export const ORGANIZATION_SERVICE = Symbol('OrganizationService');

export interface OrganizationService {
  /** The chain from a node up to the tenant, ancestor-first: what the ACL resolver walks. */
  scopeChainFor(nodeId: string): Promise<readonly ScopeNode[]>;
  exists(nodeId: string): Promise<boolean>;
}
