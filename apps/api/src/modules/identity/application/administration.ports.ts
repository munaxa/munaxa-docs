import type { DeletedFilter, SortDirection } from '@edms/contracts';
import type { PermissionKey, UserStatusKey } from '@edms/domain';
import type { Page, PageRequest } from '@edms/utils';

/**
 * Administering people and access.
 *
 * Kept apart from `ports.ts` for the same reason `CredentialRepository` is: narrowing an interface is
 * what keeps a capability from leaking. Nothing here can see a password hash — setting one is a
 * single method that takes an already-derived hash — and nothing in `ports.ts` can create a user.
 */

export const USER_ADMIN_SERVICE = Symbol('UserAdminService');
export const ROLE_ADMIN_SERVICE = Symbol('RoleAdminService');
export const IDENTITY_ADMIN_REPOSITORY = Symbol('IdentityAdminRepository');

export interface UserAdminRow {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly status: UserStatusKey;
  readonly mfaEnrolled: boolean;
  readonly lastLoginAt: Date | null;
  /** Whether a password is set. Never the hash itself — not even to this layer. */
  readonly hasPassword: boolean;
  readonly roles: readonly { readonly id: string; readonly key: string; readonly name: string }[];
  readonly departments: readonly {
    readonly departmentId: string;
    readonly name: string;
    readonly code: string;
    readonly isPrimary: boolean;
    readonly isManager: boolean;
  }[];
  readonly createdAt: Date;
  readonly createdBy: string | null;
  readonly updatedAt: Date;
  readonly updatedBy: string | null;
  readonly deletedAt: Date | null;
  readonly deletedBy: string | null;
  readonly version: number;
}

export interface RoleAdminRow {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  readonly isSystem: boolean;
  readonly permissions: readonly PermissionKey[];
  readonly memberCount: number;
  readonly createdAt: Date;
  readonly createdBy: string | null;
  readonly updatedAt: Date;
  readonly updatedBy: string | null;
  readonly deletedAt: Date | null;
  readonly deletedBy: string | null;
  readonly version: number;
}

export interface IdentityListRequest extends PageRequest {
  readonly search?: string | undefined;
  readonly sortBy?: string | undefined;
  readonly sortDirection: SortDirection;
  readonly deleted: DeletedFilter;
}

export interface UserListRequest extends IdentityListRequest {
  readonly status?: UserStatusKey | undefined;
  readonly roleId?: string | undefined;
  readonly departmentId?: string | undefined;
}

export interface RoleListRequest extends IdentityListRequest {
  readonly permission?: PermissionKey | undefined;
}

export interface DepartmentMembership {
  readonly departmentId: string;
  readonly isPrimary: boolean;
  /** Manages it, rather than merely belonging to it. What `MANAGER_OF` resolves against. */
  readonly isManager: boolean;
}

export interface IdentityAdminRepository {
  // --- Users ---
  listUsers(request: UserListRequest): Promise<Page<UserAdminRow>>;
  findUser(id: string, includeDeleted: boolean): Promise<UserAdminRow | null>;
  /** Case-insensitive, live rows only: a deleted user frees their address for re-invitation. */
  emailTaken(emailNormalized: string, exceptId: string | null): Promise<boolean>;
  insertUser(input: {
    readonly id: string;
    readonly email: string;
    readonly emailNormalized: string;
    readonly displayName: string;
  }): Promise<void>;
  updateUser(
    id: string,
    version: number,
    patch: {
      readonly email?: string;
      readonly emailNormalized?: string;
      readonly displayName?: string;
      readonly status?: UserStatusKey;
    },
  ): Promise<void>;
  setUserDeleted(id: string, version: number, deleted: boolean): Promise<void>;
  /** Replaces the whole set. A diff computed here would be a second place uniqueness is decided. */
  replaceRoles(userId: string, roleIds: readonly string[]): Promise<void>;
  replaceDepartments(userId: string, memberships: readonly DepartmentMembership[]): Promise<void>;
  /** Which of these department identifiers exist and are live, so a bad one is named, not ignored. */
  liveDepartmentIds(ids: readonly string[]): Promise<readonly string[]>;
  /**
   * Bumps `permission_version`, so an access token minted before this change is refused.
   *
   * The whole point of the column: a revoked role takes effect within one request rather than at the
   * end of the token's lifetime (`08-permission-model.md` §7).
   */
  bumpPermissionVersion(userIds: readonly string[]): Promise<void>;
  /** Everybody holding a role — who to bump when the role's permissions change. */
  userIdsWithRole(roleId: string): Promise<readonly string[]>;
  /**
   * Stores a derived hash and records when.
   *
   * Takes the encoded hash, never a password: the only thing in this module that may see a plaintext
   * password is the authentication service, and widening that is how one ends up in a log line.
   */
  setPasswordHash(id: string, encodedHash: string, at: Date): Promise<void>;
  /** Ends every session a user holds. Called when their password is set or they are disabled. */
  revokeSessions(userId: string, reason: string): Promise<void>;

  // --- Roles ---
  listRoles(request: RoleListRequest): Promise<Page<RoleAdminRow>>;
  findRole(id: string, includeDeleted: boolean): Promise<RoleAdminRow | null>;
  roleKeyTaken(key: string, exceptId: string | null): Promise<boolean>;
  insertRole(input: {
    readonly id: string;
    readonly key: string;
    readonly name: string;
    readonly description: string | null;
    readonly isSystem: boolean;
    readonly permissions: readonly PermissionKey[];
  }): Promise<void>;
  updateRole(
    id: string,
    version: number,
    patch: { readonly name?: string; readonly description?: string | null },
  ): Promise<void>;
  replacePermissions(roleId: string, permissions: readonly PermissionKey[]): Promise<void>;
  setRoleDeleted(id: string, version: number, deleted: boolean): Promise<void>;
  /** Live roles matching these identifiers, so an unknown one is refused rather than dropped. */
  liveRoleIds(ids: readonly string[]): Promise<readonly string[]>;
}
