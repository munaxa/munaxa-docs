import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as SessionCheck from '../../../../lib/session-check';

/**
 * The route that clears a refused session — RC validation, D-18.
 *
 * What matters is which of the three answers clears the cookie. Only the API's own rejection may:
 * this is a `GET` any page can point an image at, and it is safe as one only because a caller cannot
 * make it end a session the API still honours.
 */

const { checkSession } = vi.hoisted(() => ({ checkSession: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('../../../../lib/session-check', async (original) => ({
  ...(await original<typeof SessionCheck>()),
  checkSession,
}));

const { GET } = await import('./route');

function request(query: string, token?: string): NextRequest {
  return new NextRequest(`http://web.test/login/session-ended${query}`, {
    headers: token ? { cookie: `edms_at=${token}; edms_rt=refresh` } : {},
  });
}

/** The `Set-Cookie` headers that expire a cookie, by name. */
function expired(response: Response): string[] {
  return response.headers
    .getSetCookie()
    .filter((line) => /expires=Thu, 01 Jan 1970/i.test(line))
    .map((line) => line.split('=')[0] ?? '');
}

beforeEach(() => {
  checkSession.mockReset();
});

describe('GET /login/session-ended', () => {
  it('clears both cookies and sends the browser to sign in when the API refused the session', async () => {
    checkSession.mockResolvedValue({ state: 'REJECTED' });

    const response = await GET(request('?next=%2Fdocuments', 'stale'));

    expect(checkSession).toHaveBeenCalledWith('stale');
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/login?next=%2Fdocuments&ended=1');
    expect(expired(response).sort()).toEqual(['edms_at', 'edms_rt']);
    // Same attributes the session was stored with, or the browser keeps the original.
    for (const line of response.headers.getSetCookie()) {
      expect(line).toMatch(/Path=\//);
      expect(line).toMatch(/HttpOnly/i);
    }
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('clears nothing when the API did not answer', async () => {
    checkSession.mockResolvedValue({ state: 'UNAVAILABLE' });

    const response = await GET(request('?next=%2Fdocuments', 'maybe-valid'));

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/login?next=%2Fdocuments');
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('clears nothing and sends a valid session on — a forged link ends nobody’s session', async () => {
    checkSession.mockResolvedValue({ state: 'VALID', identity: {} });

    const response = await GET(request('?next=%2Fdocuments', 'valid'));

    expect(response.headers.get('location')).toBe('/documents');
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('does not ask the API when there is no cookie', async () => {
    const response = await GET(request(''));

    expect(checkSession).not.toHaveBeenCalled();
    expect(response.headers.get('location')).toBe('/login');
  });

  it.each(['https://evil.example', '//evil.example', '/\\evil.example'])(
    'never sends anybody off the origin (%s)',
    async (next) => {
      checkSession.mockResolvedValue({ state: 'VALID', identity: {} });

      const response = await GET(request(`?next=${encodeURIComponent(next)}`, 'valid'));

      expect(response.headers.get('location')).toBe('/');
    },
  );
});
