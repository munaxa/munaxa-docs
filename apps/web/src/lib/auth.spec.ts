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
    set: (name: string, value: string, options: CookieOptions & { maxAge?: number }) => {
      if (options.maxAge === 0) values.delete(name);
      else values.set(name, { value, options });
    },
    delete: (name: string | { name: string }) => {
      values.delete(typeof name === 'string' ? name : name.name);
    },
  };
  return { jar: { values, store }, apiFetch: vi.fn() };
});

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ cookies: () => Promise.resolve(jar.store) }));
vi.mock('./api-client', () => ({ apiFetch }));
vi.mock('./client-address', () => ({ clientAddress: () => Promise.resolve(undefined) }));

const { signIn, signOut, startFederatedSignIn, completeFederatedSignIn, FEDERATION_COOKIE } =
  await import('./auth');

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

describe('sign-in through Munaxa Identity', () => {
  const AUTHORIZE =
    'https://id.example/api/auth/oidc/authorize?client_id=docs-acme&state=the-state&nonce=n';

  const start = async () => {
    apiFetch.mockResolvedValueOnce({ federated: true, authorizationUrl: AUTHORIZE });
    return startFederatedSignIn({ email: 'ada@acme.test', tenant: 'acme', next: '/documents' });
  };

  it('returns the authorization URL and binds the state to this browser without storing it', async () => {
    expect(await start()).toEqual({ ok: true, authorizationUrl: AUTHORIZE });
    expect(apiFetch).toHaveBeenCalledWith({
      path: '/auth/federation?email=ada%40acme.test&tenant=acme',
    });
    const binding = jar.values.get(FEDERATION_COOKIE);
    expect(binding?.options).toMatchObject({
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
    });
    expect(binding?.value).not.toContain('the-state');
    expect(JSON.parse(binding?.value ?? '{}')).toMatchObject({
      tenant: 'acme',
      next: '/documents',
    });
  });

  it('says when the organisation does not offer it, and writes no cookie', async () => {
    apiFetch.mockResolvedValueOnce({ federated: false, authorizationUrl: null });
    expect(
      await startFederatedSignIn({ email: 'ada@acme.test', tenant: 'acme', next: '/' }),
    ).toEqual({ ok: false, reason: 'NOT_OFFERED' });
    expect(jar.values.has(FEDERATION_COOKIE)).toBe(false);
  });

  it('completes for the browser that started, stores the session and spends the binding', async () => {
    await start();
    apiFetch.mockResolvedValueOnce(issued());

    expect(await completeFederatedSignIn({ code: 'the-code', state: 'the-state' })).toEqual({
      ok: true,
      next: '/documents',
    });
    expect(apiFetch).toHaveBeenLastCalledWith({
      path: '/auth/federation/callback',
      method: 'POST',
      body: { code: 'the-code', state: 'the-state', tenant: 'acme' },
    });
    expect(jar.values.get('edms_rt')?.value).toBe('refresh-token');
    expect(jar.values.get('edms_tenant')?.value).toBe('acme');
    expect(jar.values.has(FEDERATION_COOKIE)).toBe(false);
  });

  it('refuses a callback whose state this browser did not start (login CSRF)', async () => {
    await start();
    apiFetch.mockReset();

    expect(await completeFederatedSignIn({ code: 'the-code', state: 'attacker-state' })).toEqual({
      ok: false,
      reason: 'REJECTED',
    });
    expect(apiFetch).not.toHaveBeenCalled();
    expect(jar.values.has(FEDERATION_COOKIE)).toBe(false);
    expect(jar.values.has('edms_rt')).toBe(false);
  });

  it('refuses a callback with no binding cookie or no code', async () => {
    expect(await completeFederatedSignIn({ code: 'the-code', state: 'the-state' })).toEqual({
      ok: false,
      reason: 'REJECTED',
    });
    await start();
    apiFetch.mockReset();
    expect(await completeFederatedSignIn({ code: null, state: 'the-state' })).toEqual({
      ok: false,
      reason: 'REJECTED',
    });
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
