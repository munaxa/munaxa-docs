import { CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';

import { DomainError, ErrorCode } from '@edms/domain';

import { LOGGER, type Logger } from '../observability/logger';
import { CACHE_PORT, type CachePort } from '../../ports/cache.port';
import { optionalContext } from '../tenancy/tenant-context';
import { type RateLimitRule, ruleFor, ruleForRequest } from './rate-limit';

/**
 * The rate limit, enforced — Phase 6.7B.
 *
 * `RATE_LIMIT_RULES` has been a table with no consumer since Phase 5, which is why Phase 6.6 blocked
 * the signing ceremony: an endpoint that accepts a password and answers one undifferentiated
 * refusal is only defended if the guesses are bounded. This guard is the call path that makes the
 * existing rules real. It invents no limit — every window and maximum below comes from that table.
 *
 * ## Redis is the authority, and there is no local fallback
 *
 * The counter is `CachePort.increment`, which the Redis adapter implements as `INCR` plus
 * `EXPIRE … NX` in one `MULTI`. That matters twice over: `INCR` is atomic *across connections*, so
 * two application instances sharing one Redis share one counter — which is the property being
 * protected — and `EXPIRE … NX` sets the window on first touch without extending it on later ones,
 * so the window is fixed rather than sliding by accident.
 *
 * There is deliberately **no in-process cache, Map or counter anywhere in this file.** A local
 * fallback would make the limit per-instance, which is indistinguishable from no limit once the
 * deployment scales — and it would pass a single-process test, which is why the suite runs two.
 *
 * ## Failing closed, but only where it must
 *
 * If Redis is unreachable the guard cannot know whether the budget is spent. For a route where
 * *accepting credentials is the security decision* — sign-in, and the signing ceremony — the safe
 * answer is to refuse: silently becoming unlimited during an outage is precisely the state Phase 6.6
 * refused to build on. For everything else the product keeps the availability it has today, because
 * failing the whole API closed over a cache outage trades a real outage for a hypothetical one.
 * That split is `credentialSensitive` on the route table, and both halves are asserted by tests.
 *
 * The refusal says nothing about Redis. A caller learns they are rate limited and when to retry;
 * infrastructure state is not theirs to see.
 *
 * ## What is never in a key
 *
 * No password, no TOTP code, no token, no header. The key is built from the rule name and the
 * dimensions the rule itself declares, plus — for the signing ceremony — the revision and purpose,
 * which are ordinary request identifiers rather than credential material. Cardinality is bounded by
 * construction: a closed set of rules, a closed set of dimensions, and a TTL on every key.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    @Inject(CACHE_PORT) private readonly cache: CachePort,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }
    const request = context.switchToHttp().getRequest<Request>();
    const route = ruleForRequest(request.method, request.path);
    const rule = ruleFor(route.rule);

    const keys = this.keysFor(rule, route.rule, request);
    if (keys.length === 0) {
      // Nothing to key on — an unauthenticated request under an identity-keyed rule. Allowed
      // rather than refused: the rule names a dimension this request does not carry, and inventing
      // one would put every anonymous caller in the world into a single shared bucket.
      return true;
    }

    for (const key of keys) {
      let used: number;
      try {
        used = await this.cache.increment(key, rule.windowSeconds);
      } catch (error) {
        if (route.credentialSensitive) {
          // Fail closed. The reason is logged for an operator and never returned to the caller.
          this.logger.error('The rate limiter is unavailable; refusing a credential request', {
            rule: rule.name,
            reason: error instanceof Error ? error.message : 'unknown',
          });
          throw new RateLimitedError(rule.windowSeconds);
        }
        this.logger.warn('The rate limiter is unavailable; allowing a non-credential request', {
          rule: rule.name,
        });
        return true;
      }
      if (used > rule.limit) {
        throw new RateLimitedError(rule.windowSeconds);
      }
    }
    return true;
  }

  /**
   * The keys one request consumes — one per dimension the rule declares, and all of them must pass.
   *
   * `auth.login` names `ip` *and* `identity`, so distributing an attack across addresses does not
   * lift the per-account budget and hammering one address does not depend on knowing an account.
   *
   * The identity for an unauthenticated route is the **submitted** identifier, taken verbatim and
   * never resolved to an account first. Resolving it would make the response depend on whether the
   * account exists, which is the enumeration oracle the whole login design avoids: a real address
   * and a fictitious one are counted identically and answered identically.
   */
  private keysFor(rule: RateLimitRule, ruleName: string, request: Request): readonly string[] {
    const context = optionalContext();
    const body = (request.body ?? {}) as Record<string, unknown>;
    const keys: string[] = [];

    // Every key a known tenant produces is namespaced by it, including the identity key — and that
    // is a correction rather than a flourish. Without it, `rl:{rule}:identity:{user}` is a *global*
    // bucket: two tenants whose identifiers ever coincided would share one, and one customer could
    // deny service to another by spending a bucket they should not be able to reach. The isolation
    // test in this guard's suite is what caught it, by exhausting one tenant and finding the next
    // refused. An unauthenticated request has no tenant and is keyed without one, which is correct:
    // sign-in happens before a tenant is known.
    const scope = context?.tenantId ?? null;
    const prefix = scope === null ? `rl:${ruleName}` : `rl:${ruleName}:t:${scope}`;

    for (const dimension of rule.by) {
      if (dimension === 'ip') {
        keys.push(`${prefix}:ip:${request.ip ?? 'unknown'}`);
        continue;
      }
      if (dimension === 'tenant') {
        if (scope !== null) {
          keys.push(`${prefix}:all`);
        }
        continue;
      }
      // identity
      const submitted = typeof body['email'] === 'string' ? body['email'].toLowerCase() : null;
      const identity = context?.userId ?? submitted;
      if (identity !== null && identity !== undefined) {
        keys.push(`${prefix}:identity:${identity}`);
      }
    }

    if (ruleName === 'document.sign') {
      // Narrowed to the act, so a fumbled attestation does not spend the budget for a different
      // one. Both values are ordinary identifiers from the request; neither is credential material.
      const revision = typeof body['revisionId'] === 'string' ? body['revisionId'] : 'unknown';
      const purpose = typeof body['purpose'] === 'string' ? body['purpose'] : 'unknown';
      return keys.map((key) => `${key}:${revision}:${purpose}`);
    }
    return keys;
  }
}

/**
 * The refusal.
 *
 * `ErrorCode.RATE_LIMITED` already maps to `429` in `all-exceptions.filter.ts` and is already in
 * `RETRYABLE_ERROR_CODES`, so this adds no new API contract — only the `retryAfterSeconds` detail
 * that `15 §5`'s error table has always said a `429` carries.
 */
export class RateLimitedError extends DomainError {
  constructor(retryAfterSeconds: number) {
    super(ErrorCode.RATE_LIMITED, 'Too many requests. Try again shortly.', {
      retryAfterSeconds,
    });
  }
}
