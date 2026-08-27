import 'reflect-metadata';

import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { firstValueFrom, of } from 'rxjs';

import { Header } from '@edms/contracts';
import { type TenantId, asId } from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import type { AppConfig } from '../../config/configuration';
import { RedisCacheAdapter } from '../../../infrastructure/cache/redis-cache.adapter';
import { type RequestContext, runWithContext } from '../../tenancy/tenant-context';
import { IdempotencyInterceptor } from '../idempotency.interceptor';

/**
 * The replay store, against a real Redis — Slice 56.
 *
 * `IdempotencyInterceptor` is registered as a global `APP_INTERCEPTOR`, so every mutating request
 * carrying an `Idempotency-Key` passes through it, and until this file nothing tested it.
 *
 * What it promises is narrow and exact: 15 §2 says "the result is stored per `(tenantId, key)` and
 * **replayed on retry**", and the interceptor's own docstring gives the reason — "the client cannot
 * tell a lost response from a lost request, and a document submitted twice is a real support call".
 *
 * A retry is the same request sent again. Answering a *different* request with a stored response is
 * not a replay; it is telling a caller that something happened which did not.
 */

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379';

function configFor(): AppConfig {
  return { redis: { url: REDIS_URL } } as unknown as AppConfig;
}

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
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

/**
 * The rest of the pipeline: what the endpoint would have done.
 *
 * It counts, so a test can ask the question that matters — was the request *performed*, or was a
 * stored answer handed back instead.
 */
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

const adapters: RedisCacheAdapter[] = [];

function anInterceptor(): IdempotencyInterceptor {
  const adapter = new RedisCacheAdapter(configFor());
  adapters.push(adapter);
  return new IdempotencyInterceptor(adapter);
}

let TENANT = uuidv7();

beforeEach(() => {
  // Fresh per test, so no test depends on the order it runs in.
  TENANT = uuidv7();
});

afterAll(async () => {
  for (const adapter of adapters) {
    await adapter.onModuleDestroy?.();
  }
});

describe('a stored result answers the request it came from', () => {
  const PATH = '/api/v1/documents';

  async function through(
    interceptor: IdempotencyInterceptor,
    request: ExecutionContext,
    handler: CallHandler,
  ): Promise<unknown> {
    return runWithContext(contextFor(TENANT), () =>
      firstValueFrom(interceptor.intercept(request, handler)),
    );
  }

  it('performs a request that carries no key', async () => {
    // The control. Without it every assertion below passes on an interceptor that refuses
    // everything or performs nothing.
    const interceptor = anInterceptor();
    const handler = handlerReturning({ id: 'created' });

    const answer = await through(interceptor, requestFor({ method: 'POST', path: PATH }), handler);

    expect(handler.calls).toBe(1);
    expect(answer).toEqual({ id: 'created' });
  });

  it('performs the first request that carries a key', async () => {
    const interceptor = anInterceptor();
    const handler = handlerReturning({ id: 'first' });

    const answer = await through(
      interceptor,
      requestFor({ method: 'POST', path: PATH, key: 'k-1', body: { title: 'A' } }),
      handler,
    );

    expect(handler.calls).toBe(1);
    expect(answer).toEqual({ id: 'first' });
  });

  it('replays the stored result when the same request is retried', async () => {
    // The property the component exists for, and the answer the case below has to match.
    const interceptor = anInterceptor();
    const first = handlerReturning({ id: 'first' });
    const retry = handlerReturning({ id: 'second' });
    const sameRequest = (): ExecutionContext =>
      requestFor({ method: 'POST', path: PATH, key: 'k-2', body: { title: 'A' } });

    await through(interceptor, sameRequest(), first);
    const answer = await through(interceptor, sameRequest(), retry);

    // Not performed twice, and the caller is given what the first one produced.
    expect(retry.calls).toBe(0);
    expect(answer).toEqual({ id: 'first' });
  });

  it('does not answer a different request with the stored result', async () => {
    const interceptor = anInterceptor();
    const first = handlerReturning({ id: 'first' });
    const different = handlerReturning({ id: 'second' });

    await through(
      interceptor,
      requestFor({ method: 'POST', path: PATH, key: 'k-3', body: { title: 'A' } }),
      first,
    );
    const answer = await through(
      interceptor,
      // The same key on the same endpoint, asking for something else. A client that reuses a key
      // is a client bug; answering it with the first request's result turns that bug into a
      // mutation the caller is told happened and which never did.
      requestFor({ method: 'POST', path: PATH, key: 'k-3', body: { title: 'B' } }),
      different,
    );

    expect(different.calls).toBe(1);
    expect(answer).toEqual({ id: 'second' });
  });

  it('keeps one tenant’s key out of another’s', async () => {
    const interceptor = anInterceptor();
    const mine = handlerReturning({ id: 'mine' });
    const theirs = handlerReturning({ id: 'theirs' });
    const request = (): ExecutionContext =>
      requestFor({ method: 'POST', path: PATH, key: 'k-4', body: { title: 'A' } });

    await runWithContext(contextFor(TENANT), () =>
      firstValueFrom(interceptor.intercept(request(), mine)),
    );
    const answer = await runWithContext(contextFor(uuidv7()), () =>
      firstValueFrom(interceptor.intercept(request(), theirs)),
    );

    expect(theirs.calls).toBe(1);
    expect(answer).toEqual({ id: 'theirs' });
  });
});
