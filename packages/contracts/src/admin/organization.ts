import { z } from 'zod';

import { uuidSchema } from '../common/identifiers';
import { adminListQuerySchema } from '../common/query';
import { administered, codeSchema, descriptionSchema, nameSchema } from './record';

/**
 * The scope tree, as it is created and edited.
 *
 * The read side shipped in Phase 1; these are the shapes that write it. Four resources rather
 * than one polymorphic "node", because the fields genuinely differ — an entity has a legal name,
 * a branch has an address, a department has a parent — and a union with four optional halves
 * would let a client send a department's parent to a company and be told nothing.
 */

// --- Company -----------------------------------------------------------------------------

export const createCompanySchema = z.object({
  code: codeSchema,
  name: nameSchema,
});

/**
 * Every field optional, and at least one required.
 *
 * `PATCH` means "change what I name"; an empty body is a request that asks for nothing, and
 * answering it with a version bump would make an audit trail of edits that changed nothing.
 */
export const updateCompanySchema = createCompanySchema
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, 'Name at least one field to change.');

export const companySchema = administered({
  code: z.string(),
  name: z.string(),
  /** Live entities directly under this company — what the list shows without a second call. */
  entityCount: z.number().int().min(0),
});

export const companyListQuerySchema = adminListQuerySchema([
  'createdAt',
  'updatedAt',
  'name',
  'code',
]);

export type CreateCompanyBody = z.infer<typeof createCompanySchema>;
export type UpdateCompanyBody = z.infer<typeof updateCompanySchema>;
export type Company = z.infer<typeof companySchema>;
export type CompanyListQuery = z.infer<typeof companyListQuerySchema>;

// --- Entity ------------------------------------------------------------------------------

export const createEntitySchema = z.object({
  companyId: uuidSchema,
  code: codeSchema,
  name: nameSchema,
  legalName: nameSchema.optional(),
});

/**
 * `companyId` is deliberately absent.
 *
 * Moving an entity between companies moves every branch, department, library and document under
 * it into another company's permission chain — silently, from the caller's point of view. That is
 * a re-parenting operation with its own audit event and its own confirmation, not a field on a
 * form, and Phase 2 does not offer it: an entity created under the wrong company is deleted and
 * recreated while it is still empty.
 */
export const updateEntitySchema = z
  .object({
    code: codeSchema,
    name: nameSchema,
    legalName: nameSchema.nullable(),
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, 'Name at least one field to change.');

export const entitySchema = administered({
  companyId: uuidSchema,
  companyName: z.string(),
  code: z.string(),
  name: z.string(),
  legalName: z.string().nullable(),
  departmentCount: z.number().int().min(0),
  branchCount: z.number().int().min(0),
});

export const entityListQuerySchema = adminListQuerySchema([
  'createdAt',
  'updatedAt',
  'name',
  'code',
]).extend({
  companyId: uuidSchema.optional(),
});

export type CreateEntityBody = z.infer<typeof createEntitySchema>;
export type UpdateEntityBody = z.infer<typeof updateEntitySchema>;
export type Entity = z.infer<typeof entitySchema>;
export type EntityListQuery = z.infer<typeof entityListQuerySchema>;

// --- Branch ------------------------------------------------------------------------------

export const createBranchSchema = z.object({
  entityId: uuidSchema,
  code: codeSchema,
  name: nameSchema,
  address: descriptionSchema.optional(),
});

export const updateBranchSchema = z
  .object({
    code: codeSchema,
    name: nameSchema,
    address: descriptionSchema.nullable(),
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, 'Name at least one field to change.');

export const branchSchema = administered({
  entityId: uuidSchema,
  entityName: z.string(),
  code: z.string(),
  name: z.string(),
  address: z.string().nullable(),
  departmentCount: z.number().int().min(0),
});

export const branchListQuerySchema = adminListQuerySchema([
  'createdAt',
  'updatedAt',
  'name',
  'code',
]).extend({
  entityId: uuidSchema.optional(),
});

export type CreateBranchBody = z.infer<typeof createBranchSchema>;
export type UpdateBranchBody = z.infer<typeof updateBranchSchema>;
export type Branch = z.infer<typeof branchSchema>;
export type BranchListQuery = z.infer<typeof branchListQuerySchema>;

// --- Department --------------------------------------------------------------------------

export const createDepartmentSchema = z.object({
  entityId: uuidSchema,
  /** Null for a department directly under the entity. */
  parentId: uuidSchema.nullable().optional(),
  /** Null for a department not tied to a location. */
  branchId: uuidSchema.nullable().optional(),
  code: codeSchema,
  name: nameSchema,
});

/**
 * `parentId` is here, unlike `entityId` on an entity, because re-parenting a department **is** an
 * ordinary operation: reorganisations happen, and the tree exists to survive them.
 *
 * It is also the one edit that rewrites data the permission model reads — the materialised path
 * of the whole subtree — so it publishes `organization.department-moved` and every ACL granted
 * along the old chain stops applying. The move endpoint is separate for that reason; this schema
 * carries `parentId` so a form can express both, and the service treats a changed parent as a
 * move whichever route it arrived on.
 */
export const updateDepartmentSchema = z
  .object({
    code: codeSchema,
    name: nameSchema,
    branchId: uuidSchema.nullable(),
    parentId: uuidSchema.nullable(),
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, 'Name at least one field to change.');

export const moveDepartmentSchema = z.object({
  /** Null moves the department to the top level of its entity. */
  parentId: uuidSchema.nullable(),
});

export const departmentSchema = administered({
  entityId: uuidSchema,
  entityName: z.string(),
  branchId: uuidSchema.nullable(),
  branchName: z.string().nullable(),
  parentId: uuidSchema.nullable(),
  code: z.string(),
  name: z.string(),
  /** Materialised ancestry, this department last. Derived; never sent by a client. */
  path: z.string(),
  /** How many nodes down the tree this sits — 1 for a department under its entity. */
  depth: z.number().int().min(1),
  memberCount: z.number().int().min(0),
  childCount: z.number().int().min(0),
});

export const departmentListQuerySchema = adminListQuerySchema([
  'createdAt',
  'updatedAt',
  'name',
  'code',
  'path',
]).extend({
  entityId: uuidSchema.optional(),
  branchId: uuidSchema.optional(),
  /** Direct children of this node. `null` as a string selects the roots of an entity. */
  parentId: z.union([uuidSchema, z.literal('null')]).optional(),
  /** Everything at or below this node, at any depth — the tree view's single call. */
  underId: uuidSchema.optional(),
});

export type CreateDepartmentBody = z.infer<typeof createDepartmentSchema>;
export type UpdateDepartmentBody = z.infer<typeof updateDepartmentSchema>;
export type MoveDepartmentBody = z.infer<typeof moveDepartmentSchema>;
export type Department = z.infer<typeof departmentSchema>;
export type DepartmentListQuery = z.infer<typeof departmentListQuerySchema>;
