import { Module } from '@nestjs/common';

import { HealthController } from './health/health.controller';
import { HealthService } from './health/health.service';
import { MetricsController } from './metrics.controller';
import { MetricsSampler } from './metrics.sampler';

/**
 * Logging is global (`LoggerModule`); health and the scrape endpoint are surfaces, so they live
 * with their controllers.
 *
 * `METRICS` itself is bound in `InfrastructureModule` beside every other port, because which
 * exporter a deployment runs is exactly the vendor decision that file is the only holder of. This
 * module holds the *route*, which is not a vendor decision.
 */
@Module({
  controllers: [HealthController, MetricsController],
  providers: [HealthService, MetricsSampler],
  exports: [HealthService, MetricsSampler],
})
export class ObservabilityModule {}
