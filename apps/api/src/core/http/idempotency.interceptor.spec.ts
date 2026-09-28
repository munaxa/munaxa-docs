import 'reflect-metadata';

import { HttpCode, type CallHandler, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Header } from '@edms/contracts';
import { DomainError, ErrorCode, type TenantId, asId } from '@edms/domain';

import type { Logger } from '../observability/logger';
import { type RequestContext, runWithContext } from '../tenancy/tenant-context';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import type { IdempotencyClaim, IdempotencyStore } from './idempotency.store';

/**
 * What the interceptor does with each answer the store gives it — RC validation, D-20.
 *
 * The store is scripted here so each branch is exercised on purpose; that the store's answers are
 * atomic across processes is `__tests__/idempotency.integration.spec.ts`'s subject, on PostgreSQL.
 */

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

class Controller {
  create(): void {}
  @HttpCode(204)
  remove(): void {}
}

function contextFor(method: string, handler: 'create' | 'remove', key?: string): ExecutionContext {
  const request = {
    method,
    path: '/api/v1/documents',
    body: { title: 'A' },
    header: (name: string) =>
      name.toLowerCase() === Header.IDEMPOTENCY_KEY.toLowerCase() ? key : undefined,
  };
  return {
    getType: () => 'http',
    getHandler: () => Controller.prototype[handler],
    getClass: () => Controller,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

const tenantContext = {
  tenantId: asId<TenantId>('01999999-0000-7000-8000-0000000000a1'),
  userId: null,
  roles: [],
  permissions: [],
  sessionId: null,
  correlationId: 'unit',
  permissionVersion: 0,
  locale: 'en',
} as RequestContext;

let store: IdempotencyStore & {
  claim: ReturnType<typeof vi.fn>;
  complete: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
};

function run(context: ExecutionContext, handler: CallHandler): Promise<unknown> {
  const interceptor = new IdempotencyInterceptor(store, logger, new Reflector());
  return runWithContext(tenantContext, () =>
    firstValueFrom(interceptor.intercept(context, handler), { defaultValue: undefined }),
  );
}

function claimed(claim: IdempotencyClaim): void {
  store.claim.mockResolvedValue(claim);
}

beforeEach(() => {
  store = {
    claim: vi.fn(),
    complete: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(undefined),
  };
});

describe('the idempotency interceptor', () => {
  it('leaves a request without a key alone', async () => {
    const handle = vi.fn(() => of({ id: 'x' }));

    expect(await run(contextFor('POST', 'create'), { handle })).toEqual({ id: 'x' });
    expect(store.claim).not.toHaveBeenCalled();
  });

  it('leaves a GET alone even with a key', async () => {
    const handle = vi.fn(() => of({ id: 'x' }));

    await run(contextFor('GET', 'create', 'k'), { handle });
    expect(store.claim).not.toHaveBeenCalled();
  });

  it('performs the request as owner and stores its answer, with the route’s status, before answering', async () => {
    claimed({ kind: 'OWNER', token: 't-1' });
    const handle = vi.fn(() => of({ id: 'made' }));

    expect(await run(contextFor('POST', 'create', 'k'), { handle })).toEqual({ id: 'made' });
    expect(handle).toHaveBeenCalledTimes(1);
    expect(store.complete).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'k', method: 'POST', path: '/api/v1/documents' }),
      't-1',
      201,
      { id: 'made' },
    );
    expect(store.release).not.toHaveBeenCalled();
  });

  it('records a declared @HttpCode', async () => {
    claimed({ kind: 'OWNER', token: 't-2' });

    await run(contextFor('DELETE', 'remove', 'k'), { handle: () => of(undefined) });
    expect(store.complete).toHaveBeenCalledWith(expect.anything(), 't-2', 204, undefined);
  });

  it('replays a stored answer without performing anything', async () => {
    claimed({ kind: 'REPLAY', statusCode: 201, body: { id: 'first' } });
    const handle = vi.fn(() => of({ id: 'second' }));

    expect(await run(contextFor('POST', 'create', 'k'), { handle })).toEqual({ id: 'first' });
    expect(handle).not.toHaveBeenCalled();
  });

  it('refuses as in progress while the owner runs, performing nothing', async () => {
    claimed({ kind: 'IN_PROGRESS' });
    const handle = vi.fn(() => of({ id: 'x' }));

    await expect(run(contextFor('POST', 'create', 'k'), { handle })).rejects.toMatchObject({
      code: ErrorCode.REQUEST_IN_PROGRESS,
    });
    expect(handle).not.toHaveBeenCalled();
  });

  it('releases the key when the request fails, and the caller gets the request’s own error', async () => {
    claimed({ kind: 'OWNER', token: 't-3' });
    const failure = new DomainError(ErrorCode.VALIDATION_FAILED, 'bad');

    await expect(
      run(contextFor('POST', 'create', 'k'), { handle: () => throwError(() => failure) }),
    ).rejects.toBe(failure);
    expect(store.release).toHaveBeenCalledWith(expect.anything(), 't-3');
    expect(store.complete).not.toHaveBeenCalled();
  });

  it('still answers the caller when storing the answer fails — the mutation happened', async () => {
    claimed({ kind: 'OWNER', token: 't-4' });
    store.complete.mockRejectedValue(new Error('database gone'));

    expect(
      await run(contextFor('POST', 'create', 'k'), { handle: () => of({ id: 'done' }) }),
    ).toEqual({ id: 'done' });
    expect(logger.error).toHaveBeenCalled();
  });

  it('still reports the request’s error when releasing the key fails', async () => {
    claimed({ kind: 'OWNER', token: 't-5' });
    store.release.mockRejectedValue(new Error('database gone'));
    const failure = new DomainError(ErrorCode.NOT_FOUND, 'nope');

    await expect(
      run(contextFor('POST', 'create', 'k'), { handle: () => throwError(() => failure) }),
    ).rejects.toBe(failure);
  });
});
