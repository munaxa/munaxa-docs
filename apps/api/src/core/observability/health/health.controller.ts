import { Controller, Get, HttpCode, HttpStatus, Inject } from '@nestjs/common';
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
 */
@ApiTags('health')
@Controller('health')
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
