import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * WEB-1: web sign-out must reach the API with the session's tenant.
 *
 * The API reads no tenant from the host, so a sign-out that named none was refused — and the refusal
 * was swallowed, leaving the refresh family live for a copy of the token taken before sign-out. What
 * this pins is the web half: the tenant is kept at sign-in beside the refresh token, sent at
 * sign-out, and cleared with the other session cookies. The browser suite proves the end-to-end
 * result against a real API (`sign-out-revocation.e2e.spec.ts`).
 */

interface CookieOptions {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
  path?: string;
  expires?: Date;
}

const { jar, apiFetch } = vi.hoisted(() => {
  const values = new Map<string, { value: string; options: CookieOptions }>();
  const store = {
    get: (name: string) =>
      values.has(name) ? { name, value: values.get(name)?.value ?? '' } : undefined,
    set: (name: string, value: string, options: CookieOptions) => {
      values.set(name, { value, options });
    },
    delete: (name: string) => {
      values.delete(name);
    },
  };
  return { jar: { values, store }, apiFetch: vi.fn() };
});

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ cookies: () => Promise.resolve(jar.store) }));
vi.mock('./api-client', () => ({ apiFetch }));
vi.mock('./client-address', () => ({ clientAddress: () => Promise.resolve(undefined) }));

const { signIn, signOut } = await import('./auth');

const ACCESS_EXPIRES = '2026-10-01T00:15:00.000Z';
const REFRESH_EXPIRES = '2026-10-31T00:00:00.000Z';

function issued() {
  return {
    accessToken: 'access-token',
    accessTokenExpiresAt: ACCESS_EXPIRES,
    refreshToken: 'refresh-token',
    refreshTokenExpiresAt: REFRESH_EXPIRES,
    user: {
      id: 'user',
      email: 'ada@acme.test',
      displayName: 'Ada',
      roles: [],
      permissions: [],
      mfaEnrolled: false,
    },
  };
}

beforeEach(() => {
  jar.values.clear();
  apiFetch.mockReset();
});

describe('web sign-in', () => {
  it('stores the tenant beside the refresh token, with the same attributes and expiry', async () => {
    apiFetch.mockResolvedValueOnce(issued());

    expect(await signIn({ email: 'ada@acme.test', password: 'pw', tenant: 'acme' })).toEqual({
      ok: true,
    });

    const tenant = jar.values.get('edms_tenant');
    const refresh = jar.values.get('edms_rt');
    expect(tenant?.value).toBe('acme');
    expect(tenant?.options).toEqual(refresh?.options);
    expect(tenant?.options.httpOnly).toBe(true);
    expect(tenant?.options.sameSite).toBe('lax');
    expect(tenant?.options.path).toBe('/');
    expect(tenant?.options.expires?.toISOString()).toBe(REFRESH_EXPIRES);
  });

  it('stores no tenant cookie when the sign-in is refused', async () => {
    const { DomainError, ErrorCode } = await import('@edms/domain');
    apiFetch.mockRejectedValueOnce(new DomainError(ErrorCode.UNAUTHENTICATED, 'no'));

    expect(await signIn({ email: 'ada@acme.test', password: 'pw', tenant: 'acme' })).toEqual({
      ok: false,
      reason: 'REJECTED',
    });
    expect(jar.values.has('edms_tenant')).toBe(false);
  });
});

describe('web sign-out', () => {
  it('sends the refresh token and its tenant to the logout API', async () => {
    apiFetch.mockResolvedValueOnce(issued());
    await signIn({ email: 'ada@acme.test', password: 'pw', tenant: 'acme' });
    apiFetch.mockReset();
    apiFetch.mockResolvedValueOnce(undefined);

    await signOut();

    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith({
      path: '/auth/logout',
      method: 'POST',
      body: { refreshToken: 'refresh-token', tenant: 'acme' },
    });
  });

  it('clears the tenant cookie together with the authentication cookies', async () => {
    // Seeded directly, so the assertion does not depend on sign-in having written it.
    for (const [name, value] of [
      ['edms_at', 'access-token'],
      ['edms_rt', 'refresh-token'],
      ['edms_tenant', 'acme'],
    ] as const) {
      jar.store.set(name, value, { httpOnly: true, sameSite: 'lax', path: '/' });
    }
    apiFetch.mockResolvedValueOnce(undefined);

    await signOut();

    expect([...jar.values.keys()]).toEqual([]);
  });

  it('clears every session cookie even when the API refuses or cannot be reached', async () => {
    apiFetch.mockResolvedValueOnce(issued());
    await signIn({ email: 'ada@acme.test', password: 'pw', tenant: 'acme' });
    apiFetch.mockRejectedValueOnce(new Error('unreachable'));

    await signOut();

    expect([...jar.values.keys()]).toEqual([]);
  });
});
