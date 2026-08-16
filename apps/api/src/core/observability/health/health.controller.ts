import { Controller, Get, HttpCode, HttpStatus, Inject, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

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

  @Get('ready')
  @Public('Readiness is polled by the load balancer, which holds no credentials.')
  @ApiOperation({ summary: 'May this instance receive traffic?' })
  async ready(): Promise<HealthReport> {
    return this.health.report();
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
