import { SetMetadata } from '@nestjs/common';

import type { PermissionKey, ScopeTypeKey } from '@edms/domain';

export const REQUIRED_PERMISSIONS = 'edms:required-permissions';
export const PERMISSION_SCOPE = 'edms:permission-scope';

/**
 * Declares what the caller must hold to reach this route.
 *
 * Every mutating endpoint carries one; `RoutePermissionRegistry` fails the boot if one does
 * not, so the gap is found at startup rather than by whoever finds the unguarded route
 * first (`docs/architecture/08-permission-model.md` §7).
 */
export const RequirePermission = (
  ...permissions: readonly [PermissionKey, ...PermissionKey[]]
): MethodDecorator & ClassDecorator => SetMetadata(REQUIRED_PERMISSIONS, permissions);

export interface ScopeBinding {
  /** The route parameter naming the object, e.g. `documentId`. */
  readonly param: string;
  readonly scopeType: ScopeTypeKey;
}

/**
 * Binds the permission check to a specific object, so the ACL guard resolves the scope chain
 * for *that* document or folder before the use case runs. Without it a permission is only
 * checked tenant-wide, which is right for `settings:manage` and wrong for `document:edit`.
 */
export const ScopedTo = (param: string, scopeType: ScopeTypeKey): MethodDecorator =>
  SetMetadata(PERMISSION_SCOPE, { param, scopeType } satisfies ScopeBinding);
