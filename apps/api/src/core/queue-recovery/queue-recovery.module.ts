import { Global, Module } from '@nestjs/common';

import { QueueRecoveryRegistry } from './queue-recovery.registry';
import { QueueRecoveryScheduler } from './queue-recovery.scheduler';

/** Rebuilding the broker's state from durable state — RC validation, D-13. */
@Global()
@Module({
  providers: [QueueRecoveryRegistry, QueueRecoveryScheduler],
  exports: [QueueRecoveryRegistry, QueueRecoveryScheduler],
})
export class QueueRecoveryModule {}
