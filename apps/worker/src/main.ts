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

  // Every consumer this product has runs in the API process, gated on `QUEUE_CONSUMERS_ENABLED`:
  // the outbox dispatcher and workflow timers from Phase 4, preview and OCR from Phase 7, the
  // search index from Phase 8, and the audit export lane and its verification schedule from
  // Phase 9. That is where the domain modules are composed, and composing them a second time here
  // would mean a flag that means "consume everything" in one process and "consume some of it" in
  // another.
  //
  // This process therefore exists as the seam rather than as the consumer: a deployment that wants
  // background work off the request path sets the flag false on its API instances and runs the
  // consumers here, and the day that happens is the day this file composes `WorkerModule` with the
  // domain modules rather than being changed in shape.
  console.warn(
    `Worker started. Queues: ${QUEUES.length}, scheduled jobs: ${SCHEDULE.length}. Consumers run in the API process, by configuration.`,
  );
}

void bootstrap();
