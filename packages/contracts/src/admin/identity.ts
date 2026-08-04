import { z } from 'zod';

import { ALL_PERMISSIONS, type PermissionKey, UserStatus } from '@edms/domain';

import { isoDateTimeSchema, uuidSchema } from '../common/identifiers';
import { adminListQuerySchema } from '../common/query';
import { administered, configurationKeySchema, descriptionSchema, nameSchema } from './record';

/**
 * Users, roles and the permission matrix, as an administrator edits them.
 *
 * The catalogue is the boundary: `permissionKeySchema` is built *from* `ALL_PERMISSIONS`, so a
 * role cannot be granted a permission the product does not define, and adding a permission to
 * the catalogue is the only way to make it grantable (`08-permission-model.md` §2).
 */
export const permissionKeySchema = z.enum(ALL_PERMISSIONS as [PermissionKey, ...PermissionKey[]]);

export const userStatusSchema = z.nativeEnum(UserStatus);

// --- Users -------------------------------------------------------------------------------

/**
 * An email address, as far as this product is willing to judge one.
 *
 * Deliberately permissive: RFC 5322 admits addresses that every regular expression in production
 * rejects, and the cost of refusing a real address is a person who cannot be given an account.
 * Deliverability is proven by delivering, not by a pattern.
 */
export const emailSchema = z.string().trim().min(3).max(320).includes('@');

export const departmentMembershipSchema = z.object({
  departmentId: uuidSchema,
  /**
   * Exactly one membership may be primary, and it drives routing and numbering defaults. The
   * database holds that with a partial unique index, so a second primary is refused rather than
   * both being accepted and the winner decided by query order.
   */
  isPrimary: z.boolean().default(false),
  /**
   * Whether this person manages the department rather than merely belonging to it.
   *
   * Added by Phase 4, because `MANAGER_OF` is one of the workflow engine's participant resolvers
   * (`07-workflow-architecture.md` §2) and nothing in the model said who managed anything. A flag
   * on the membership rather than a column on the department: a department can have two managers
   * and a person can manage one department while belonging to three, and both are ordinary.
   */
  isManager: z.boolean().default(false),
});

export const createUserSchema = z.object({
  email: emailSchema,
  displayName: nameSchema,
  /**
   * Roles granted tenant-wide.
   *
   * Tenant-wide is the only reach Phase 2 offers, and that is a deliberate limit rather than an
   * omission: a role granted on one node needs the ACL resolver to enforce the boundary, and
   * until that exists a scoped grant would be stored as scoped and enforced as tenant-wide —
   * which is worse than not offering it.
   */
  roleIds: z.array(uuidSchema).max(32).default([]),
  departments: z.array(departmentMembershipSchema).max(32).default([]),
});

export const updateUserSchema = z
  .object({
    /** Changing an address changes the sign-in identity, and is audited as such. */
    email: emailSchema,
    displayName: nameSchema,
    roleIds: z.array(uuidSchema).max(32),
    departments: z.array(departmentMembershipSchema).max(32),
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, 'Name at least one field to change.');

/**
 * An administrator setting somebody's password.
 *
 * The tenant's password policy applies, because this is a password being *set* — and every
 * session the user holds is revoked, because the person who knew the old password may not be
 * the person who should keep the session (`17-security-architecture.md` §2).
 */
export const setUserPasswordSchema = z.object({
  password: z.string().min(1).max(1024),
});

export const userSchema = administered({
  email: z.string(),
  displayName: z.string(),
  status: userStatusSchema,
  mfaEnrolled: z.boolean(),
  lastLoginAt: isoDateTimeSchema.nullable(),
  /** False for an invited user who has not set one, and for a federated account. */
  hasPassword: z.boolean(),
  roles: z.array(z.object({ id: uuidSchema, key: z.string(), name: z.string() })),
  departments: z.array(
    z.object({
      departmentId: uuidSchema,
      name: z.string(),
      code: z.string(),
      isPrimary: z.boolean(),
      isManager: z.boolean(),
    }),
  ),
});

export const userListQuerySchema = adminListQuerySchema([
  'createdAt',
  'updatedAt',
  'displayName',
  'email',
  'lastLoginAt',
]).extend({
  status: userStatusSchema.optional(),
  roleId: uuidSchema.optional(),
  departmentId: uuidSchema.optional(),
});

export type CreateUserBody = z.infer<typeof createUserSchema>;
export type UpdateUserBody = z.infer<typeof updateUserSchema>;
export type SetUserPasswordBody = z.infer<typeof setUserPasswordSchema>;
export type User = z.infer<typeof userSchema>;
export type UserListQuery = z.infer<typeof userListQuerySchema>;

// --- Roles -------------------------------------------------------------------------------

export const createRoleSchema = z.object({
  key: configurationKeySchema,
  name: nameSchema,
  description: descriptionSchema.optional(),
  permissions: z.array(permissionKeySchema).max(ALL_PERMISSIONS.length).default([]),
});

/**
 * `key` is absent, and for system roles that is the whole point.
 *
 * The product refers to the eight seeded roles by key — the MFA policy names them, reports group
 * by them, the seed finds them. Renaming a key would break those silently, so a key is chosen
 * once. The *name* and the *permissions* are ordinary tenant data on every role, system or not:
 * a tenant whose approvers must also publish should not need a release
 * (`08-permission-model.md` §5).
 */
export const updateRoleSchema = z
  .object({
    name: nameSchema,
    description: descriptionSchema.nullable(),
    permissions: z.array(permissionKeySchema).max(ALL_PERMISSIONS.length),
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, 'Name at least one field to change.');

export const roleSchema = administered({
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  /** Seeded by the product: the key cannot change and the role cannot be deleted. */
  isSystem: z.boolean(),
  permissions: z.array(permissionKeySchema),
  memberCount: z.number().int().min(0),
});

export const roleListQuerySchema = adminListQuerySchema([
  'createdAt',
  'updatedAt',
  'name',
  'key',
]).extend({
  /** Filters to the roles holding a permission — "who can approve" is a question admins ask. */
  permission: permissionKeySchema.optional(),
});

export type CreateRoleBody = z.infer<typeof createRoleSchema>;
export type UpdateRoleBody = z.infer<typeof updateRoleSchema>;
export type Role = z.infer<typeof roleSchema>;
export type RoleListQuery = z.infer<typeof roleListQuerySchema>;

// --- The permission catalogue ------------------------------------------------------------

/**
 * The permissions the product defines, grouped for a screen.
 *
 * Served rather than bundled into the client so that the API and the UI can never disagree about
 * what exists: the matrix editor renders this, and a permission absent from it is a permission
 * the API would refuse anyway.
 */
export const permissionDescriptorSchema = z.object({
  key: permissionKeySchema,
  /** The `resource` half of `resource:action` — what the matrix editor groups rows by. */
  resource: z.string(),
  action: z.string(),
  /** Administrative permissions a broken-inheritance folder cannot hide (§3). */
  survivesBrokenInheritance: z.boolean(),
});

export const permissionCatalogueSchema = z.object({
  data: z.array(permissionDescriptorSchema),
});

export type PermissionDescriptor = z.infer<typeof permissionDescriptorSchema>;
export type PermissionCatalogue = z.infer<typeof permissionCatalogueSchema>;
