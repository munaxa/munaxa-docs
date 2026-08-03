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
 */
const IDEMPOTENT_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
const REPLAY_TTL_SECONDS = 86_400;

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

    const cacheKey = `idempotency:${tenantId}:${request.method}:${request.path}:${key}`;
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
