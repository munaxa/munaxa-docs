import { z } from 'zod';

import { uuidSchema } from '../common/identifiers';
import { permissionKeySchema } from './identity';

/**
 * ACL entries on a scope node — the reach half of `08-permission-model.md`.
 *
 * The wire shape an administrator edits. Capability is roles and lives in `admin/identity.ts`;
 * this is where a permission the caller already holds does or does not apply, which is why an
 * entry has no "grants" flag and why the two screens are separate.
 */

export const scopeTypeSchema = z.enum([
  'TENANT',
  'COMPANY',
  'ENTITY',
  'DEPARTMENT',
  'LIBRARY',
  'FOLDER',
  'DOCUMENT',
]);

export const aclSubjectTypeSchema = z.enum(['USER', 'ROLE', 'DEPARTMENT']);

export const aclEffectSchema = z.enum(['ALLOW', 'DENY']);

/**
 * `permissionKeySchema` is imported from `admin/identity` rather than declared again.
 *
 * There is exactly one catalogue (`08 §2`), and a second `z.enum` over it would be a second place
 * to forget when a permission is added. Roles grant capability and entries grant reach; the set of
 * keys they speak of is the same set, and the schema says so by being the same schema.
 */

export const aclEntrySchema = z.object({
  subjectType: aclSubjectTypeSchema,
  subjectId: uuidSchema,
  permission: permissionKeySchema,
  effect: aclEffectSchema,
});

export const storedAclEntrySchema = aclEntrySchema.extend({
  id: uuidSchema,
  scopeType: scopeTypeSchema,
  scopeId: uuidSchema,
  createdAt: z.string(),
  createdBy: uuidSchema.nullable(),
});

/**
 * The whole of a node's explicit entries, posted as one set.
 *
 * A `PUT` rather than a pair of grant/revoke endpoints, and the reason is a window rather than
 * taste: two calls would leave an interval in which a node had its new denies and not yet its new
 * allows — or, worse, the reverse — and an interval in which a folder is more open than either the
 * old state or the new one is a disclosure nobody asked for.
 */
export const replaceAclSchema = z.object({
  entries: z.array(aclEntrySchema).max(500),
});

export const setInheritanceSchema = z.object({
  /** False stops the walk at this folder — `INHERITANCE_BROKEN` in the trail. */
  inheritAcl: z.boolean(),
});

/** One permission's answer for one person on one object, and the node that decided it. */
export const effectivePermissionSchema = z.object({
  permission: permissionKeySchema,
  allowed: z.boolean(),
  decidedAtType: scopeTypeSchema.nullable(),
  decidedAtId: uuidSchema.nullable(),
  /** What that node is called — so the screen can say *why* without a second round of lookups. */
  decidedAtName: z.string().nullable(),
  reason: z.enum(['ALLOW', 'DENY', 'ROLE_GRANT', 'CLOSED_BY_DEFAULT']),
});

export const scopeChainNodeSchema = z.object({
  type: scopeTypeSchema,
  id: uuidSchema,
  name: z.string(),
  breaksInheritance: z.boolean(),
});

/**
 * A node's own entries, with the chain they sit on.
 *
 * The chain is here as well as on the effective answer because it is a property of the *node*, not
 * of a person: whether a folder above this one has stopped inheriting is true before anybody is
 * named, and a screen that could only show it after choosing somebody would hide the one fact an
 * administrator opens the screen to check.
 */
export const explicitAclSchema = z.object({
  entries: z.array(storedAclEntrySchema),
  chain: z.array(scopeChainNodeSchema),
  inheritanceBroken: z.boolean(),
  /** Null unless this node is a folder — only a folder carries the flag. */
  folderId: uuidSchema.nullable(),
  folderInheritsAcl: z.boolean().nullable(),
});

/**
 * ADR-0005's mitigation, as a response body.
 *
 * *"A `DENY` is a blunt instrument and administrators must be told so: the UI shows, for any user
 * and object, the effective permission and the node that decided it."* Everything on this shape
 * exists to make that sentence renderable — the answers, the node behind each, and the chain they
 * were resolved over, already truncated by any inheritance break so the screen shows what the walk
 * actually crossed rather than what the tree contains.
 */
export const effectivePermissionsSchema = z.object({
  scopeType: scopeTypeSchema,
  scopeId: uuidSchema,
  userId: uuidSchema,
  permissions: z.array(effectivePermissionSchema),
  chain: z.array(scopeChainNodeSchema),
  inheritanceBroken: z.boolean(),
});

export type ScopeTypeValue = z.infer<typeof scopeTypeSchema>;
export type AclEntryBody = z.infer<typeof aclEntrySchema>;
export type StoredAclEntry = z.infer<typeof storedAclEntrySchema>;
export type ReplaceAclBody = z.infer<typeof replaceAclSchema>;
export type SetInheritanceBody = z.infer<typeof setInheritanceSchema>;
export type EffectivePermission = z.infer<typeof effectivePermissionSchema>;
export type EffectivePermissions = z.infer<typeof effectivePermissionsSchema>;
export type ScopeChainNode = z.infer<typeof scopeChainNodeSchema>;
export type ExplicitAcl = z.infer<typeof explicitAclSchema>;
