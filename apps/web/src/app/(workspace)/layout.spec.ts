import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as SessionCheck from '../../lib/session-check';

/**
 * The workspace guard's three answers — RC validation, D-18.
 *
 * It used to redirect to `/login` on any failure of `/auth/me`, leaving the cookie in place for the
 * login page to bounce straight back on. Now a refusal goes through the route that clears the cookie,
 * and an unanswered check renders the unavailable state with no redirect at all.
 */

const { currentSession, checkSession, redirect } = vi.hoisted(() => ({
  currentSession: vi.fn(),
  checkSession: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  }),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({ redirect }));
vi.mock('../../lib/session', () => ({ currentSession }));
vi.mock('../../lib/session-check', async (original) => ({
  ...(await original<typeof SessionCheck>()),
  checkSession,
}));
vi.mock('../../lib/api-client', () => ({ apiFetch: vi.fn().mockResolvedValue({ count: 0 }) }));
vi.mock('../../lib/auth', () => ({ signOut: vi.fn() }));
vi.mock('../../components/workspace-shell', () => ({ WorkspaceShell: () => null }));
vi.mock('../../components/session-unavailable', () => ({ SessionUnavailable: () => null }));

const { default: WorkspaceLayout } = await import('./layout');
const { WorkspaceShell } = await import('../../components/workspace-shell');
const { SessionUnavailable } = await import('../../components/session-unavailable');

async function render(): Promise<{ type: unknown; props: Record<string, unknown> }> {
  return (await WorkspaceLayout({ children: null })) as {
    type: unknown;
    props: Record<string, unknown>;
  };
}

beforeEach(() => {
  currentSession.mockReset();
  checkSession.mockReset();
  redirect.mockClear();
  currentSession.mockResolvedValue({ accessToken: 'token', locale: 'en' });
});

describe('the workspace guard', () => {
  it('sends a refused session to the route that clears it, not straight to /login', async () => {
    checkSession.mockResolvedValue({ state: 'REJECTED' });

    await expect(render()).rejects.toThrow('NEXT_REDIRECT /login/session-ended');
  });

  it('renders the unavailable state, and redirects nowhere, when the API did not answer', async () => {
    checkSession.mockResolvedValue({ state: 'UNAVAILABLE' });

    expect((await render()).type).toBe(SessionUnavailable);
    expect(redirect).not.toHaveBeenCalled();
  });

  it('renders the shell for a session the API confirms', async () => {
    checkSession.mockResolvedValue({
      state: 'VALID',
      identity: {
        userId: 'u-1',
        displayName: 'Somebody',
        email: 'somebody@example.test',
        tenantId: 't-1',
        roles: [],
        permissions: [],
      },
    });

    const element = await render();
    expect(element.type).toBe(WorkspaceShell);
    expect(element.props).toMatchObject({
      displayName: 'Somebody',
      description: 'somebody@example.test',
    });
  });

  it('sends a visitor with no cookie to sign in without asking the API', async () => {
    currentSession.mockResolvedValue(null);

    await expect(render()).rejects.toThrow('NEXT_REDIRECT /login');
    expect(checkSession).not.toHaveBeenCalled();
  });
});
