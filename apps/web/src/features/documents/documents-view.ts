import type { ListState } from '../../lib/admin/list-state';

/**
 * Which question `/documents` is answering.
 *
 * One route serves two of them and, until this module existed, nothing said which. The screen
 * assumed the first and the API sometimes answered the second, which is how the library came to
 * describe a folder the reader was not looking at.
 *
 * - **`folder`** — "what is in here". The list the API returns is scoped to one folder, so the
 *   folder's name, its ancestors and its subfolder count are all true of what is on screen.
 * - **`filtered`** — "which documents match this". The list is *not* folder-scoped, so nothing about
 *   a folder is true of it. Only `favorite` produces this today; see `documentsView` below.
 * - **`empty`** — no library exists yet, so there is nothing to be in.
 *
 * ## Why both functions live here
 *
 * `page.tsx` decides whether to send the API a default folder filter. This module decides what the
 * header may claim. Those are the same decision, and when they were written in two places they
 * disagreed: `page.tsx` dropped the folder scope for `favorite=true` while the screen went on
 * naming a folder and counting its children. Stating the predicate once is what stops that
 * recurring — `documents-view.spec.ts` asserts the two agree across every combination of the three
 * keys that matter.
 */
export type DocumentsView = 'folder' | 'filtered' | 'empty';

/**
 * Whether `page.tsx` must supply the folder scope the URL left out.
 *
 * A URL naming only a library means "this library's root", not "the whole tenant" — but a URL
 * asking for favourites means exactly the whole tenant, and adding a folder to it would silently
 * narrow the answer to the one folder that happened to be selected.
 *
 * This is the condition `page.tsx` already applied, extracted and named rather than changed: the
 * filters it produces are identical.
 */
export function suppliesDefaultFolderScope(filters: ListState['filters']): boolean {
  return (
    filters['folderId'] === undefined &&
    filters['underFolderId'] === undefined &&
    filters['favorite'] === undefined
  );
}

/**
 * Which view the URL describes.
 *
 * `favorite` is the only filter that takes the list out of a folder, and that is deliberate rather
 * than incidental: `status`, `ownerUserId`, `documentTypeId`, `categoryId` and `confidentialityId`
 * all *narrow* a folder's contents, so the folder's name and subfolder count stay true of what is on
 * screen and the view is still `folder`. Favourites are collected across the tenant, so they are
 * not.
 *
 * A second de-scoping filter would need a name of its own here — `filtered` currently renders as
 * "Favourites", which is honest only while favourites are the only way to reach it.
 */
export function documentsView(filters: ListState['filters'], hasLibrary: boolean): DocumentsView {
  if (!hasLibrary) {
    return 'empty';
  }
  // An explicit folder in the URL wins over any filter beside it: `?folderId=X&favorite=true` is
  // "the favourites in X", which is still a folder's contents.
  const namesAFolder = filters['folderId'] !== undefined || filters['underFolderId'] !== undefined;
  return !namesAFolder && filters['favorite'] !== undefined ? 'filtered' : 'folder';
}
