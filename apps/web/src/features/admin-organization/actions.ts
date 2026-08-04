'use server';

import {
  type Branch,
  type Company,
  type Department,
  type Entity,
  createBranchSchema,
  createCompanySchema,
  createDepartmentSchema,
  createEntitySchema,
  moveDepartmentSchema,
  updateBranchSchema,
  updateCompanySchema,
  updateDepartmentSchema,
  updateEntitySchema,
} from '@edms/contracts';

import type { ActionResult } from '../../lib/admin/action-result';
import { adminWrite } from '../../lib/admin/api';
import { validated } from '../../lib/admin/validated';

/**
 * Writes to the scope tree.
 *
 * Four resources rather than one polymorphic node, matching the API for the reason the contract gives:
 * the fields genuinely differ, and a union with four optional halves would let a caller send a
 * department's parent to a company and be told nothing.
 *
 * Every update and every removal carries the record's version as `If-Match`. Two administrators
 * reorganising at once is the ordinary case in this module, not the exotic one.
 */

export async function createCompany(input: unknown): Promise<ActionResult<Company>> {
  return validated(createCompanySchema, input, (body) =>
    adminWrite<Company>({ path: '/admin/companies', method: 'POST', body }),
  );
}

export async function updateCompany(
  id: string,
  version: number,
  input: unknown,
): Promise<ActionResult<Company>> {
  return validated(updateCompanySchema, input, (body) =>
    adminWrite<Company>({ path: `/admin/companies/${id}`, method: 'PATCH', body, version }),
  );
}

export async function deleteCompany(id: string, version: number): Promise<ActionResult> {
  return adminWrite({ path: `/admin/companies/${id}`, method: 'DELETE', version });
}

export async function restoreCompany(id: string, version: number): Promise<ActionResult> {
  return adminWrite({ path: `/admin/companies/${id}/restore`, method: 'POST', version });
}

export async function createEntity(input: unknown): Promise<ActionResult<Entity>> {
  return validated(createEntitySchema, input, (body) =>
    adminWrite<Entity>({ path: '/admin/entities', method: 'POST', body }),
  );
}

export async function updateEntity(
  id: string,
  version: number,
  input: unknown,
): Promise<ActionResult<Entity>> {
  return validated(updateEntitySchema, input, (body) =>
    adminWrite<Entity>({ path: `/admin/entities/${id}`, method: 'PATCH', body, version }),
  );
}

export async function deleteEntity(id: string, version: number): Promise<ActionResult> {
  return adminWrite({ path: `/admin/entities/${id}`, method: 'DELETE', version });
}

export async function restoreEntity(id: string, version: number): Promise<ActionResult> {
  return adminWrite({ path: `/admin/entities/${id}/restore`, method: 'POST', version });
}

export async function createBranch(input: unknown): Promise<ActionResult<Branch>> {
  return validated(createBranchSchema, input, (body) =>
    adminWrite<Branch>({ path: '/admin/branches', method: 'POST', body }),
  );
}

export async function updateBranch(
  id: string,
  version: number,
  input: unknown,
): Promise<ActionResult<Branch>> {
  return validated(updateBranchSchema, input, (body) =>
    adminWrite<Branch>({ path: `/admin/branches/${id}`, method: 'PATCH', body, version }),
  );
}

export async function deleteBranch(id: string, version: number): Promise<ActionResult> {
  return adminWrite({ path: `/admin/branches/${id}`, method: 'DELETE', version });
}

export async function restoreBranch(id: string, version: number): Promise<ActionResult> {
  return adminWrite({ path: `/admin/branches/${id}/restore`, method: 'POST', version });
}

export async function createDepartment(input: unknown): Promise<ActionResult<Department>> {
  return validated(createDepartmentSchema, input, (body) =>
    adminWrite<Department>({ path: '/admin/departments', method: 'POST', body }),
  );
}

export async function updateDepartment(
  id: string,
  version: number,
  input: unknown,
): Promise<ActionResult<Department>> {
  return validated(updateDepartmentSchema, input, (body) =>
    adminWrite<Department>({ path: `/admin/departments/${id}`, method: 'PATCH', body, version }),
  );
}

/**
 * Re-parenting, which is its own endpoint rather than a field on the edit form.
 *
 * A move rewrites the materialised path of the whole subtree, and every permission granted along the
 * old chain stops applying. That deserves its own confirmation and its own audit event, not a
 * silently-changed select box (`docs/architecture/14-adr/ADR-0014` and the contract's own note).
 */
export async function moveDepartment(
  id: string,
  version: number,
  input: unknown,
): Promise<ActionResult<Department>> {
  return validated(moveDepartmentSchema, input, (body) =>
    adminWrite<Department>({
      path: `/admin/departments/${id}/move`,
      method: 'POST',
      body,
      version,
    }),
  );
}

export async function deleteDepartment(id: string, version: number): Promise<ActionResult> {
  return adminWrite({ path: `/admin/departments/${id}`, method: 'DELETE', version });
}

export async function restoreDepartment(id: string, version: number): Promise<ActionResult> {
  return adminWrite({ path: `/admin/departments/${id}/restore`, method: 'POST', version });
}
