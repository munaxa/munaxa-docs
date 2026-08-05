'use server';

import { replaceAclSchema, setInheritanceSchema } from '@edms/contracts';

import type { ActionResult } from '../../lib/admin/action-result';
import { adminWrite } from '../../lib/admin/api';
import { validated } from '../../lib/admin/validated';

/**
 * Writes to a scope node's ACL.
 *
 * Server actions, like every other write in this product, so the access token stays in its
 * `httpOnly` cookie and never reaches client JavaScript.
 *
 * **One action for the whole matrix, because the API takes the whole matrix.** A grant and a
 * revocation posted separately would leave an interval in which a node had its new denies and not
 * yet its new allows — or the reverse, which is worse — and an interval in which a folder is more
 * open than either the old state or the new one is a disclosure nobody asked for. The API's `PUT`
 * exists for that reason and this mirrors it rather than smoothing it over.
 *
 * **Nothing here decides anything.** The screen renders what `GET .../permissions/effective`
 * answered; it does not compute an effective permission from the explicit entries, because that
 * computation is the walk and the walk has exactly one implementation
 * (`docs/architecture/08-permission-model.md` §7's UI row: "the server computes this and the UI
 * renders from it; the client never decides a permission").
 */

export async function replaceScopeAcl(
  scopeType: string,
  scopeId: string,
  input: unknown,
): Promise<ActionResult> {
  return validated(replaceAclSchema, input, (body) =>
    adminWrite({
      path: `/scopes/${scopeType.toLowerCase()}/${scopeId}/permissions`,
      method: 'PUT',
      body,
    }),
  );
}

/**
 * Breaks or restores ACL inheritance on a folder.
 *
 * Its own action rather than a field on the folder edit form, for the same reason it is its own
 * endpoint: ADR-0005 singles this out as "the operation most likely to hide content from the people
 * accountable for it", it writes its own audit action, and it is gated on
 * `document:permission:manage` rather than on `folder:manage` — so somebody who may rename folders
 * cannot quietly detach one from the tenant's grants.
 */
export async function setFolderInheritance(
  folderId: string,
  input: unknown,
  version?: number,
): Promise<ActionResult> {
  return validated(setInheritanceSchema, input, (body) =>
    adminWrite({
      path: `/scopes/folder/${folderId}/permissions/inheritance`,
      method: 'PUT',
      body,
      ...(version !== undefined && { version }),
    }),
  );
}
