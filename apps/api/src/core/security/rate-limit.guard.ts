import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import { RateLimiter, rateLimitHeaders, type RateLimitTarget } from '@munaxa/security';
import { unsafeId, type TenantId as PlatformTenantId } from '@munaxa/types';

import { TooManyRequestsError } from '../errors/application-errors';
import { LOGGER, type Logger } from '../observability/logger';
import { METRICS, MetricName, type Metrics } from '../observability/metrics';
import { CACHE_PORT, type CachePort } from '../../ports/cache.port';
import { currentContext } from '../tenancy/tenant-context';
import { RATE_LIMIT_RULES } from './rate-limit';

/**
 * The rate limiter, finally enforced.
 *
 * `RATE_LIMIT_RULES` has described this product's limits since Phase 0.5 and nothing read them:
 * no guard, no interceptor, and `@nestjs/throttler` sat in `package.json` unimported. A limit
 * nothing enforces is a paragraph in a document, and the surfaces it named — sign-in, password
 * reset, presign, export — are exactly the ones an attacker enumerates.
 *
 * ## Authoritative, not best-effort
 *
 * The counters live in Redis through `CACHE_PORT`, so a limit is a limit across every replica, in
 * every region, and across a rolling deployment where old and new pods serve simultaneously. A
 * per-process limiter would have multiplied every published number by the replica count without
 * saying so, which is worse than none: it is a control that reports success while permitting the
 * traffic it was bought to stop.
 *
 * ## Running first, deliberately
 *
 * Registered ahead of authentication so an anonymous flood is refused before anything expensive
 * happens. The identity dimensions still work, because the authentication *middleware* has already
 * run by the time any guard does — so a signed-in request has its context, and an anonymous one
 * simply does not match the per-user rules.
 *
 * ## What a store failure does
 *
 * `RateLimiter` fails open and marks the decision `degraded`. That is the right trade for this
 * product — a Redis blip must not take sign-in down — but it is only defensible if somebody is
 * told, so `onDegraded` raises a metric and an error-level log rather than passing silently. A
 * rate limiter that has been open for a week and nobody noticed is the failure mode this comment
 * exists to prevent.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  readonly #limiter: RateLimiter;

  constructor(
    @Inject(CACHE_PORT) cache: CachePort,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(METRICS) private readonly metrics: Metrics,
  ) {
    this.#limiter = new RateLimiter({
      cache,
      rules: RATE_LIMIT_RULES,
      onDegraded: (error, rule) => {
        this.metrics.increment(MetricName.RATE_LIMIT_DEGRADED, { rule: rule.id });
        this.logger.error('The rate limiter could not reach its store and allowed the request', {
          rule: rule.id,
          reason: error instanceof Error ? error.message : 'unknown',
        });
      },
    });
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const decision = await this.#limiter.check(targetOf(request));

    // Set on every response, allowed or not: a client that can see how much of its budget is left
    // is a client that can back off before it is refused.
    for (const [header, value] of Object.entries(rateLimitHeaders(decision))) {
      response.setHeader(header, value);
    }

    if (decision.allowed) {
      return true;
    }

    this.metrics.increment(MetricName.RATE_LIMIT_EXCEEDED, { rule: decision.rule ?? 'unknown' });
    // The rule and the subject dimension, never the value. An IP address in a log line is a
    // personal datum and the rule name is what an operator actually needs.
    this.logger.warn('A request was rate limited', {
      rule: decision.rule,
      method: request.method,
      path: request.path,
      retryAfterSeconds: decision.retryAfterSeconds,
    });
    throw new TooManyRequestsError(decision.retryAfterSeconds);
  }
}

/**
 * The request, as the limiter's subject.
 *
 * `tenantId` is required by the platform's target and is a *key namespace* here rather than an
 * authorisation input — it decides which counter a request is counted against, nothing more. An
 * anonymous request has no context, so it falls back to the host label the sign-in path already
 * uses to select a directory. That keeps one tenant's failed sign-ins from consuming another
 * tenant's login budget, and a bare host collapses to a single shared namespace, which is correct
 * for a single-tenant installation.
 */
function targetOf(request: Request): RateLimitTarget {
  const context = currentContext();
  const tenant = context?.tenantId ?? hostLabel(request) ?? 'anonymous';
  const ipAddress = request.ip;

  return {
    method: request.method,
    path: request.path,
    tenantId: unsafeId<PlatformTenantId>(tenant),
    ...(ipAddress === undefined ? {} : { ipAddress }),
    ...(context?.userId == null ? {} : { userId: context.userId }),
    ...(context?.sessionId == null ? {} : { sessionId: context.sessionId }),
  };
}

/** The leftmost label of the host, when the host has one to spare. The sign-in path's own rule. */
function hostLabel(request: Request): string | null {
  const labels = (request.hostname || '').toLowerCase().split('.');
  return labels.length > 2 ? (labels[0] ?? null) : null;
}
