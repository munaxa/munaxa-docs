'use server';

import {
  type Folder,
  type Library,
  createFolderSchema,
  createLibrarySchema,
  moveFolderSchema,
  updateFolderSchema,
  updateLibrarySchema,
} from '@edms/contracts';

import type { ActionResult } from '../../lib/admin/action-result';
import { adminWrite } from '../../lib/admin/api';
import { validated } from '../../lib/admin/validated';

/**
 * Writes to libraries and their folder trees.
 *
 * Neither of a library's owner-scope fields can be edited, and that is not an omission. Re-homing a
 * library moves every folder and document in it into a different permission chain: every ACL along the
 * old chain silently stops applying and every one along the new chain silently starts. No confirmation
 * dialogue can honestly summarise that, so a library created in the wrong place is deleted while it is
 * still empty.
 */

export async function createLibrary(input: unknown): Promise<ActionResult<Library>> {
  return validated(createLibrarySchema, input, (body) =>
    adminWrite<Library>({ path: '/admin/libraries', method: 'POST', body }),
  );
}

export async function updateLibrary(
  id: string,
  version: number,
  input: unknown,
): Promise<ActionResult<Library>> {
  return validated(updateLibrarySchema, input, (body) =>
    adminWrite<Library>({ path: `/admin/libraries/${id}`, method: 'PATCH', body, version }),
  );
}

export async function deleteLibrary(id: string, version: number): Promise<ActionResult> {
  return adminWrite({ path: `/admin/libraries/${id}`, method: 'DELETE', version });
}

export async function restoreLibrary(id: string, version: number): Promise<ActionResult> {
  return adminWrite({ path: `/admin/libraries/${id}/restore`, method: 'POST', version });
}

export async function createFolder(input: unknown): Promise<ActionResult<Folder>> {
  return validated(createFolderSchema, input, (body) =>
    adminWrite<Folder>({ path: '/admin/folders', method: 'POST', body }),
  );
}

export async function updateFolder(
  id: string,
  version: number,
  input: unknown,
): Promise<ActionResult<Folder>> {
  return validated(updateFolderSchema, input, (body) =>
    adminWrite<Folder>({ path: `/admin/folders/${id}`, method: 'PATCH', body, version }),
  );
}

/** Within one library only. A folder does not cross libraries; its contents would. */
export async function moveFolder(
  id: string,
  version: number,
  input: unknown,
): Promise<ActionResult<Folder>> {
  return validated(moveFolderSchema, input, (body) =>
    adminWrite<Folder>({ path: `/admin/folders/${id}/move`, method: 'POST', body, version }),
  );
}

/**
 * Removes a folder and everything inside it.
 *
 * The cascade is stamped, so restoring brings back exactly the subtree this delete took rather than
 * everything currently deleted underneath — which would resurrect folders somebody removed on purpose
 * weeks earlier.
 */
export async function deleteFolder(id: string, version: number): Promise<ActionResult> {
  return adminWrite({ path: `/admin/folders/${id}`, method: 'DELETE', version });
}

export async function restoreFolder(id: string, version: number): Promise<ActionResult> {
  return adminWrite({ path: `/admin/folders/${id}/restore`, method: 'POST', version });
}
