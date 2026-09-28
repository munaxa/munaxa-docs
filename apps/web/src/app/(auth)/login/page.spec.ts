import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What the sign-in page does with a session cookie it was handed — RC validation, D-18.
 *
 * It used to redirect on the cookie's presence alone, which was one half of a redirect loop: the
 * workspace sent a refused or uncheckable cookie here, and this sent it straight back. Asserted as
 * the redirect (or its absence) and the prop the form receives, because both halves of the defect
 * were a redirect issued where none should be.
 */

const { currentSession, checkSession, redirect } = vi.hoisted(() => ({
  currentSession: vi.fn(),
  checkSession: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  }),
}));

vi.mock('../../../lib/session', () => ({ currentSession }));
vi.mock('../../../lib/session-check', () => ({ checkSession }));
vi.mock('./login-form', () => ({ LoginForm: (props: Record<string, unknown>) => props }));
vi.mock('next/navigation', () => ({ redirect }));

const { default: LoginPage } = await import('./page');

async function render(query: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const element = (await LoginPage({ searchParams: Promise.resolve(query) })) as {
    props: Record<string, unknown>;
  };
  return element.props;
}

beforeEach(() => {
  currentSession.mockReset();
  checkSession.mockReset();
  redirect.mockClear();
});

describe('the sign-in page', () => {
  it('renders the form without asking the API when there is no cookie', async () => {
    currentSession.mockResolvedValue(null);

    expect(await render()).toMatchObject({ next: '/', notice: null });
    expect(checkSession).not.toHaveBeenCalled();
  });

  it('sends a session the API confirms on to where it was going', async () => {
    currentSession.mockResolvedValue({ accessToken: 'valid', locale: 'en' });
    checkSession.mockResolvedValue({ state: 'VALID', identity: {} });

    await expect(render({ next: '/documents' })).rejects.toThrow('NEXT_REDIRECT /documents');
  });

  it.each([
    '//evil.example',
    '/\\evil.example',
    '\\\\evil.example',
    'https://evil.example',
    'http://evil.example',
    '/.//evil.example',
  ])('sends a confirmed session home, not to %j (D-19)', async (next) => {
    currentSession.mockResolvedValue({ accessToken: 'valid', locale: 'en' });
    checkSession.mockResolvedValue({ state: 'VALID', identity: {} });

    await expect(render({ next })).rejects.toThrow(/^NEXT_REDIRECT \/$/);
  });

  it('hands the form the safe destination, never the attacker’s (D-19)', async () => {
    currentSession.mockResolvedValue(null);

    expect(await render({ next: '/\\evil.example' })).toMatchObject({ next: '/' });
    expect(await render({ next: '/documents?page=2' })).toMatchObject({
      next: '/documents?page=2',
    });
  });

  it('stays, and renders the form, when the API refused the cookie', async () => {
    currentSession.mockResolvedValue({ accessToken: 'stale', locale: 'en' });
    checkSession.mockResolvedValue({ state: 'REJECTED' });

    expect(await render({ next: '/documents' })).toMatchObject({
      next: '/documents',
      notice: null,
    });
    expect(redirect).not.toHaveBeenCalled();
    expect(checkSession).toHaveBeenCalledTimes(1);
  });

  it('stays, and says why, when the API did not answer', async () => {
    currentSession.mockResolvedValue({ accessToken: 'maybe-valid', locale: 'en' });
    checkSession.mockResolvedValue({ state: 'UNAVAILABLE' });

    expect(await render()).toMatchObject({ notice: 'SESSION_UNVERIFIED' });
    expect(redirect).not.toHaveBeenCalled();
    // Once per render: the page does not poll an API that is down.
    expect(checkSession).toHaveBeenCalledTimes(1);
  });

  it('says the session ended when sent here by the route that ended it', async () => {
    currentSession.mockResolvedValue(null);

    expect(await render({ ended: '1' })).toMatchObject({ notice: 'SESSION_ENDED' });
  });
});
