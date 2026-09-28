import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DomainError, ErrorCode } from '@edms/domain';

/**
 * The server-side API helpers every page reads through — RC validation, D-18.
 *
 * Two properties: a refused session goes through the route that clears its cookie, and a server
 * render's reads are bounded, so an API that accepts connections and never answers cannot hold a
 * response open past the state the layout already chose. Writes are deliberately not bounded.
 */

const { apiFetch, redirect } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  }),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({ redirect }));
vi.mock('../api-client', () => ({ apiFetch }));
vi.mock('../session', () => ({
  currentSession: () => Promise.resolve({ accessToken: 'token', locale: 'en' }),
}));

const { adminGet, adminList, adminRead, adminWrite, currentPermissions } = await import('./api');

const LIST_STATE = {
  page: 1,
  pageSize: 20,
  sortBy: 'name',
  sortDirection: 'asc',
  search: '',
  deleted: 'live',
  filters: {},
} as const;

function lastSignal(): unknown {
  return (apiFetch.mock.calls.at(-1)?.[0] as { signal?: unknown } | undefined)?.signal;
}

beforeEach(() => {
  apiFetch.mockReset();
  redirect.mockClear();
  apiFetch.mockResolvedValue({ data: [], meta: {}, permissions: [] });
});

describe('reads made during a server render', () => {
  it.each([
    ['adminGet', () => adminGet('/reports')],
    ['adminList', () => adminList('/admin/users', LIST_STATE)],
    ['adminRead', () => adminRead('/admin/folders/f-1')],
    ['currentPermissions', () => currentPermissions()],
  ])('%s is bounded', async (_name, read) => {
    await read();
    expect(lastSignal()).toBeInstanceOf(AbortSignal);
  });

  it('a write is not', async () => {
    await adminWrite({ path: '/admin/users', method: 'POST', body: {} });
    expect(lastSignal()).toBeUndefined();
  });
});

describe('a refused session', () => {
  it.each([
    ['adminRead', () => adminRead('/admin/folders/f-1')],
    ['adminWrite', () => adminWrite({ path: '/admin/users', method: 'POST', body: {} })],
  ])('%s sends it to the route that clears the cookie', async (_name, call) => {
    apiFetch.mockRejectedValue(new DomainError(ErrorCode.UNAUTHENTICATED, 'no'));

    await expect(call()).rejects.toThrow('NEXT_REDIRECT /login/session-ended');
  });

  it('is not what an unanswered read is: that is the result, not a redirect', async () => {
    apiFetch.mockRejectedValue(new DomainError(ErrorCode.INTERNAL, 'unreachable'));

    const result = await adminRead('/admin/folders/f-1');
    expect(result.ok).toBe(false);
    expect(redirect).not.toHaveBeenCalled();
  });
});
