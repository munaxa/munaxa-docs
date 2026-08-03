import { Module } from '@nestjs/common';

import { HealthController } from './health/health.controller';
import { HealthService } from './health/health.service';

/** Logging is global (`LoggerModule`); health is a surface, so it lives with its controller. */
@Module({
  controllers: [HealthController],
  providers: [HealthService],
  exports: [HealthService],
})
export class ObservabilityModule {}
