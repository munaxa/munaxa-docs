/**
 * The roles seeded into every tenant. A tenant may add its own roles and may edit these,
 * except where `isSystem` says otherwise; the *keys* are fixed because the product refers
 * to them (MFA policy, seeds, reports).
 *
 * The role → permission matrix itself is tenant data, seeded in Phase 2 from
 * `docs/architecture/08-permission-model.md` §6. It is deliberately not hardcoded here:
 * a tenant that needs an approver who may also publish must not need a release.
 */
export const SystemRole = {
  TENANT_ADMIN: 'TENANT_ADMIN',
  DOCUMENT_CONTROLLER: 'DOCUMENT_CONTROLLER',
  LIBRARY_MANAGER: 'LIBRARY_MANAGER',
  AUTHOR: 'AUTHOR',
  APPROVER: 'APPROVER',
  READER: 'READER',
  AUDITOR: 'AUDITOR',
  GUEST: 'GUEST',
} as const;

export type SystemRoleKey = (typeof SystemRole)[keyof typeof SystemRole];

export const ALL_SYSTEM_ROLES: readonly SystemRoleKey[] = Object.freeze(Object.values(SystemRole));

/** Roles for which multi-factor authentication is mandatory (`17-security-architecture.md` §2). */
export const MFA_REQUIRED_ROLES: readonly SystemRoleKey[] = Object.freeze([
  SystemRole.TENANT_ADMIN,
  SystemRole.DOCUMENT_CONTROLLER,
  SystemRole.AUDITOR,
]);

/** An auditor reads and exports; it may never mutate anything, at any scope. */
export const READ_ONLY_ROLES: readonly SystemRoleKey[] = Object.freeze([SystemRole.AUDITOR]);
