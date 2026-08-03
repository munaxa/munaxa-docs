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

/**
 * Whether an organisational code is usable.
 *
 * Codes name companies, entities, branches and departments, and they appear in document
 * numbers — which are printed, quoted in correspondence and typed back in by hand. The rule is
 * therefore "what survives a photocopier and a phone call": letters, digits and hyphen, not
 * starting with the hyphen, short enough to read aloud.
 *
 * Here rather than in a module's domain layer because more than one module needs the same
 * answer: Organisation validates a code on the way in, and Numbering renders it on the way out.
 */
const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,15}$/;

export function isUsableCode(code: string): boolean {
  return CODE_PATTERN.test(code.trim());
}

/** Codes are compared case-insensitively; "QA" and "qa" are the same department. */
export function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

/** How long a code may be. The tail of `CODE_PATTERN`, named so callers can truncate to it. */
const CODE_MAX_LENGTH = 16;

/**
 * A usable code derived from free text, or the fallback when nothing usable survives.
 *
 * For the places where a code is *defaulted* rather than entered — the scope-tree root created
 * during provisioning takes one from the organisation's short name. Those two things have
 * different rules on purpose: a slug is a URL identifier and may be long and descriptive, while
 * a code is printed on documents and read aloud. Refusing to provision an organisation because
 * its name makes a poor document code would be the tail wagging the dog; it is a default, and
 * an administrator renames it.
 */
export function deriveCode(candidate: string, fallback: string): string {
  const stripped = normalizeCode(candidate)
    .replaceAll(/[^A-Z0-9-]/g, '')
    .replace(/^-+/, '')
    .slice(0, CODE_MAX_LENGTH)
    // Truncation can leave a trailing hyphen, which reads as an unfinished code.
    .replace(/-+$/, '');

  return isUsableCode(stripped) ? stripped : fallback;
}
