/**
 * Which of this module's four tables a node lives in.
 *
 * Deliberately **not** `ScopeType`, and the difference is the module's central point rather than a
 * typing convenience. `ScopeType` names the levels permission flows through — TENANT → COMPANY →
 * ENTITY → DEPARTMENT — and a branch is not one of them: it is a location, its code appears in
 * document numbers, a department may sit at one, but no ACL is ever granted on it.
 *
 * Administration still has to create, edit, delete and restore branches. So the write side needs a
 * discriminator over *four tables*, and the read side needs one over *four scope levels*, and those
 * are two different sets that happen to overlap in three places. Reusing `ScopeType` here would
 * mean adding `BRANCH` to it, which would give every ACL a level nobody grants on — exactly the
 * mistake the read side was designed to avoid.
 */
export const OrganizationNodeKind = {
  COMPANY: 'COMPANY',
  ENTITY: 'ENTITY',
  BRANCH: 'BRANCH',
  DEPARTMENT: 'DEPARTMENT',
} as const;

export type OrganizationNodeKindKey =
  (typeof OrganizationNodeKind)[keyof typeof OrganizationNodeKind];
