/**
 * The permission catalogue — the single definition of every permission the product knows.
 *
 * A permission that is not here does not exist: the API may not gate on one, and the web
 * client may not invent one. Adding a permission is one commit that touches this file, the
 * permission matrix in `docs/architecture/08-permission-model.md`, the endpoint that gates
 * on it, the affordance that renders it, and the role seed that grants it.
 */
export const Permission = {
  DOCUMENT_VIEW: 'document:view',
  DOCUMENT_DOWNLOAD: 'document:download',
  DOCUMENT_PRINT: 'document:print',
  DOCUMENT_CREATE: 'document:create',
  DOCUMENT_EDIT: 'document:edit',
  DOCUMENT_SUBMIT: 'document:submit',
  DOCUMENT_APPROVE: 'document:approve',
  DOCUMENT_REJECT: 'document:reject',
  DOCUMENT_PUBLISH: 'document:publish',
  DOCUMENT_CHECKOUT: 'document:checkout',
  DOCUMENT_CHECKIN: 'document:checkin',
  DOCUMENT_FORCE_CHECKIN: 'document:force-checkin',
  DOCUMENT_MOVE: 'document:move',
  DOCUMENT_ARCHIVE: 'document:archive',
  DOCUMENT_DELETE: 'document:delete',
  DOCUMENT_RESTORE: 'document:restore',
  DOCUMENT_HISTORY_VIEW: 'document:history:view',
  DOCUMENT_PERMISSION_MANAGE: 'document:permission:manage',
  LIBRARY_VIEW: 'library:view',
  LIBRARY_MANAGE: 'library:manage',
  FOLDER_MANAGE: 'folder:manage',
  WORKFLOW_MANAGE: 'workflow:manage',
  DELEGATION_MANAGE: 'delegation:manage',
  NUMBERING_MANAGE: 'numbering:manage',
  RETENTION_MANAGE: 'retention:manage',
  LEGAL_HOLD_MANAGE: 'legal-hold:manage',
  AUDIT_VIEW: 'audit:view',
  AUDIT_EXPORT: 'audit:export',
  SEARCH_ALL: 'search:all',
  REPORT_VIEW: 'report:view',
  REPORT_MANAGE: 'report:manage',
  USER_MANAGE: 'user:manage',
  ROLE_MANAGE: 'role:manage',
  ORG_MANAGE: 'org:manage',
  SETTINGS_MANAGE: 'settings:manage',
} as const;

export type PermissionKey = (typeof Permission)[keyof typeof Permission];

export const ALL_PERMISSIONS: readonly PermissionKey[] = Object.freeze(Object.values(Permission));

const PERMISSION_SET: ReadonlySet<string> = new Set<string>(ALL_PERMISSIONS);

/** Narrows an untrusted string — a stored `role_permission` row, an API filter — to the catalogue. */
export function isPermissionKey(value: string): value is PermissionKey {
  return PERMISSION_SET.has(value);
}

/**
 * Administrative permissions are never blocked by a folder that breaks ACL inheritance.
 * Otherwise a user could hide a subtree from the administrators accountable for it
 * (`docs/architecture/08-permission-model.md` §3).
 */
export const INHERITANCE_PROOF_PERMISSIONS: readonly PermissionKey[] = Object.freeze(
  ALL_PERMISSIONS.filter((key) => key.endsWith(':manage') || key.startsWith('audit:')),
);

const INHERITANCE_PROOF_SET: ReadonlySet<string> = new Set<string>(INHERITANCE_PROOF_PERMISSIONS);

export function survivesBrokenInheritance(permission: PermissionKey): boolean {
  return INHERITANCE_PROOF_SET.has(permission);
}
