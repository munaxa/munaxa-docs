import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { QUEUES, SCHEDULE } from './queues';
import { WorkerModule } from './worker.module';

/**
 * Boots the worker as a NestJS standalone application — no HTTP server, because a worker
 * that listens on a port is a worker someone will eventually route traffic to.
 *
 * Shutdown is graceful by design: on `SIGTERM` the consumers stop accepting new jobs and the
 * in-flight ones are allowed to finish. Killing a retention purge or an audit export halfway
 * is how a queue system loses work it has already reported as started.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  app.enableShutdownHooks();

  process.on('SIGTERM', () => {
    void app.close();
  });

  // Consumers and the scheduler are registered by the phases that add jobs; the lanes,
  // retry policies and dead-letter routing they will use are already defined in queues.ts.
  console.warn(
    `Worker started. Queues: ${QUEUES.length}, scheduled jobs: ${SCHEDULE.length}. No consumers are registered in Phase 0.5.`,
  );
}

void bootstrap();
