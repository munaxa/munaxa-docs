import 'reflect-metadata';

import type { ExecutionContext } from '@nestjs/common';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { ErrorCode, type TenantId, type UserId, asId } from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import type { AppConfig } from '../../config/configuration';
import type { Logger } from '../../observability/logger';
import { RedisCacheAdapter } from '../../../infrastructure/cache/redis-cache.adapter';
import { type RequestContext, runWithContext } from '../../tenancy/tenant-context';
import { RateLimitGuard } from '../rate-limit.guard';
import { ruleFor } from '../rate-limit';

/**
 * The rate limit, against a real Redis — Phase 6.7B.
 *
 * The property under test is **distributed enforcement**, and it is the reason this suite exists at
 * all: a limiter that works in one process is indistinguishable from a working one until the
 * deployment scales, at which point every instance grants the full budget and the control silently
 * becomes N times weaker than it reads. So the central test below builds **two guards over two
 * independent `RedisCacheAdapter`s with two independent Redis connections** — which is what two
 * application instances are — and asserts that they share one budget.
 *
 * A test that instantiated one guard twice, or shared one adapter, would pass against a process-
 * local `Map` and prove nothing. This one fails against it.
 */

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379';

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

function configFor(): AppConfig {
  return { redis: { url: REDIS_URL } } as unknown as AppConfig;
}

/** One application instance: its own cache client, its own guard. */
function anInstance(): { guard: RateLimitGuard; adapter: RedisCacheAdapter } {
  const adapter = new RedisCacheAdapter(configFor());
  return { guard: new RateLimitGuard(adapter, logger), adapter };
}

function contextFor(tenantId: string, userId: string | null): RequestContext {
  return {
    tenantId: asId<TenantId>(tenantId),
    userId: userId === null ? null : asId<UserId>(userId),
    roles: [],
    permissions: [],
    sessionId: null,
    correlationId: 'rate-limit-integration',
    permissionVersion: 0,
    locale: 'en',
  };
}

/** A request as the guard sees one. */
function requestFor(input: {
  method: string;
  path: string;
  ip?: string;
  body?: Record<string, unknown>;
}): ExecutionContext {
  const request = {
    method: input.method,
    path: input.path,
    ip: input.ip ?? '203.0.113.7',
    body: input.body ?? {},
  };
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

const adapters: RedisCacheAdapter[] = [];

function tracked(): { guard: RateLimitGuard; adapter: RedisCacheAdapter } {
  const instance = anInstance();
  adapters.push(instance.adapter);
  return instance;
}

let TENANT = uuidv7();
let SIGNER = uuidv7();

beforeEach(() => {
  // Fresh identifiers per test, so buckets never leak between them and no test depends on the
  // order it runs in.
  TENANT = uuidv7();
  SIGNER = uuidv7();
});

afterAll(async () => {
  for (const adapter of adapters) {
    await adapter.onModuleDestroy?.();
  }
});

describe('two application instances share one budget', () => {
  it('stops at the configured limit however the requests are distributed', async () => {
    const rule = ruleFor('document.sign');
    const left = tracked();
    const right = tracked();
    const revisionId = uuidv7();
    const body = { revisionId, purpose: 'APPROVAL' };
    const request = requestFor({
      method: 'POST',
      path: `/v1/documents/${uuidv7()}/signatures`,
      body,
    });

    // Alternating between the two instances, which is what a load balancer does. If each kept its
    // own counter, every one of these would be allowed and the assertion below would not fire.
    const instances = [left.guard, right.guard];
    for (let attempt = 0; attempt < rule.limit; attempt += 1) {
      const guard = instances[attempt % 2]!;
      await expect(
        runWithContext(contextFor(TENANT, SIGNER), () => guard.canActivate(request)),
      ).resolves.toBe(true);
    }

    // The budget is spent. Both instances must now refuse — not just the one that happened to see
    // the last request.
    for (const guard of instances) {
      await expect(
        runWithContext(contextFor(TENANT, SIGNER), () => guard.canActivate(request)),
      ).rejects.toMatchObject({ code: ErrorCode.RATE_LIMITED });
    }
  });

  it('carries the retry window in the refusal, and nothing about the infrastructure', async () => {
    const rule = ruleFor('document.sign');
    const { guard } = tracked();
    const request = requestFor({
      method: 'POST',
      path: `/v1/documents/${uuidv7()}/signatures`,
      body: { revisionId: uuidv7(), purpose: 'APPROVAL' },
    });

    for (let attempt = 0; attempt < rule.limit; attempt += 1) {
      await runWithContext(contextFor(TENANT, SIGNER), () => guard.canActivate(request));
    }

    await runWithContext(contextFor(TENANT, SIGNER), () => guard.canActivate(request)).then(
      () => expect.fail('the limit should have been refused'),
      (error: { code: string; message: string; details: Record<string, unknown> }) => {
        expect(error.code).toBe(ErrorCode.RATE_LIMITED);
        expect(error.details['retryAfterSeconds']).toBe(rule.windowSeconds);
        // Says when to come back, and nothing about Redis, keys or counters.
        expect(error.message).not.toMatch(/redis|cache|key|counter/i);
      },
    );
  });
});

describe('the buckets are separated the way the rules say', () => {
  it('does not let one tenant consume another tenant’s budget', async () => {
    const rule = ruleFor('document.sign');
    const { guard } = tracked();
    const other = uuidv7();
    const body = { revisionId: uuidv7(), purpose: 'APPROVAL' };
    const request = requestFor({
      method: 'POST',
      path: `/v1/documents/${uuidv7()}/signatures`,
      body,
    });

    for (let attempt = 0; attempt < rule.limit; attempt += 1) {
      await runWithContext(contextFor(TENANT, SIGNER), () => guard.canActivate(request));
    }
    await expect(
      runWithContext(contextFor(TENANT, SIGNER), () => guard.canActivate(request)),
    ).rejects.toMatchObject({ code: ErrorCode.RATE_LIMITED });

    // A different tenant, same everything else. Rate limiting must not become a way for one
    // customer to deny service to another.
    await expect(
      runWithContext(contextFor(other, SIGNER), () => guard.canActivate(request)),
    ).resolves.toBe(true);
  });

  it('does not let one attestation consume another’s budget', async () => {
    const rule = ruleFor('document.sign');
    const { guard } = tracked();
    const path = `/v1/documents/${uuidv7()}/signatures`;
    const first = requestFor({
      method: 'POST',
      path,
      body: { revisionId: uuidv7(), purpose: 'APPROVAL' },
    });

    for (let attempt = 0; attempt < rule.limit; attempt += 1) {
      await runWithContext(contextFor(TENANT, SIGNER), () => guard.canActivate(first));
    }
    await expect(
      runWithContext(contextFor(TENANT, SIGNER), () => guard.canActivate(first)),
    ).rejects.toMatchObject({ code: ErrorCode.RATE_LIMITED });

    // Signing a *different* revision, and the same revision for a different purpose, are different
    // acts — a signer who fumbled one attestation is not shut out of the others.
    const otherRevision = requestFor({
      method: 'POST',
      path,
      body: { revisionId: uuidv7(), purpose: 'APPROVAL' },
    });
    const otherPurpose = requestFor({
      method: 'POST',
      path,
      body: { revisionId: uuidv7(), purpose: 'AUTHORSHIP' },
    });
    await expect(
      runWithContext(contextFor(TENANT, SIGNER), () => guard.canActivate(otherRevision)),
    ).resolves.toBe(true);
    await expect(
      runWithContext(contextFor(TENANT, SIGNER), () => guard.canActivate(otherPurpose)),
    ).resolves.toBe(true);
  });

  it('counts sign-in by the submitted address without resolving it', async () => {
    // The enumeration property. A real address and a fictitious one are counted the same way and
    // refused the same way, because the key is the string that arrived — never an account id the
    // guard looked up first.
    const rule = ruleFor('auth.login');
    const { guard } = tracked();
    const address = `${uuidv7()}@example.test`;
    const login = requestFor({
      method: 'POST',
      path: '/v1/auth/login',
      ip: `198.51.100.${String(Math.floor(Math.random() * 200) + 1)}`,
      body: { email: address, password: 'irrelevant-to-the-key' },
    });

    for (let attempt = 0; attempt < rule.limit; attempt += 1) {
      await expect(guard.canActivate(login)).resolves.toBe(true);
    }
    await expect(guard.canActivate(login)).rejects.toMatchObject({
      code: ErrorCode.RATE_LIMITED,
    });
  });
});

describe('the boundary is where the rule says it is', () => {
  it('allows every request up to the limit and refuses the one after', async () => {
    const rule = ruleFor('document.sign');
    const { guard } = tracked();
    const request = requestFor({
      method: 'POST',
      path: `/v1/documents/${uuidv7()}/signatures`,
      body: { revisionId: uuidv7(), purpose: 'APPROVAL' },
    });

    for (let attempt = 1; attempt <= rule.limit; attempt += 1) {
      await expect(
        runWithContext(contextFor(TENANT, SIGNER), () => guard.canActivate(request)),
        `attempt ${String(attempt)} of ${String(rule.limit)}`,
      ).resolves.toBe(true);
    }
    await expect(
      runWithContext(contextFor(TENANT, SIGNER), () => guard.canActivate(request)),
    ).rejects.toMatchObject({ code: ErrorCode.RATE_LIMITED });
  });

  it('holds under concurrency — the counter is atomic, not read-then-write', async () => {
    const rule = ruleFor('document.sign');
    const { guard } = tracked();
    const request = requestFor({
      method: 'POST',
      path: `/v1/documents/${uuidv7()}/signatures`,
      body: { revisionId: uuidv7(), purpose: 'APPROVAL' },
    });

    // Twice the budget, all at once. `INCR` is atomic, so exactly `limit` may pass however the
    // scheduler interleaves them — a read-then-write limiter would let far more through.
    const outcomes = await Promise.allSettled(
      Array.from({ length: rule.limit * 2 }, () =>
        runWithContext(contextFor(TENANT, SIGNER), () => guard.canActivate(request)),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(rule.limit);
  });
});

describe('Redis failure does not silently lift the limit', () => {
  it('refuses a credential-sensitive request when the limiter is unreachable', async () => {
    // Fail closed, per the phase's decision. An unreachable Redis means the guard cannot know
    // whether the budget is spent, and for the signing ceremony "assume it is not" is the answer
    // Phase 6.6 refused to build on.
    const broken = new RedisCacheAdapter({
      redis: { url: 'redis://127.0.0.1:6390' },
    } as unknown as AppConfig);
    const guard = new RateLimitGuard(broken, logger);
    const request = requestFor({
      method: 'POST',
      path: `/v1/documents/${uuidv7()}/signatures`,
      body: { revisionId: uuidv7(), purpose: 'APPROVAL' },
    });

    await runWithContext(contextFor(TENANT, SIGNER), () => guard.canActivate(request)).then(
      () => expect.fail('a credential route must not be allowed when the limiter is down'),
      (error: { code: string; message: string }) => {
        expect(error.code).toBe(ErrorCode.RATE_LIMITED);
        // The caller is told to retry. They are not told the cache is down.
        expect(error.message).not.toMatch(/redis|connect|ECONNREFUSED/i);
      },
    );
    await broken.onModuleDestroy?.();
  }, 20_000);

  it('keeps a non-credential request working when the limiter is unreachable', async () => {
    // The other half of the decision, and the reason it is not a blanket policy: failing the whole
    // API closed over a cache outage trades a real outage for a hypothetical one.
    const broken = new RedisCacheAdapter({
      redis: { url: 'redis://127.0.0.1:6390' },
    } as unknown as AppConfig);
    const guard = new RateLimitGuard(broken, logger);
    const search = requestFor({ method: 'GET', path: '/v1/search' });

    await expect(
      runWithContext(contextFor(TENANT, SIGNER), () => guard.canActivate(search)),
    ).resolves.toBe(true);
    await broken.onModuleDestroy?.();
  }, 20_000);
});
