import 'server-only';

import type { Route } from 'next';
import { redirect } from 'next/navigation';
import { cache } from 'react';

import type { Collection } from '@edms/contracts';
import type { PermissionKey } from '@edms/domain';

import { apiFetch } from '../api-client';
import { currentSession } from '../session';
import { SESSION_CHECK_TIMEOUT_MS, isRejection, sessionEndedPath } from '../session-check';
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
 * page instead of signing in. The redirect goes through `/login/session-ended`, which clears the
 * refused cookie (D-18); straight to `/login` left it in place.
 */

/**
 * How long a server render waits for one read — RC validation, D-18.
 *
 * Next renders a layout and its page in parallel, so the workspace layout's own bounded check
 * (`SESSION_CHECK_TIMEOUT_MS`) is not enough on its own: against an API that accepts connections and
 * never answers, the page's reads kept the response open until the platform's five-minute header
 * timeout, and the unavailable state the layout had already chosen never reached the browser. Every
 * read here is a page's worth — a list page, a report page, a picker — and answers in milliseconds
 * when the API is healthy; anything slow in this product (exports, bulk operations, rebuilds) is
 * queued and polled, not awaited in a render.
 *
 * Reads only. A write is not bounded here: abandoning one mid-flight leaves its outcome unknown to
 * the person who asked for it, and every write is a deliberate act with its own response.
 */
export const SERVER_READ_TIMEOUT_MS = 30_000;

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
      // The same question the workspace layout asks, so the same bound.
      signal: AbortSignal.timeout(SESSION_CHECK_TIMEOUT_MS),
    });
    return me.permissions;
  } catch (error) {
    if (isRejection(error)) {
      redirect(sessionEndedPath() as Route);
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
    signal: AbortSignal.timeout(SERVER_READ_TIMEOUT_MS),
  });
}

/** One resource, or whatever a screen needs that is not a page — the permission catalogue, settings. */
export async function adminGet<TResult>(path: string): Promise<TResult> {
  return apiFetch<TResult>({
    path,
    accessToken: await token(),
    signal: AbortSignal.timeout(SERVER_READ_TIMEOUT_MS),
  });
}

/**
 * A read whose failure is a *result* rather than an exception — Phase 12's addition.
 *
 * `adminGet` throws, which is right for a server component: a page that cannot load its data has
 * nothing to render, and the error boundary is the honest response. It is wrong for a read a
 * *client* asks for mid-interaction — opening a template editor — where the screen is already
 * rendered and the right answer is a message beside the button rather than an unmounted page.
 *
 * The same shape as `adminWrite`, for the same reason: a server action returns to a component
 * that has to decide what to show, and an exception crossing that boundary is a discarded screen.
 */
export async function adminRead<TResult>(path: string): Promise<ActionResult<TResult>> {
  try {
    return succeeded(
      await apiFetch<TResult>({
        path,
        accessToken: await token(),
        signal: AbortSignal.timeout(SERVER_READ_TIMEOUT_MS),
      }),
    );
  } catch (error) {
    if (isRejection(error)) {
      redirect(sessionEndedPath() as Route);
    }
    return toActionResult<TResult>(error);
  }
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
  /**
   * Anything the endpoint narrows by — today only `isActive` on the operational document types.
   *
   * A picker for a *new* document offers active types; the properties form has to resolve the type
   * a document already carries, which may since have been retired. One parameter rather than two
   * functions, because the difference is a filter and not a different read.
   */
  filters: Readonly<Record<string, string>> = {},
): Promise<Collection<TItem>> {
  return adminList<TItem>(path, {
    page: 1,
    pageSize: 100,
    sortBy,
    sortDirection: 'asc',
    search: '',
    deleted: 'live',
    filters,
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
    if (isRejection(error)) {
      redirect(sessionEndedPath() as Route);
    }
    return toActionResult<TResult>(error);
  }
}
