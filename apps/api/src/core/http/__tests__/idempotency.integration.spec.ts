import 'reflect-metadata';

import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Subject, firstValueFrom, of, throwError } from 'rxjs';

import { Header } from '@edms/contracts';
import { DomainError, ErrorCode, type TenantId, asId } from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import type { AppConfig } from '../../config/configuration';
import type { Logger } from '../../observability/logger';
import type { TenantDatabase } from '../../prisma/tenant-database';
import { type RequestContext, runWithContext } from '../../tenancy/tenant-context';
import { sharedDatabase } from '../../../testing/tenant-database';
import { IdempotencyInterceptor, fingerprint } from '../idempotency.interceptor';
import type { IdempotentRequest } from '../idempotency.store';
import { PrismaIdempotencyStore } from '../prisma-idempotency.store';

/**
 * The replay store, against a real PostgreSQL — Slice 56, and RC validation D-20.
 *
 * `IdempotencyInterceptor` is registered as a global `APP_INTERCEPTOR`, so every mutating request
 * carrying an `Idempotency-Key` passes through it. What it promises is narrow and exact: 15 §2 says
 * "the result is stored per `(tenantId, key)` and **replayed on retry**", and a retry is the same
 * request sent again — answering a *different* request with a stored response is telling a caller
 * that something happened which did not.
 *
 * D-20 adds the property that was missing: **one request owns a key at a time**. Five simultaneous
 * retries used to find nothing stored and all run. The claim is now an insert into the tenant's own
 * `idempotency_key`, which only one request can win; this suite races it through two independent
 * `TenantDatabase`s — two connection pools, as two API processes would have — and nothing
 * process-local stands between them.
 */

const OWNER_URL = process.env['DATABASE_MIGRATION_URL'] ?? '';
const APP_URL = process.env['DATABASE_URL'] ?? '';
const PATH = '/api/v1/documents';

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Logger;

const config = {
  env: 'test',
  database: { url: APP_URL, poolSize: 10, maxTenantClients: 5 },
} as unknown as AppConfig;

let owner: PrismaClient;
/** Two pools over the same database: what two API processes would be. */
let processA: TenantDatabase;
let processB: TenantDatabase;
let storeA: PrismaIdempotencyStore;
let storeB: PrismaIdempotencyStore;

let TENANT = '';
let OTHER_TENANT = '';

function contextFor(tenantId: string): RequestContext {
  return {
    tenantId: asId<TenantId>(tenantId),
    userId: null,
    roles: [],
    permissions: [],
    sessionId: null,
    correlationId: 'idempotency-integration',
    permissionVersion: 0,
    locale: 'en',
  };
}

/** A request as the interceptor sees one. */
function requestFor(input: {
  method: string;
  path: string;
  key?: string;
  body?: unknown;
}): ExecutionContext {
  const request = {
    method: input.method,
    path: input.path,
    body: input.body ?? {},
    header: (name: string) =>
      name.toLowerCase() === Header.IDEMPOTENCY_KEY.toLowerCase() ? input.key : undefined,
  };
  return {
    getType: () => 'http',
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

/** What the endpoint would have done, counting, so a test can ask whether it was *performed*. */
function handlerReturning(response: unknown): CallHandler & { calls: number } {
  const handler = {
    calls: 0,
    handle() {
      handler.calls += 1;
      return of(response);
    },
  };
  return handler as CallHandler & { calls: number };
}

function handlerFailing(error: Error): CallHandler & { calls: number } {
  const handler = {
    calls: 0,
    handle() {
      handler.calls += 1;
      return throwError(() => error);
    },
  };
  return handler as CallHandler & { calls: number };
}

/** A handler that answers only when told to — the owner, held mid-request. */
function handlerHeld(): CallHandler & { calls: number; answer: (value: unknown) => void } {
  const subject = new Subject<unknown>();
  const handler = {
    calls: 0,
    handle() {
      handler.calls += 1;
      return subject.asObservable();
    },
    answer(value: unknown) {
      subject.next(value);
      subject.complete();
    },
  };
  return handler as CallHandler & { calls: number; answer: (value: unknown) => void };
}

function interceptorOn(store: PrismaIdempotencyStore): IdempotencyInterceptor {
  return new IdempotencyInterceptor(store, logger, new Reflector());
}

async function through(
  interceptor: IdempotencyInterceptor,
  request: ExecutionContext,
  handler: CallHandler,
  tenantId = TENANT,
): Promise<unknown> {
  return runWithContext(contextFor(tenantId), () =>
    firstValueFrom(interceptor.intercept(request, handler), { defaultValue: undefined }),
  );
}

async function settle(promise: Promise<unknown>): Promise<{ value?: unknown; code?: string }> {
  try {
    return { value: await promise };
  } catch (error) {
    return { code: error instanceof DomainError ? error.code : String(error) };
  }
}

function identityOf(key: string, body: unknown, tenantId = TENANT): IdempotentRequest {
  return { tenantId, key, method: 'POST', path: PATH, bodyHash: fingerprint(body) };
}

/** This test's own rows: keys repeat across runs, tenants never do. */
async function rows(key: string): Promise<{ state: string; status_code: number | null }[]> {
  return owner.$queryRaw`
    SELECT state, status_code FROM idempotency_key WHERE tenant_id = ${TENANT}::uuid AND key = ${key}`;
}

beforeAll(() => {
  if (!OWNER_URL || !APP_URL) {
    throw new Error('DATABASE_URL and DATABASE_MIGRATION_URL must both be set.');
  }
  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  processA = sharedDatabase(config, logger, APP_URL);
  processB = sharedDatabase(config, logger, APP_URL);
  storeA = new PrismaIdempotencyStore(processA);
  storeB = new PrismaIdempotencyStore(processB);
}, 60_000);

afterAll(async () => {
  await processA?.disconnectAll();
  await processB?.disconnectAll();
  await owner?.$disconnect();
});

beforeEach(async () => {
  // Fresh tenants per test, so no test depends on the order it runs in.
  TENANT = uuidv7();
  OTHER_TENANT = uuidv7();
  for (const id of [TENANT, OTHER_TENANT]) {
    await owner.tenant.create({
      data: {
        id,
        slug: `idem-${id.replaceAll('-', '').slice(-12)}`,
        name: 'Idem',
        status: 'ACTIVE',
      },
    });
  }
});

describe('a stored result answers the request it came from', () => {
  it('performs a request that carries no key', async () => {
    const handler = handlerReturning({ id: 'created' });

    const answer = await through(
      interceptorOn(storeA),
      requestFor({ method: 'POST', path: PATH }),
      handler,
    );

    expect(handler.calls).toBe(1);
    expect(answer).toEqual({ id: 'created' });
  });

  it('performs the first request that carries a key, and stores its answer', async () => {
    const handler = handlerReturning({ id: 'first' });

    const answer = await through(
      interceptorOn(storeA),
      requestFor({ method: 'POST', path: PATH, key: 'k-1', body: { title: 'A' } }),
      handler,
    );

    expect(handler.calls).toBe(1);
    expect(answer).toEqual({ id: 'first' });
    expect(await rows('k-1')).toEqual([{ state: 'COMPLETED', status_code: 201 }]);
  });

  it('replays the stored result when the same request is retried — from another process', async () => {
    const first = handlerReturning({ id: 'first' });
    const retry = handlerReturning({ id: 'second' });
    const sameRequest = (): ExecutionContext =>
      requestFor({ method: 'POST', path: PATH, key: 'k-2', body: { title: 'A' } });

    await through(interceptorOn(storeA), sameRequest(), first);
    const answer = await through(interceptorOn(storeB), sameRequest(), retry);

    expect(retry.calls).toBe(0);
    expect(answer).toEqual({ id: 'first' });
  });

  it('does not answer a different request with the stored result', async () => {
    const first = handlerReturning({ id: 'first' });
    const different = handlerReturning({ id: 'second' });

    await through(
      interceptorOn(storeA),
      requestFor({ method: 'POST', path: PATH, key: 'k-3', body: { title: 'A' } }),
      first,
    );
    const answer = await through(
      interceptorOn(storeA),
      // The same key on the same endpoint, asking for something else: performed as its own request
      // (Slice 56), and stored as its own answer.
      requestFor({ method: 'POST', path: PATH, key: 'k-3', body: { title: 'B' } }),
      different,
    );

    expect(different.calls).toBe(1);
    expect(answer).toEqual({ id: 'second' });
    expect((await rows('k-3')).length).toBe(2);
  });

  it('keeps one tenant’s key out of another’s', async () => {
    const mine = handlerReturning({ id: 'mine' });
    const theirs = handlerReturning({ id: 'theirs' });
    const request = (): ExecutionContext =>
      requestFor({ method: 'POST', path: PATH, key: 'k-4', body: { title: 'A' } });

    await through(interceptorOn(storeA), request(), mine, TENANT);
    const answer = await through(interceptorOn(storeA), request(), theirs, OTHER_TENANT);

    expect(theirs.calls).toBe(1);
    expect(answer).toEqual({ id: 'theirs' });
  });

  it('replays a request answered with no body (a 204) as no body', async () => {
    const first = handlerReturning(undefined);
    const retry = handlerReturning({ unexpected: true });
    const request = (): ExecutionContext =>
      requestFor({ method: 'DELETE', path: `${PATH}/x`, key: 'k-5', body: { reason: 'r' } });

    await through(interceptorOn(storeA), request(), first);
    const answer = await through(interceptorOn(storeA), request(), retry);

    expect(retry.calls).toBe(0);
    expect(answer).toBeUndefined();
  });
});

describe('one request owns a key at a time (D-20)', () => {
  it('gives the claim to exactly one of twenty simultaneous claims across two processes', async () => {
    const identity = identityOf('race-1', { title: 'A' });

    const claims = await Promise.all(
      Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? storeA : storeB).claim(identity)),
    );

    expect(claims.filter((claim) => claim.kind === 'OWNER')).toHaveLength(1);
    expect(claims.filter((claim) => claim.kind === 'IN_PROGRESS')).toHaveLength(19);
    expect(await rows('race-1')).toEqual([{ state: 'IN_PROGRESS', status_code: null }]);
  });

  it('performs the request once when five identical requests arrive at once', async () => {
    const handlers = Array.from({ length: 5 }, () => handlerReturning({ id: 'the-one' }));
    const request = (): ExecutionContext =>
      requestFor({ method: 'POST', path: PATH, key: 'race-2', body: { title: 'A' } });

    const outcomes = await Promise.all(
      handlers.map((handler, i) =>
        settle(through(interceptorOn(i % 2 === 0 ? storeA : storeB), request(), handler)),
      ),
    );

    expect(handlers.reduce((sum, handler) => sum + handler.calls, 0)).toBe(1);
    for (const outcome of outcomes) {
      // Each is either the owner's answer (performed or replayed) or told the owner is still at it.
      expect(outcome.code === ErrorCode.REQUEST_IN_PROGRESS || outcome.value !== undefined).toBe(
        true,
      );
      if (outcome.value !== undefined) {
        expect(outcome.value).toEqual({ id: 'the-one' });
      }
    }
    // And the retry after the owner answered is the owner's answer, performed by nobody.
    const late = handlerReturning({ id: 'late' });
    expect(await through(interceptorOn(storeB), request(), late)).toEqual({ id: 'the-one' });
    expect(late.calls).toBe(0);
  });

  it('refuses a retry as in progress while the owner is still running, then replays its answer', async () => {
    const request = (): ExecutionContext =>
      requestFor({ method: 'POST', path: PATH, key: 'held', body: { title: 'A' } });
    const owner = handlerHeld();
    const ownerAnswer = through(interceptorOn(storeA), request(), owner);

    // The owner has claimed and is mid-request; this is deterministic, not a race.
    await expect.poll(() => owner.calls).toBe(1);
    const during = handlerReturning({ id: 'during' });
    const refused = await settle(through(interceptorOn(storeB), request(), during));

    expect(refused.code).toBe(ErrorCode.REQUEST_IN_PROGRESS);
    expect(during.calls).toBe(0);

    owner.answer({ id: 'owner' });
    expect(await ownerAnswer).toEqual({ id: 'owner' });

    const after = handlerReturning({ id: 'after' });
    expect(await through(interceptorOn(storeB), request(), after)).toEqual({ id: 'owner' });
    expect(after.calls).toBe(0);
  });
});

describe('a failure never poisons the key', () => {
  it('releases the claim when the request fails, so the retry performs it', async () => {
    const request = (): ExecutionContext =>
      requestFor({ method: 'POST', path: PATH, key: 'fails', body: { title: 'A' } });

    const failed = await settle(
      through(
        interceptorOn(storeA),
        request(),
        handlerFailing(new DomainError(ErrorCode.CONTENT_NOT_SCANNED, 'not yet')),
      ),
    );
    expect(failed.code).toBe(ErrorCode.CONTENT_NOT_SCANNED);
    expect(await rows('fails')).toEqual([]);

    const retry = handlerReturning({ id: 'second-time' });
    expect(await through(interceptorOn(storeB), request(), retry)).toEqual({ id: 'second-time' });
    expect(retry.calls).toBe(1);
  });

  it('lets a claim whose process died be taken once its lease runs out — and not before', async () => {
    const identity = identityOf('abandoned', { title: 'A' });
    const dead = await storeA.claim(identity);
    expect(dead.kind).toBe('OWNER');

    // Within the lease: still the dead owner's.
    expect((await storeB.claim(identity)).kind).toBe('IN_PROGRESS');

    await owner.$executeRaw`
      UPDATE idempotency_key SET lease_expires_at = now() - interval '1 second'
       WHERE tenant_id = ${TENANT}::uuid AND key = 'abandoned'`;
    const taken = await storeB.claim(identity);
    expect(taken.kind).toBe('OWNER');

    // The process that lost the claim cannot complete or release it.
    if (dead.kind === 'OWNER' && taken.kind === 'OWNER') {
      await storeA.complete(identity, dead.token, 201, { id: 'stale' });
      await storeA.release(identity, dead.token);
      expect(await rows('abandoned')).toEqual([{ state: 'IN_PROGRESS', status_code: null }]);
      await storeB.complete(identity, taken.token, 201, { id: 'fresh' });
    }
    const replay = await storeA.claim(identity);
    expect(replay).toEqual({ kind: 'REPLAY', statusCode: 201, body: { id: 'fresh' } });
  });

  it('performs the request again once its replay window has closed, and sweeps expired rows', async () => {
    const identity = identityOf('expired', { title: 'A' });
    const first = await storeA.claim(identity);
    if (first.kind === 'OWNER') {
      await storeA.complete(identity, first.token, 201, { id: 'old' });
    }
    const stale = identityOf('stale-other', { title: 'Z' });
    const other = await storeA.claim(stale);
    if (other.kind === 'OWNER') {
      await storeA.complete(stale, other.token, 201, { id: 'z' });
    }
    await owner.$executeRaw`
      UPDATE idempotency_key SET expires_at = now() - interval '1 second'
       WHERE tenant_id = ${TENANT}::uuid AND key IN ('expired', 'stale-other')`;

    expect((await storeB.claim(identity)).kind).toBe('OWNER');
    expect(await rows('stale-other')).toEqual([]);
  });
});
