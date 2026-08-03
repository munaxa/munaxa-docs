import type { AnyId } from './ids';

/**
 * The scope tree. Permission is granted on a node and flows downward; an ACL entry at any
 * node may override an inherited one, and a DENY at any node wins
 * (`docs/architecture/08-permission-model.md` §3).
 */
export const ScopeType = {
  TENANT: 'TENANT',
  COMPANY: 'COMPANY',
  ENTITY: 'ENTITY',
  DEPARTMENT: 'DEPARTMENT',
  LIBRARY: 'LIBRARY',
  FOLDER: 'FOLDER',
  DOCUMENT: 'DOCUMENT',
} as const;

export type ScopeTypeKey = (typeof ScopeType)[keyof typeof ScopeType];

/**
 * Ancestor-first. A resolver walks it in reverse — from the document up to the tenant —
 * and the index of a node is its depth, which is what makes "the nearest override wins"
 * expressible without a graph traversal.
 */
export const SCOPE_CHAIN: readonly ScopeTypeKey[] = Object.freeze([
  ScopeType.TENANT,
  ScopeType.COMPANY,
  ScopeType.ENTITY,
  ScopeType.DEPARTMENT,
  ScopeType.LIBRARY,
  ScopeType.FOLDER,
  ScopeType.DOCUMENT,
]);

export interface ScopeRef {
  readonly type: ScopeTypeKey;
  readonly id: AnyId;
}

/** The subjects an ACL entry may name. */
export const AclSubjectType = {
  USER: 'USER',
  ROLE: 'ROLE',
  DEPARTMENT: 'DEPARTMENT',
} as const;

export type AclSubjectTypeKey = (typeof AclSubjectType)[keyof typeof AclSubjectType];

export const AclEffect = {
  ALLOW: 'ALLOW',
  DENY: 'DENY',
} as const;

export type AclEffectKey = (typeof AclEffect)[keyof typeof AclEffect];
