import { z } from 'zod';

import { LIBRARY_OWNER_SCOPES, type ScopeTypeKey } from '@edms/domain';

import { uuidSchema } from '../common/identifiers';
import { adminListQuerySchema } from '../common/query';
import { administered, codeSchema, descriptionSchema, nameSchema } from './record';

/**
 * Libraries and folders — where documents will live, and the tree ACLs are granted on.
 *
 * No document upload in Phase 2. What is built here is the *place*: a library owned by exactly
 * one organisation node, and a folder tree inside it whose ancestry the permission model walks
 * (`03-domain-model.md` §3).
 */

export const libraryOwnerScopeSchema = z.enum(
  LIBRARY_OWNER_SCOPES as unknown as [ScopeTypeKey, ...ScopeTypeKey[]],
);

/**
 * A folder name, which is not a code.
 *
 * Folders are named by people for people, so the rule is what a filesystem and a
 * `Content-Disposition` header can both survive: no path separators, no control characters, no
 * leading or trailing dot. Unique among live siblings, case-insensitively — two folders differing
 * only by case are indistinguishable to everyone but the database.
 */
export const folderNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[^\\/:*?"<>|]+$/, 'A folder name cannot contain \\ / : * ? " < > or |')
  .refine(
    (value) => !value.startsWith('.') && !value.endsWith('.'),
    'A folder name cannot start or end with a dot.',
  );

// --- Libraries ---------------------------------------------------------------------------

export const createLibrarySchema = z.object({
  code: codeSchema,
  name: nameSchema,
  description: descriptionSchema.optional(),
  /**
   * The organisation node this library belongs to. Exactly one, and it must be a node permission
   * flows through — which is why a branch is not in the list.
   *
   * `ownerScopeId` is absent for `TENANT`: the tenant is implicit, taken from the token, and
   * naming it in a body is the one thing the isolation guard rejects outright.
   */
  ownerScopeType: libraryOwnerScopeSchema,
  ownerScopeId: uuidSchema.nullable().optional(),
  /** The root folder's name. Defaults to the library's own name. */
  rootFolderName: folderNameSchema.optional(),
});

/**
 * Neither owner scope may be edited.
 *
 * Re-homing a library moves every folder and document in it into a different permission chain.
 * Every ACL granted along the old chain silently stops applying, and every one along the new
 * chain silently starts — a change no confirmation dialogue can honestly summarise. A library
 * created in the wrong place is deleted while it is empty.
 */
export const updateLibrarySchema = z
  .object({
    code: codeSchema,
    name: nameSchema,
    description: descriptionSchema.nullable(),
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, 'Name at least one field to change.');

export const librarySchema = administered({
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  ownerScopeType: libraryOwnerScopeSchema,
  ownerScopeId: uuidSchema.nullable(),
  /** The owning node's name, so a list does not need one lookup per row. */
  ownerScopeName: z.string(),
  rootFolderId: uuidSchema,
  folderCount: z.number().int().min(0),
});

export const libraryListQuerySchema = adminListQuerySchema([
  'createdAt',
  'updatedAt',
  'name',
  'code',
]).extend({
  ownerScopeType: libraryOwnerScopeSchema.optional(),
  ownerScopeId: uuidSchema.optional(),
});

export type CreateLibraryBody = z.infer<typeof createLibrarySchema>;
export type UpdateLibraryBody = z.infer<typeof updateLibrarySchema>;
export type Library = z.infer<typeof librarySchema>;
export type LibraryListQuery = z.infer<typeof libraryListQuerySchema>;

// --- Folders -----------------------------------------------------------------------------

export const createFolderSchema = z.object({
  libraryId: uuidSchema,
  /** Null is refused: a library has exactly one root, created with it. */
  parentId: uuidSchema,
  name: folderNameSchema,
  description: descriptionSchema.optional(),
  /**
   * Whether ACLs inherit from above.
   *
   * Setting it false stops the walk at this node — which is how a restricted subtree is built,
   * and why administrative permissions are exempt from it: otherwise a user could hide a subtree
   * from the administrators accountable for it (`08-permission-model.md` §3).
   */
  inheritAcl: z.boolean().default(true),
});

export const updateFolderSchema = z
  .object({
    name: folderNameSchema,
    description: descriptionSchema.nullable(),
    inheritAcl: z.boolean(),
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, 'Name at least one field to change.');

/** Moving within one library only. A folder does not cross libraries; its contents would. */
export const moveFolderSchema = z.object({
  parentId: uuidSchema,
});

export const folderSchema = administered({
  libraryId: uuidSchema,
  libraryName: z.string(),
  parentId: uuidSchema.nullable(),
  name: z.string(),
  description: z.string().nullable(),
  path: z.string(),
  depth: z.number().int().min(1),
  inheritAcl: z.boolean(),
  /** True for the folder created with the library: it cannot be moved, renamed away or deleted. */
  isRoot: z.boolean(),
  childCount: z.number().int().min(0),
});

export const folderListQuerySchema = adminListQuerySchema([
  'createdAt',
  'updatedAt',
  'name',
  'path',
]).extend({
  libraryId: uuidSchema.optional(),
  parentId: z.union([uuidSchema, z.literal('null')]).optional(),
  underId: uuidSchema.optional(),
});

export type CreateFolderBody = z.infer<typeof createFolderSchema>;
export type UpdateFolderBody = z.infer<typeof updateFolderSchema>;
export type MoveFolderBody = z.infer<typeof moveFolderSchema>;
export type Folder = z.infer<typeof folderSchema>;
export type FolderListQuery = z.infer<typeof folderListQuerySchema>;
