import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { configureApp, configureOpenApi } from './bootstrap';
import { LOGGER, type Logger } from './core/observability/logger';
import { assertSchemasReady } from './core/prisma/startup-schema-gate';

/**
 * The process entry point.
 *
 * The application's own configuration lives in `bootstrap.ts`, so the end-to-end tests can
 * apply exactly the same setup instead of a lookalike. What is left here is what only a
 * process does: listen on a port, and say so.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = configureApp(app);
  configureOpenApi(app, config);

  app.enableShutdownHooks();

  // DC-01: never listen against a database the migration has not finished. A refusal ends the
  // process non-zero before the first health check, so the task never becomes healthy.
  await assertSchemasReady(app);

  await app.listen(config.app.port);
  app.get<Logger>(LOGGER).info('API listening', {
    port: config.app.port,
    env: config.env,
    version: config.app.version,
    openApi: config.http.openApiEnabled,
  });
}

bootstrap().catch((error: unknown) => {
  // Written plainly to stderr as well as logged: the logger may be buffering when start-up fails.
  process.stderr.write(
    `API start-up refused: ${(error instanceof Error ? error.message : 'unknown failure').replace(/postgres(?:ql)?:\/\/[^\s'"`<>]+/gi, 'postgresql://***')}\n`,
  );
  process.exit(1);
});
