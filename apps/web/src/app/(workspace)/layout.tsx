import type { Route } from 'next';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { SessionUnavailable } from '../../components/session-unavailable';
import { WorkspaceShell } from '../../components/workspace-shell';
import { apiFetch } from '../../lib/api-client';
import { signOut } from '../../lib/auth';
import { destinationsFor } from '../../lib/navigation';
import { currentSession } from '../../lib/session';
import { SESSION_CHECK_TIMEOUT_MS, checkSession, sessionEndedPath } from '../../lib/session-check';

/**
 * The authenticated shell.
 *
 * The guard is here rather than in a client component because a client-side redirect renders
 * the workspace first and navigates away after — which means the markup existed, however
 * briefly. `middleware.ts` performs the same check at the edge; this is the layer that cannot
 * be skipped by a direct request to a nested route.
 *
 * A cookie is not a session. The token is verified by asking the API who the caller is, so one
 * that survived a revoked session, a rotated signing key or a disabled account lands on the
 * login screen rather than inside the workspace. That call is also where the navigation comes
 * from: permissions are the server's answer, never the client's.
 *
 * An API that did not answer is not such a verdict (D-18, and `lib/session-check.ts`): the shell is
 * withheld, the session kept, and the page says the service is unavailable.
 */
export default async function WorkspaceLayout({
  children,
}: {
  children: ReactNode;
}): Promise<ReactNode> {
  const session = await currentSession();
  if (!session) {
    redirect('/login');
  }

  const check = await checkSession(session.accessToken);
  if (check.state === 'REJECTED') {
    // Through the route that can clear the cookie. Straight to `/login` with the cookie in place was
    // one half of D-18's loop.
    redirect(sessionEndedPath() as Route);
  }
  if (check.state === 'UNAVAILABLE') {
    // The other half: an API that did not answer is not a signed-out user. The page ends here.
    return <SessionUnavailable />;
  }
  const me = check.identity;

  return (
    <WorkspaceShell
      destinations={destinationsFor(me.permissions)}
      /*
       * The person, then how to reach them — Phase 7.9.
       *
       * This was `displayName={me.userId}` over `description={me.tenantId}`, so the account chip
       * showed two UUIDs and an avatar initial taken from the first character of one of them.
       * `/auth/me` now carries the name and the address the `User` record has held since Phase 1,
       * so the chip shows what a person recognises. The identifier remains the fallback when the
       * token stands for an API client rather than a human — nothing is derived from the UUID.
       */
      displayName={me.displayName ?? me.userId ?? ''}
      description={me.email ?? me.tenantId}
      unreadNotifications={await unreadNotifications(session.accessToken)}
      signOutAction={signOutAction}
    >
      {children}
    </WorkspaceShell>
  );
}

/**
 * The top bar's unread count — Phase 7.5.
 *
 * This is the one place in the product that adds a request to *every* authenticated page, so the
 * endpoint matters. `GET /notifications/unread-count` is a single query and was built for exactly
 * this: its own comment says the question "is asked wherever a badge is — every page load — and
 * answering it by fetching a page of notifications would make a count cost a paginated read".
 *
 * The obvious alternative was rejected on measurement. `GET /dashboard` carries `pending`,
 * `overdue` and `unreadNotifications` together, which would have fed the rail badges the reference
 * shows too — but it costs roughly thirteen database round-trips across eight modules, and paying
 * that on every navigation to decorate a sidebar is the fan-out regression Phase 7.1C spent a phase
 * removing. The rail badges wait for a cheap endpoint; see the Phase 7.5 audit §7.6.
 *
 * A failure yields `null`, not `0`. Zero is an answer — "you are up to date" — and asserting it
 * because the API was unreachable would tell somebody there is nothing waiting for them when
 * nobody knows. `null` renders the bell with no badge.
 */
async function unreadNotifications(accessToken: string): Promise<number | null> {
  try {
    const { count } = await apiFetch<{ count: number }>({
      path: '/notifications/unread-count',
      accessToken,
      signal: AbortSignal.timeout(SESSION_CHECK_TIMEOUT_MS),
    });
    return count;
  } catch {
    return null;
  }
}

/**
 * Signing out is a mutation, so it is a server action rather than a link: a `GET` that ends a
 * session can be triggered by any page that embeds an image pointing at it.
 */
async function signOutAction(): Promise<void> {
  'use server';
  await signOut();
  redirect('/login');
}
