'use server';

import { replaceAclSchema, setInheritanceSchema } from '@edms/contracts';
import { AclSubjectType } from '@edms/domain';

import { type ActionResult, succeeded } from '../../lib/admin/action-result';
import { adminRead, adminWrite } from '../../lib/admin/api';
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

/**
 * The subjects an entry may name, matching what somebody typed — Slice 13.
 *
 * ## Why this exists
 *
 * The three pickers were rendered from one page of a hundred options, fetched on the server and
 * inlined into a `<select>`. A tenant with more than a hundred people has people the picker cannot
 * offer: they sort after position 100 by display name and there is no way to ask for them. The
 * operational read models have accepted `search` since they were written; nothing had ever sent it.
 *
 * ## Why it is a server action rather than a fetch
 *
 * Because there is no browser-side API client, and adding one would mean handing the access token
 * to a script — `lib/admin/api` is `import 'server-only'` and the token lives in an `httpOnly`
 * cookie (`17-security-architecture.md` §2). A searching picker needs a request per keystroke-ish,
 * so the request goes out from the server exactly as the first page did.
 *
 * ## What it does not do
 *
 * It does not widen anything. Each branch calls the same endpoint the page already calls, with the
 * same guard, the same tenant scope and the same narrow projection — `/directory/people` and
 * `/directory/departments` on `directory:view`, `/acl/roles` on `document:permission:manage`. The
 * only thing that changes is that `search` is now populated, and the server does the matching.
 *
 * The page size stays at the API's maximum, which is a hard bound rather than a convention:
 * `pageQuerySchema` **rejects** a request above `MAX_PAGE_SIZE` instead of clamping it, so there is
 * no spelling of "give me the whole catalogue" for this or any other caller to send.
 */
export async function searchAclSubjects(
  subjectType: string,
  term: string,
): Promise<ActionResult<readonly { readonly id: string; readonly name: string }[]>> {
  const trimmed = term.trim();
  const query = new URLSearchParams({
    page: '1',
    pageSize: '100',
    sortDirection: 'asc',
    sortBy: subjectType === AclSubjectType.USER ? 'displayName' : 'name',
  });
  // Omitted rather than sent empty: `searchTermSchema` requires at least one character, so a blank
  // term is the *unfiltered* first page — which is what an opened picker should show.
  if (trimmed !== '') {
    query.set('search', trimmed);
  }

  const path =
    subjectType === AclSubjectType.USER
      ? '/directory/people'
      : subjectType === AclSubjectType.DEPARTMENT
        ? '/directory/departments'
        : '/acl/roles';

  const answer = await adminRead<{
    readonly data: readonly {
      readonly id: string;
      readonly displayName?: string;
      readonly name?: string;
    }[];
  }>(`${path}?${query.toString()}`);

  return answer.ok
    ? succeeded(
        answer.value.data.map((row) => ({
          id: row.id,
          name: row.displayName ?? row.name ?? row.id,
        })),
      )
    : answer;
}
