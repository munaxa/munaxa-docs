import { Controller, Get, HttpCode, HttpStatus, Inject, Res, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { type HealthReport, type Liveness } from '@edms/contracts';

import { Public } from '../../auth/public.decorator';
import { CLOCK_PORT, type ClockPort } from '../../../ports/clock.port';
import { HealthService } from './health.service';

/**
 * The three probes an orchestrator and an operator need, kept apart on purpose.
 *
 * Liveness must not touch a dependency: if a slow database made liveness fail, Kubernetes
 * would restart every pod during a database incident and turn a degradation into an outage.
 *
 * ## Why it is version-neutral — Phase 9.1
 *
 * These were `/api/v1/health/…` because the controller took the global default, and every
 * operational document in this repository says otherwise: `deployment.md` gates a release on
 * `/api/health/ready`, `disaster-recovery.md` tells an operator to confirm `/api/health/ready` on a
 * replaced instance, and `penetration-testing.md` lists the unauthenticated surface as
 * `/api/health/live`, `/api/health/ready`, `/api/health`. All three named a path that answered
 * **404**, and nothing asserted the route, so the drift was invisible until a production-mode boot
 * was actually probed.
 *
 * `MetricsController` had already made this argument for itself: a scrape endpoint is a contract
 * with the deployment's own monitoring rather than with a customer's integration, and a Prometheus
 * job that needed editing at a major version would be an alerting gap on release day. A liveness
 * probe is the same kind of contract, with the orchestrator instead — a readiness URL pinned to
 * `v1` breaks the day `v1` retires, which is the day the cluster can least afford it.
 */
@ApiTags('health')
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly health: HealthService,
    @Inject(CLOCK_PORT) private readonly clock: ClockPort,
  ) {}

  @Get('live')
  @Public('Liveness must answer before authentication exists or a token can be verified.')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Is the process running? Touches no dependency.' })
  live(): Liveness {
    return { status: 'UP', uptimeSeconds: Math.floor(process.uptime()) };
  }

  /**
   * ## Why the status code moves with the report — Phase 9.2
   *
   * This answered **200** while its own body read `"status":"DOWN"` with every tenant database
   * unreachable. `deployment.md` gates a release on "`/api/health/ready` green on every instance
   * before the load balancer is opened", and a load balancer does not read JSON — it reads the
   * status line. A probe that returns 200 whatever it found admits a broken instance to the pool
   * and reports the deployment as successful, which is the failure mode a readiness probe exists
   * to prevent. It was measured on a real deployment: 200, `DOWN`, both databases down.
   *
   * `DEGRADED` stays 200 on purpose. It means nothing is down and something is slow or partial, and
   * an instance that can still serve should not be pulled out of rotation for it — the alternative
   * empties the pool during a degradation, which is the same argument liveness makes above.
   *
   * The code is set on the response rather than thrown, because `AllExceptionsFilter` turns every
   * throw into `application/problem+json` and would replace the dependency list with a generic
   * detail string. The operator needs to know *which* dependency, and the orchestrator needs the
   * status line; this is the only shape that gives both.
   */
  @Get('ready')
  @Public('Readiness is polled by the load balancer, which holds no credentials.')
  @ApiOperation({ summary: 'May this instance receive traffic?' })
  async ready(@Res({ passthrough: true }) response: Response): Promise<HealthReport> {
    const report = await this.health.report();
    response.status(
      report.status === 'DOWN' ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.OK,
    );
    return report;
  }

  @Get()
  @Public('Operator-facing detail behind readiness; carries no tenant data.')
  @ApiOperation({ summary: 'Dependency detail behind readiness.' })
  async detail(): Promise<HealthReport & { checkedAtEpoch: number }> {
    const report = await this.health.report();
    // `now()`, not `timestamp()`: the latter is monotonic and counts from an arbitrary
    // origin, so it was reporting milliseconds since this process started as an epoch.
    return { ...report, checkedAtEpoch: this.clock.now().getTime() };
  }
}
