import { createHash } from 'node:crypto';

import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { type Observable, catchError, concatMap, from, of, switchMap, throwError } from 'rxjs';

import { Header } from '@edms/contracts';

import { RequestInProgressError } from '../errors/application-errors';
import { LOGGER, type Logger } from '../observability/logger';
import { currentContext } from '../tenancy/tenant-context';
import {
  IDEMPOTENCY_STORE,
  type IdempotencyStore,
  type IdempotentRequest,
} from './idempotency.store';

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
 * caller was told it had. Reusing a key with a different body simply performs that request, as its
 * own request with its own stored answer, rather than being refused.
 *
 * **One request owns a key at a time** — RC validation, D-20. This used to look the key up, run the
 * request, and store the answer afterwards, so retries sent while the first attempt was still running
 * all found nothing and all ran: five simultaneous retries created up to five documents. The key is
 * now *claimed* before the request runs (`PrismaIdempotencyStore`: an insert that only one request,
 * in any process, can win), and a request that finds it:
 *
 * - claimed and answered — is given the stored answer, and nothing runs;
 * - claimed and still running — is refused with `REQUEST_IN_PROGRESS` (409, retryable), and its
 *   retry is given the owner's answer once there is one;
 * - unclaimed — claims it and runs.
 *
 * A request that **fails** gives the key back, as before D-20 a failure was never stored: the
 * caller's retry performs the request again rather than replaying an error for a day. Only the
 * owner's own token can complete or release a claim, so a claim taken over after its lease ran out
 * cannot be overwritten by the process that lost it.
 */
const IDEMPOTENT_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/**
 * What was asked for, as one short string.
 *
 * `JSON.stringify` over the parsed body rather than the raw bytes: the parsed value is what the
 * endpoint acts on, and two encodings of the same object should not read as two different requests.
 */
export function fingerprint(body: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(body ?? null) ?? 'null')
    .digest('hex');
}

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    @Inject(IDEMPOTENCY_STORE) private readonly store: IdempotencyStore,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const key = request.header(Header.IDEMPOTENCY_KEY);
    const tenantId = currentContext()?.tenantId;

    if (!key || !tenantId || !IDEMPOTENT_METHODS.has(request.method)) {
      return next.handle();
    }

    const identity: IdempotentRequest = {
      tenantId,
      key,
      method: request.method,
      path: request.path,
      bodyHash: fingerprint(request.body),
    };

    return from(this.store.claim(identity)).pipe(
      switchMap((claim) => {
        if (claim.kind === 'REPLAY') {
          return of(claim.body ?? undefined);
        }
        if (claim.kind === 'IN_PROGRESS') {
          return throwError(() => new RequestInProgressError());
        }
        return next.handle().pipe(
          // Stored before the caller is answered, so a retry sent the moment this response arrives
          // is replayed rather than told the request is still running.
          concatMap(async (response: unknown) => {
            await this.complete(identity, claim.token, this.statusOf(context, request), response);
            return response;
          }),
          catchError((error: unknown) =>
            from(this.release(identity, claim.token)).pipe(
              switchMap(() => throwError(() => error)),
            ),
          ),
        );
      }),
    );
  }

  /**
   * The status the route answers with — its `@HttpCode`, or the platform's default for the method.
   *
   * Recorded with the answer for the record's sake; a replay goes through the same route and is
   * answered with the same status by the same framework.
   */
  private statusOf(context: ExecutionContext, request: Request): number {
    const declared = this.reflector.get<number | undefined>(
      HTTP_CODE_METADATA,
      context.getHandler(),
    );
    return declared ?? (request.method === 'POST' ? 201 : 200);
  }

  /**
   * The mutation has happened by now, so a failure to *record* it must not become the caller's
   * failure too — they would retry a request that succeeded. It is logged, and the claim keeps the key
   * until its lease runs out, refusing retries as in progress rather than performing them again.
   */
  private async complete(
    identity: IdempotentRequest,
    token: string,
    statusCode: number,
    response: unknown,
  ): Promise<void> {
    try {
      await this.store.complete(identity, token, statusCode, response);
    } catch (error) {
      this.logger.error('An idempotent response could not be stored', {
        path: identity.path,
        method: identity.method,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** A failed release leaves the claim to its lease; the request's own error is what the caller gets. */
  private async release(identity: IdempotentRequest, token: string): Promise<void> {
    try {
      await this.store.release(identity, token);
    } catch (error) {
      this.logger.warn('An idempotency claim could not be released after a failed request', {
        path: identity.path,
        method: identity.method,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
