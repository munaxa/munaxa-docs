import 'server-only';

import { redirect } from 'next/navigation';
import { cache } from 'react';

import type { Collection } from '@edms/contracts';
import { DomainError, ErrorCode, type PermissionKey } from '@edms/domain';

import { apiFetch } from '../api-client';
import { currentSession } from '../session';
import { type ActionResult, succeeded, toActionResult } from './action-result';
import { type ListState, listQueryString } from './list-state';

/**
 * The administration API, called from the server.
 *
 * Every call in Administration goes through here, and it is server-side for one reason: the access
 * token is in an `httpOnly` cookie and never reaches client JavaScript
 * (`docs/architecture/17-security-architecture.md` §2). Lists are fetched by server components,
 * writes by server actions. There is no browser-side API client, and adding one would mean handing
 * the token to a script.
 *
 * The token is also why an expired session redirects rather than renders: a list that answered
 * `UNAUTHENTICATED` has nothing to show, and showing the error would leave somebody re-reading a
 * page instead of signing in.
 */

async function token(): Promise<string> {
  const session = await currentSession();
  if (session === null) {
    redirect('/login');
  }
  return session.accessToken;
}

/**
 * The permissions the API says this caller holds.
 *
 * Memoised for the request. The section navigation and the page inside it both need them, and a
 * layout and its child are two renders of one request — two calls to `/auth/me` for one page load
 * would also open the window where they disagree.
 */
export const currentPermissions = cache(async (): Promise<readonly PermissionKey[]> => {
  try {
    const me = await apiFetch<{ readonly permissions: readonly PermissionKey[] }>({
      path: '/auth/me',
      accessToken: await token(),
    });
    return me.permissions;
  } catch (error) {
    if (error instanceof DomainError && error.code === ErrorCode.UNAUTHENTICATED) {
      redirect('/login');
    }
    // Anything else — the API down, a gateway in the way — is not a permission decision. Reporting
    // no permissions would render every screen as an empty shell, which reads as "you lost access".
    throw error;
  }
});

/**
 * Whether this caller may administer an area, and what else they hold.
 *
 * Returned rather than enforced by a redirect, because the page has something honest to render
 * either way: the screen when it is granted, and a sentence saying why not when it is not. A refused
 * administration page is not a missing one, and answering it with a 404 would send somebody looking
 * for a broken link.
 *
 * This is a courtesy in the same sense the navigation is: every endpoint behind these screens
 * carries its own guard, and this check being wrong would hide a screen, never open one.
 */
export async function adminAccess(permission: PermissionKey): Promise<{
  readonly granted: boolean;
  readonly permissions: readonly PermissionKey[];
}> {
  const permissions = await currentPermissions();
  return { granted: permissions.includes(permission), permissions };
}

/** A page of an administered resource, for the state the URL described. */
export async function adminList<TItem>(path: string, state: ListState): Promise<Collection<TItem>> {
  return apiFetch<Collection<TItem>>({
    path: `${path}${listQueryString(state)}`,
    accessToken: await token(),
  });
}

/** One resource, or whatever a screen needs that is not a page — the permission catalogue, settings. */
export async function adminGet<TResult>(path: string): Promise<TResult> {
  return apiFetch<TResult>({ path, accessToken: await token() });
}

/**
 * A list fetched to fill a picker.
 *
 * Bounded at the API's maximum page rather than "all of them", because there is no such request.
 * A tenant with more nodes than one page holds needs a searching picker, and the honest thing is
 * for this to be visibly a page — `hasMore` is on the meta, and the callers that matter show it.
 */
export async function adminOptions<TItem>(
  path: string,
  sortBy: string,
): Promise<Collection<TItem>> {
  return adminList<TItem>(path, {
    page: 1,
    pageSize: 100,
    sortBy,
    sortDirection: 'asc',
    search: '',
    deleted: 'live',
    filters: {},
  });
}

export interface WriteRequest {
  readonly path: string;
  readonly method: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  readonly body?: unknown;
  /**
   * The record version being changed, sent as `If-Match`.
   *
   * Required by every write to an existing record. Omitting it is not "no opinion" — the API
   * refuses a versioned write without it, which is what stops two administrators editing the same
   * role from silently overwriting each other (`15-api-architecture.md` §6).
   */
  readonly version?: number;
}

/**
 * Performs a write and reports the outcome rather than throwing.
 *
 * `TENANT_READ_ONLY`, `VERSION_CONFLICT` and `DUPLICATE` are all *expected* answers to a
 * well-formed request, and each has a sentence in the catalogue. Turning them into results rather
 * than exceptions is what lets a form show the sentence next to the field instead of replacing the
 * screen with an error boundary.
 */
export async function adminWrite<TResult = void>(
  request: WriteRequest,
): Promise<ActionResult<TResult>> {
  try {
    const result = await apiFetch<TResult>({
      path: request.path,
      method: request.method,
      accessToken: await token(),
      ...(request.body !== undefined && { body: request.body }),
      ...(request.version !== undefined && { ifMatch: request.version }),
    });
    return succeeded(result);
  } catch (error) {
    if (error instanceof DomainError && error.code === ErrorCode.UNAUTHENTICATED) {
      redirect('/login');
    }
    return toActionResult<TResult>(error);
  }
}
