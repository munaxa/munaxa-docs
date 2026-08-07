import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { configureApp, configureOpenApi } from './bootstrap';
import { describePlatformConfig } from './core/config/platform';
import { LOGGER, type Logger } from './core/observability/logger';

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

  await app.listen(config.app.port);
  app.get<Logger>(LOGGER).info('API listening', {
    port: config.app.port,
    env: config.env,
    version: config.app.version,
    openApi: config.http.openApiEnabled,
    // The settings `@munaxa/config` owns, named the way the application names them. Secrets are
    // absent by construction rather than redacted — see `describePlatformConfig`.
    platform: describePlatformConfig(process.env),
  });
}

void bootstrap();
