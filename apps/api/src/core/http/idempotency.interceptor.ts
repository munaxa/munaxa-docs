import { createHash } from 'node:crypto';

import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import { type Observable, from, of, switchMap, tap } from 'rxjs';

import { Header } from '@edms/contracts';

import { CACHE_PORT, type CachePort } from '../../ports/cache.port';
import { currentContext } from '../tenancy/tenant-context';

/**
 * Replays a mutating request instead of performing it twice.
 *
 * A retry after a timeout is the normal case, not the exotic one: the client cannot tell a
 * lost response from a lost request, and a document submitted twice is a real support call.
 * The stored response is keyed by `(tenantId, key)`, so one tenant's key can never replay
 * into another's (`docs/architecture/15-api-architecture.md` §2).
 *
 * **A retry is the same request sent again** — Slice 56. The key also carries the method, the path
 * and a fingerprint of the body, because a stored response is an answer to one particular request
 * and to nothing else. Without the fingerprint a client that reuses a key on the same endpoint with
 * different content was handed the first request's result: the second mutation never ran, and the
 * caller was told it had. `idempotency_key.request_hash` has described this column since the schema
 * was written — "a reused key with different content is rejected rather than answered with someone
 * else's result" — and the store this interceptor actually uses never carried it.
 *
 * Reusing a key with a different body now simply performs the request, rather than being refused.
 * That is the narrower change: it makes the promise true — a result is replayed only to the request
 * it came from — without inventing a refusal the API does not currently document.
 */
const IDEMPOTENT_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
const REPLAY_TTL_SECONDS = 86_400;

/**
 * What was asked for, as one short string.
 *
 * `JSON.stringify` over the parsed body rather than the raw bytes: the parsed value is what the
 * endpoint acts on, and two encodings of the same object should not read as two different requests.
 */
function fingerprint(body: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(body ?? null) ?? 'null')
    .digest('hex');
}

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(@Inject(CACHE_PORT) private readonly cache: CachePort) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const key = request.header(Header.IDEMPOTENCY_KEY);
    const tenantId = currentContext()?.tenantId;

    if (!key || !tenantId || !IDEMPOTENT_METHODS.has(request.method)) {
      return next.handle();
    }

    const cacheKey = `idempotency:${tenantId}:${request.method}:${request.path}:${key}:${fingerprint(request.body)}`;
    return from(this.cache.get<unknown>(cacheKey)).pipe(
      switchMap((stored) =>
        stored !== null
          ? of(stored)
          : next
              .handle()
              .pipe(tap((response) => void this.cache.set(cacheKey, response, REPLAY_TTL_SECONDS))),
      ),
    );
  }
}
