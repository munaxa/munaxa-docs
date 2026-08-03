import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import type { PermissionKey } from '@edms/domain';

import { WorkspaceShell } from '../../components/workspace-shell';
import { apiFetch } from '../../lib/api-client';
import { signOut } from '../../lib/auth';
import { destinationsFor } from '../../lib/navigation';
import { currentSession } from '../../lib/session';

interface MeResponse {
  readonly userId: string | null;
  readonly tenantId: string;
  readonly roles: readonly string[];
  readonly permissions: readonly PermissionKey[];
}

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

  const me = await identify(session.accessToken);
  if (!me) {
    redirect('/login');
  }

  return (
    <WorkspaceShell
      destinations={destinationsFor(me.permissions)}
      displayName={me.userId ?? ''}
      description={me.tenantId}
      signOutAction={signOutAction}
    >
      {children}
    </WorkspaceShell>
  );
}

async function identify(accessToken: string): Promise<MeResponse | null> {
  try {
    return await apiFetch<MeResponse>({ path: '/auth/me', accessToken });
  } catch {
    // Rejected, expired, or the API unreachable. All three mean this request cannot be served
    // as an authenticated one, and none of them should render a shell.
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
