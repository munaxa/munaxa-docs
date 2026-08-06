import { timingSafeEqual } from 'node:crypto';

import {
  Controller,
  Get,
  Header,
  Inject,
  NotFoundException,
  Optional,
  Req,
  UnauthorizedException,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import type { Request } from 'express';

import { APP_CONFIG, type AppConfig } from '../config';
import { Public } from '../auth/public.decorator';
import { METRICS_REGISTRY, type MetricsRegistry } from './metrics-registry';

/**
 * The scrape endpoint — `GET /api/metrics`.
 *
 * ## Why it is not simply public
 *
 * Health is public because an orchestrator and a load balancer hold no credentials and the body
 * carries nothing but dependency names. **A metrics body is different in kind**: it is the
 * deployment's queue depths, its error rates, its authorisation-refusal counts by permission and
 * its route table with request volumes. None of it is one tenant's data, and all of it is
 * reconnaissance — "which permissions are being refused, on which routes, how often" is the
 * opening move of exactly the enumeration 17 §9 alerts on.
 *
 * So it carries its own bearer token, `METRICS_SCRAPE_TOKEN`, required by configuration whenever
 * the driver is real. It is `@Public` in the sense that matters — it does not go through the
 * tenant guards, because a scraper is not a tenant and has no context to establish — and it is
 * not public in the sense that matters more.
 *
 * A **separate credential** rather than a permission on a role, and that is the decision: the
 * scraper is infrastructure belonging to the operator, not a person in any tenant's directory, and
 * minting it an account would put an operator's monitoring inside a customer's user list. It is
 * the same argument ADR-0013 makes for the operator console, applied to one route.
 *
 * ## Why it is version-neutral
 *
 * Every other route in this product is `/api/v1/…` and is a contract with a customer's
 * integration, versioned under 15 §8's compatibility rule. A scrape endpoint is a contract with
 * the deployment's own monitoring, and a Prometheus job configuration that had to be edited at a
 * major version would be an alerting gap on the day of a release.
 */
@Controller({ path: 'metrics', version: VERSION_NEUTRAL })
export class MetricsController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Optional() @Inject(METRICS_REGISTRY) private readonly registry: MetricsRegistry | null = null,
  ) {}

  @Get()
  @Public('A scraper holds no tenant session; this route carries its own bearer token instead.')
  @ApiExcludeEndpoint()
  // 0.0.4 is the text exposition version every scraper negotiates; naming it stops a client
  // guessing from the charset.
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  scrape(@Req() request: Request): string {
    const expected = this.config.observability.metricsScrapeToken;
    if (this.registry === null || expected === null) {
      // 404 rather than 503: a deployment that exports no metrics has no such route, and saying
      // "there is a metrics endpoint here but it is off" tells an unauthenticated caller one more
      // thing than it needs to.
      throw new NotFoundException();
    }
    if (!presentedTokenMatches(request.header('authorization'), expected)) {
      throw new UnauthorizedException();
    }
    return this.registry.render();
  }
}

/**
 * Constant-time, and length-safe.
 *
 * `timingSafeEqual` throws on a length mismatch, which would turn "the token is the wrong length"
 * into a 500 and a distinguishable answer. Both are compared as fixed-width digests instead —
 * the same shape the API-key verifier and the manifest signature check use.
 */
function presentedTokenMatches(header: string | undefined, expected: string): boolean {
  if (header === undefined || !header.toLowerCase().startsWith('bearer ')) {
    return false;
  }
  const presented = Buffer.from(header.slice('bearer '.length).trim(), 'utf8');
  const secret = Buffer.from(expected, 'utf8');
  if (presented.length !== secret.length) {
    // A length comparison leaks the length and nothing else, and the alternative — padding to a
    // fixed width — leaks the same thing through the padding. The token is 32 characters of
    // machine-generated entropy, so its length is not the secret.
    return false;
  }
  return timingSafeEqual(presented, secret);
}
