import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const { checkSession, sessionEndedPath, SESSION_CHECK_TIMEOUT_MS } =
  await import('./session-check');

/**
 * Telling a refused session from an unanswered one — RC validation, D-18.
 *
 * Driven through the real `apiFetch`, with only `fetch` replaced, because the distinction is made on
 * what `apiFetch` turns a response into: a parsed problem document becomes its own code, anything
 * else becomes `INTERNAL`. A test that stubbed `apiFetch` would be asserting its own stub.
 */

const IDENTITY = {
  userId: 'u-1',
  displayName: 'Somebody',
  email: 'somebody@example.test',
  tenantId: 't-1',
  roles: [],
  permissions: [],
};

function problem(status: number, code: string): Response {
  return new Response(
    JSON.stringify({
      type: `https://errors.example.test/${code}`,
      title: code,
      status,
      code,
      detail: 'x',
      correlationId: 'c-1',
    }),
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('checkSession', () => {
  it('is VALID with the identity when the API answers', async () => {
    fetchMock.mockResolvedValue(Response.json(IDENTITY));

    expect(await checkSession('token')).toEqual({ state: 'VALID', identity: IDENTITY });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toMatch(/\/auth\/me$/);
    expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer token');
  });

  it("is REJECTED only on the API's own UNAUTHENTICATED", async () => {
    // Expired, forged, revoked, a disabled account, a stale permission version: one answer.
    fetchMock.mockResolvedValue(problem(401, 'UNAUTHENTICATED'));

    expect(await checkSession('token')).toEqual({ state: 'REJECTED' });
  });

  it.each([
    [
      'a 401 in somebody else’s format — a proxy must not sign anybody out',
      () => new Response('<html>Unauthorized</html>', { status: 401 }),
    ],
    ['a raw 500 (D-14: Redis down under the guard)', () => problem(500, 'INTERNAL')],
    ['503 DEPENDENCY_UNAVAILABLE', () => problem(503, 'DEPENDENCY_UNAVAILABLE')],
    ['a gateway 502 with no problem body', () => new Response('Bad gateway', { status: 502 })],
    ['429 RATE_LIMITED', () => problem(429, 'RATE_LIMITED')],
    ['403 FORBIDDEN — not a verdict on the credential', () => problem(403, 'FORBIDDEN')],
  ])('is UNAVAILABLE on %s', async (_name, response) => {
    fetchMock.mockResolvedValue(response());

    expect(await checkSession('token')).toEqual({ state: 'UNAVAILABLE' });
  });

  it('is UNAVAILABLE when the connection is refused', async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }),
    );

    expect(await checkSession('token')).toEqual({ state: 'UNAVAILABLE' });
  });

  it('bounds the wait, and is UNAVAILABLE when the bound is reached', async () => {
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          // Answers nothing until aborted — a host that accepts the connection and goes silent.
          init?.signal?.addEventListener('abort', () => {
            const reason: unknown = init.signal?.reason;
            reject(reason instanceof Error ? reason : new Error('aborted'));
          });
        }),
    );
    // `AbortSignal.timeout` runs on the platform's own timer, which fake timers do not reach; the
    // bound is asserted as requested and then fired by hand.
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    try {
      const pending = checkSession('token');
      expect(timeout).toHaveBeenCalledWith(SESSION_CHECK_TIMEOUT_MS);
      expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(deadline.signal);
      deadline.abort(new DOMException('The operation timed out.', 'TimeoutError'));
      expect(await pending).toEqual({ state: 'UNAVAILABLE' });
    } finally {
      timeout.mockRestore();
    }
    expect(SESSION_CHECK_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });
});

describe('sessionEndedPath', () => {
  it('carries a same-origin destination and drops anything else', () => {
    expect(sessionEndedPath()).toBe('/login/session-ended');
    expect(sessionEndedPath('/documents')).toBe('/login/session-ended?next=%2Fdocuments');
    expect(sessionEndedPath('//evil.example')).toBe('/login/session-ended');
    expect(sessionEndedPath('/.//evil.example')).toBe('/login/session-ended');
  });
});
