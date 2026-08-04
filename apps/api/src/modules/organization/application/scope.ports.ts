import type { AnyId, ScopeTypeKey } from '@edms/domain';

/**
 * Reading the scope tree.
 *
 * One repository for four tables, because callers ask questions about *nodes* rather than
 * about companies or entities: "what is above this", "what is under that". Four repositories
 * would push the job of knowing which one to ask into every caller, and the ACL resolver is
 * the last place that knowledge belongs.
 *
 * Writing is Phase 2's — this is the read side the permission model needs.
 */
export const SCOPE_REPOSITORY = Symbol('ScopeRepository');

export interface ScopeNodeRecord {
  readonly id: AnyId;
  readonly type: ScopeTypeKey;
  readonly code: string;
  readonly name: string;
  /** The company for an entity, the parent department or null for a department. */
  readonly parentId: AnyId | null;
  /** Materialised ancestry for departments; the node's own id for everything else. */
  readonly path: string;
  /** Set on departments: the entity the chain continues into. */
  readonly entityId?: AnyId;
}

export interface ScopeRepository {
  findNode(id: AnyId, type: ScopeTypeKey): Promise<ScopeNodeRecord | null>;
  /** Ancestor departments, in one read, ordered nearest-last. */
  findDepartmentsByIds(ids: readonly string[]): Promise<readonly ScopeNodeRecord[]>;
  /** Every department at or below each of these, by path prefix. */
  findSubtrees(ids: readonly AnyId[]): Promise<readonly ScopeNodeRecord[]>;
  /**
   * The live branch a department is tied to, or null. A branch never appears in a scope chain —
   * permission does not flow through a location — but its code appears in document numbers,
   * which is the one read anything outside administration makes of it.
   */
  findBranchCodeOfDepartment(departmentId: AnyId): Promise<string | null>;
}
