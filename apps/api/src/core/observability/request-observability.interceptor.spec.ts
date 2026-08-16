import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext, CallHandler } from '@nestjs/common';
import { firstValueFrom, throwError } from 'rxjs';
import { describe, expect, it } from 'vitest';

import { DomainError, ErrorCode } from '@edms/domain';

import type { ClockPort } from '../../ports/clock.port';
import type { Logger } from './logger';
import { MetricName, type Metrics } from './metrics';
import { RequestObservabilityInterceptor } from './request-observability.interceptor';

/**
 * The status a refusal is recorded as — Phase 9.2.
 *
 * On a real deployment, a sign-in with a wrong password answered `401` on the wire and wrote
 * `"status":500` on the log line for the same request. The interceptor recognised `HttpException`
 * and nothing else, and this product's refusals are `DomainError`s — so every authentication
 * failure, every authorisation refusal and every 404 was counted in the `5xx` class that 17 §9
 * alerts on.
 *
 * These assert the log field and the metric label together, because the metric is the half that
 * pages somebody.
 */
describe('the status an observed request is recorded as', () => {
  it('records a domain refusal as its own status, not as a server error', async () => {
    const { interceptor, recorded } = build();
    const refusal = new DomainError(ErrorCode.UNAUTHENTICATED, 'wrong password');

    await expect(run(interceptor, refusal)).rejects.toBe(refusal);

    expect(recorded.logged?.status).toBe(401);
    expect(recorded.labels?.status).toBe('4xx');
  });

  it.each([
    [ErrorCode.FORBIDDEN, 403],
    [ErrorCode.NOT_FOUND, 404],
    [ErrorCode.VALIDATION_FAILED, 422],
    [ErrorCode.RATE_LIMITED, 429],
  ])('records %s as %i', async (code, status) => {
    const { interceptor, recorded } = build();

    await expect(run(interceptor, new DomainError(code, 'refused'))).rejects.toBeInstanceOf(
      DomainError,
    );

    expect(recorded.logged?.status).toBe(status);
    expect(recorded.labels?.status).toBe('4xx');
  });

  it('still reads the status off an HttpException', async () => {
    const { interceptor, recorded } = build();

    await expect(run(interceptor, new ForbiddenException())).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    expect(recorded.logged?.status).toBe(403);
  });

  // The case the old mapping got right, and the one that matters most: a genuine server error must
  // still be a server error, or the fix would have traded one blind spot for another.
  it('records an unrecognised failure as a server error', async () => {
    const { interceptor, recorded } = build();

    await expect(run(interceptor, new Error('the database went away'))).rejects.toBeInstanceOf(
      Error,
    );

    expect(recorded.logged?.status).toBe(500);
    expect(recorded.labels?.status).toBe('5xx');
  });
});

function build(): {
  interceptor: RequestObservabilityInterceptor;
  recorded: {
    logged?: Record<string, unknown>;
    labels?: Record<string, string>;
  };
} {
  const recorded: { logged?: Record<string, unknown>; labels?: Record<string, string> } = {};

  const metrics = {
    observe(name: string, _valueMs: number, labels?: Record<string, string>) {
      if (name === MetricName.HTTP_REQUEST_DURATION) {
        recorded.labels = labels;
      }
    },
  } as unknown as Metrics;

  const logger = {
    info(_message: string, context?: Record<string, unknown>) {
      recorded.logged = context;
    },
    debug() {},
    warn() {},
    error() {},
    child() {
      return logger;
    },
  } as unknown as Logger;

  const clock = { timestamp: () => 0, elapsedMs: () => 1 } as unknown as ClockPort;

  return { interceptor: new RequestObservabilityInterceptor(metrics, logger, clock), recorded };
}

async function run(
  interceptor: RequestObservabilityInterceptor,
  failure: unknown,
): Promise<unknown> {
  const request = { method: 'POST', headers: {}, route: { path: '/api/v1/auth/login' } };
  const context = {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({ statusCode: 200 }),
    }),
  } as unknown as ExecutionContext;

  const handler = { handle: () => throwError(() => failure) } as unknown as CallHandler;

  return firstValueFrom(interceptor.intercept(context, handler));
}
