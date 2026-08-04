'use server';

import {
  type Role,
  type User,
  createRoleSchema,
  createUserSchema,
  setUserPasswordSchema,
  updateRoleSchema,
  updateUserSchema,
} from '@edms/contracts';

import type { ActionResult } from '../../lib/admin/action-result';
import { adminWrite } from '../../lib/admin/api';
import { validated } from '../../lib/admin/validated';

/**
 * Writes to people and roles.
 *
 * Two of these are unlike an ordinary edit and are separate endpoints for that reason. Setting a
 * password ends every session the person holds, because whoever knew the old one may not be whoever
 * should keep the session. Disabling an account does the same. Neither is a field on a form.
 */

export async function createUser(input: unknown): Promise<ActionResult<User>> {
  return validated(createUserSchema, input, (body) =>
    adminWrite<User>({ path: '/admin/users', method: 'POST', body }),
  );
}

export async function updateUser(
  id: string,
  version: number,
  input: unknown,
): Promise<ActionResult<User>> {
  return validated(updateUserSchema, input, (body) =>
    adminWrite<User>({ path: `/admin/users/${id}`, method: 'PATCH', body, version }),
  );
}

/**
 * Sets somebody's password.
 *
 * The password is never returned, never logged and never echoed back into the form. The API records
 * that it happened without recording what it was, which is the only honest way to audit this.
 */
export async function setUserPassword(id: string, input: unknown): Promise<ActionResult> {
  return validated(setUserPasswordSchema, input, (body) =>
    adminWrite({ path: `/admin/users/${id}/password`, method: 'PUT', body }),
  );
}

export async function activateUser(id: string, version: number): Promise<ActionResult<User>> {
  return adminWrite<User>({ path: `/admin/users/${id}/activate`, method: 'POST', version });
}

export async function disableUser(id: string, version: number): Promise<ActionResult<User>> {
  return adminWrite<User>({ path: `/admin/users/${id}/disable`, method: 'POST', version });
}

export async function deleteUser(id: string, version: number): Promise<ActionResult> {
  return adminWrite({ path: `/admin/users/${id}`, method: 'DELETE', version });
}

export async function restoreUser(id: string, version: number): Promise<ActionResult> {
  return adminWrite({ path: `/admin/users/${id}/restore`, method: 'POST', version });
}

export async function createRole(input: unknown): Promise<ActionResult<Role>> {
  return validated(createRoleSchema, input, (body) =>
    adminWrite<Role>({ path: '/admin/roles', method: 'POST', body }),
  );
}

/**
 * Edits a role, including a built-in one.
 *
 * A system role's *key* is fixed — the product refers to the eight seeded roles by key — but its name
 * and its permissions are ordinary tenant data. A tenant whose approvers must also publish should not
 * need a release (`docs/architecture/08-permission-model.md` §5).
 */
export async function updateRole(
  id: string,
  version: number,
  input: unknown,
): Promise<ActionResult<Role>> {
  return validated(updateRoleSchema, input, (body) =>
    adminWrite<Role>({ path: `/admin/roles/${id}`, method: 'PATCH', body, version }),
  );
}

export async function deleteRole(id: string, version: number): Promise<ActionResult> {
  return adminWrite({ path: `/admin/roles/${id}`, method: 'DELETE', version });
}

export async function restoreRole(id: string, version: number): Promise<ActionResult> {
  return adminWrite({ path: `/admin/roles/${id}/restore`, method: 'POST', version });
}
