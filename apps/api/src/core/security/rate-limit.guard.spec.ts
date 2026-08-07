import { describe, expect, it, vi } from 'vitest';
import type { CachePort } from '@munaxa/interfaces';

import { TooManyRequestsError } from '../errors/application-errors';
import type { Logger } from '../observability/logger';
import type { Metrics } from '../observability/metrics';
import { runWithContext, type RequestContext } from '../tenancy/tenant-context';
import { RateLimitGuard } from './rate-limit.guard';

/**
 * The control this phase turned from a paragraph into a limit.
 *
 * `RATE_LIMIT_RULES` had described this product's limits since Phase 0.5 and nothing read them —
 * no guard, no interceptor, `@nestjs/throttler` unimported. These tests exist so that can never
 * quietly become true again: they assert refusal, not configuration.
 *
 * The cache is a real in-memory `CachePort` rather than a mock, because a counter that is asserted
 * against a stub proves the guard called something, not that anything was counted.
 */

function memoryCache(): CachePort & { readonly store: Map<string, unknown> } {
  const store = new Map<string, { value: unknown; expiresAt: number }>();
  const live = (key: string) => {
    const entry = store.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= Date.now()) {
      store.delete(key);
      return undefined;
    }
    return entry;
  };
  const cache: CachePort = {
    get: <T>(key: string) => Promise.resolve((live(key)?.value as T) ?? undefined),
    set: (key, value, options) => {
      store.set(key, { value, expiresAt: Date.now() + (options?.ttl ?? 60_000) });
      return Promise.resolve();
    },
    delete: (key) => Promise.resolve(store.delete(key)),
    setIfAbsent: (key, value, options) => {
      if (live(key) !== undefined) return Promise.resolve(false);
      store.set(key, { value, expiresAt: Date.now() + (options?.ttl ?? 60_000) });
      return Promise.resolve(true);
    },
    compareAndSet: (key, expected, value, options) => {
      if (live(key)?.value !== expected) return Promise.resolve(false);
      store.set(key, { value, expiresAt: Date.now() + (options?.ttl ?? 60_000) });
      return Promise.resolve(true);
    },
    increment: (key, by = 1, options) => {
      const current = (live(key)?.value as number) ?? 0;
      const next = current + by;
      store.set(key, { value: next, expiresAt: Date.now() + (options?.ttl ?? 60_000) });
      return Promise.resolve(next);
    },
  } as CachePort;
  return Object.assign(cache, { store: store });
}

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const metrics: Metrics = { increment: vi.fn(), observe: vi.fn() } as unknown as Metrics;

function guardWith(cache: CachePort): RateLimitGuard {
  return new RateLimitGuard(cache, silentLogger as unknown as Logger, metrics);
}

type GuardContext = Parameters<RateLimitGuard['canActivate']>[0];

/**
 * An execution context, and the headers the guard writes into it.
 *
 * The headers come back beside the context rather than being dug out of it afterwards: reading
 * them back through `switchToHttp()` means casting away the framework's types, and a cast in a
 * test is a place a real mistake can hide.
 */
function contextOf(request: {
  method: string;
  path: string;
  ip?: string;
  hostname?: string;
}): { context: GuardContext; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  const response = {
    setHeader: (name: string, value: string) => {
      headers[name.toLowerCase()] = String(value);
    },
  };
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({ hostname: 'acme.docs.test', ip: '198.51.100.4', ...request }),
      getResponse: () => response,
    }),
  } as unknown as GuardContext;
  return { context, headers };
}

/** Just the context, for the cases that do not read headers back. */
const ctx = (request: Parameters<typeof contextOf>[0]): GuardContext => contextOf(request).context;

const tenantContext: RequestContext = {
  tenantId: '019489f0-0000-7000-8000-0000000000a1' as RequestContext['tenantId'],
  userId: '0199bbbb-0000-7000-8000-000000000002' as RequestContext['userId'],
  roles: [],
  permissions: [],
  sessionId: null,
  correlationId: 'corr-1',
  permissionVersion: 0,
  locale: 'en',
};

describe('the login limit', () => {
  it('refuses the eleventh attempt from one address', async () => {
    // Ten in five minutes, per `RATE_LIMIT_RULES`. The eleventh is credential stuffing's first
    // wasted request rather than its first free one.
    const guard = guardWith(memoryCache());
    const login = { method: 'POST', path: '/api/v1/auth/login' };

    for (let attempt = 1; attempt <= 10; attempt++) {
      await expect(guard.canActivate(ctx(login))).resolves.toBe(true);
    }

    await expect(guard.canActivate(ctx(login))).rejects.toBeInstanceOf(TooManyRequestsError);
  });

  it('applies to an anonymous request, which is the only kind a login is', async () => {
    // The per-user rule cannot fire without a session, and must not silently become a global one.
    // The per-IP rule is what carries this surface, and it has to work with no context at all.
    const guard = guardWith(memoryCache());
    const login = { method: 'POST', path: '/api/v1/auth/login' };
    for (let attempt = 1; attempt <= 10; attempt++) await guard.canActivate(ctx(login));

    await expect(guard.canActivate(ctx(login))).rejects.toThrow(/Too many requests/);
  });

  it('counts one address separately from another', async () => {
    const guard = guardWith(memoryCache());
    const path = '/api/v1/auth/login';
    for (let attempt = 1; attempt <= 10; attempt++) {
      await guard.canActivate(ctx({ method: 'POST', path, ip: '198.51.100.4' }));
    }

    await expect(
      guard.canActivate(ctx({ method: 'POST', path, ip: '203.0.113.9' })),
    ).resolves.toBe(true);
  });

  it("keeps one tenant's failures out of another tenant's budget", async () => {
    // The host label is the key namespace, which is what the sign-in path already uses to select
    // a directory. Without it, one noisy customer would lock everybody out of sign-in.
    const guard = guardWith(memoryCache());
    const path = '/api/v1/auth/login';
    for (let attempt = 1; attempt <= 10; attempt++) {
      await guard.canActivate(ctx({ method: 'POST', path, hostname: 'acme.docs.test' }));
    }

    await expect(
      guard.canActivate(ctx({ method: 'POST', path, hostname: 'rival.docs.test' })),
    ).resolves.toBe(true);
  });
});

describe('what every response carries', () => {
  it('reports the remaining budget on an allowed request', async () => {
    const guard = guardWith(memoryCache());
    const { context, headers } = contextOf({ method: 'GET', path: '/api/v1/documents' });

    await guard.canActivate(context);

    expect(headers['ratelimit-limit']).toBeDefined();
    expect(headers['ratelimit-remaining']).toBeDefined();
    expect(headers['retry-after']).toBeUndefined();
  });

  it('sets Retry-After on the refusal, and carries the same number on the error', async () => {
    const guard = guardWith(memoryCache());
    const login = { method: 'POST', path: '/api/v1/auth/login' };
    for (let attempt = 1; attempt <= 10; attempt++) await guard.canActivate(ctx(login));

    const { context, headers } = contextOf(login);
    const error = await guard.canActivate(context).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TooManyRequestsError);
    expect((error as TooManyRequestsError).retryAfterSeconds).toBeGreaterThan(0);
    // Set before the throw, so the exception filter needs no special case to preserve it.
    expect(Number(headers['retry-after'])).toBe(
      (error as TooManyRequestsError).retryAfterSeconds,
    );
  });
});

describe('the counters are shared, not per process', () => {
  it('lets a second replica see what the first counted', async () => {
    // The property that makes this authoritative rather than best-effort. Two guards, one store —
    // which is what two API pods against one Redis are. A per-process limiter would multiply
    // every published limit by the replica count without saying so.
    const cache = memoryCache();
    const first = guardWith(cache);
    const second = guardWith(cache);
    const login = { method: 'POST', path: '/api/v1/auth/login' };

    for (let attempt = 1; attempt <= 10; attempt++) await first.canActivate(ctx(login));

    await expect(second.canActivate(ctx(login))).rejects.toBeInstanceOf(TooManyRequestsError);
  });
});

describe('the identity dimensions', () => {
  it('limits a signed-in caller by user as well as by address', async () => {
    const guard = guardWith(memoryCache());
    const search = { method: 'GET', path: '/api/v1/search' };

    await runWithContext(tenantContext, async () => {
      for (let attempt = 1; attempt <= 60; attempt++) {
        await expect(guard.canActivate(ctx(search))).resolves.toBe(true);
      }
      await expect(guard.canActivate(ctx(search))).rejects.toBeInstanceOf(
        TooManyRequestsError,
      );
    });
  });
});

describe('when the store is unreachable', () => {
  it('allows the request and says so, rather than failing silently', async () => {
    // Fail-open is the right trade — a Redis blip must not take sign-in down — but it is only
    // defensible if somebody is told. A limiter that has been open for a week unnoticed is the
    // failure this assertion exists to prevent.
    const broken = {
      get: () => Promise.reject(new Error('redis is gone')),
      set: () => Promise.reject(new Error('redis is gone')),
      delete: () => Promise.reject(new Error('redis is gone')),
      setIfAbsent: () => Promise.reject(new Error('redis is gone')),
      compareAndSet: () => Promise.reject(new Error('redis is gone')),
      increment: () => Promise.reject(new Error('redis is gone')),
    } as unknown as CachePort;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const guard = new RateLimitGuard(broken, logger as unknown as Logger, metrics);

    await expect(
      guard.canActivate(ctx({ method: 'POST', path: '/api/v1/auth/login' })),
    ).resolves.toBe(true);
    expect(logger.error).toHaveBeenCalled();
  });
});
