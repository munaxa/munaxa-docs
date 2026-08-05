'use server';

import {
  type SavedSearch,
  type SearchResults,
  createSavedSearchSchema,
  updateSavedSearchSchema,
} from '@edms/contracts';

import type { ActionResult } from '../../lib/admin/action-result';
import { adminGet, adminWrite } from '../../lib/admin/api';
import { validated } from '../../lib/admin/validated';

/**
 * Writes for the search screen — the saved searches.
 *
 * The searches themselves are reads and happen in the server component; the only things a
 * person *changes* here are their own saved shortcuts, and each goes through a server action
 * so the token stays in its `httpOnly` cookie, exactly as everywhere else.
 */

export async function createSavedSearch(input: unknown): Promise<ActionResult<SavedSearch>> {
  return validated(createSavedSearchSchema, input, (body) =>
    adminWrite<SavedSearch>({ path: '/search/saved', method: 'POST', body }),
  );
}

export async function updateSavedSearch(
  id: string,
  version: number,
  input: unknown,
): Promise<ActionResult<SavedSearch>> {
  return validated(updateSavedSearchSchema, input, (body) =>
    adminWrite<SavedSearch>({ path: `/search/saved/${id}`, method: 'PATCH', body, version }),
  );
}

export async function deleteSavedSearch(id: string, version: number): Promise<ActionResult> {
  return adminWrite({ path: `/search/saved/${id}`, method: 'DELETE', version });
}

/**
 * The next keyset page. A read, but through an action rather than a client fetch, because the
 * token lives in an `httpOnly` cookie and there is no browser-side API client in this product
 * — the same shape as `findDuplicates` in the documents feature.
 */
export async function continueSearch(
  params: Readonly<Record<string, string>>,
): Promise<SearchResults> {
  const query = new URLSearchParams(params);
  return adminGet<SearchResults>(`/search?${query.toString()}`);
}
