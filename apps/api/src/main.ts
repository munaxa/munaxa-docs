import 'reflect-metadata';

import { ValidationPipe, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';

import { API_VERSION } from '@edms/contracts';

import { AppModule } from './app.module';
import { APP_CONFIG, type AppConfig } from './core/config';
import { LOGGER, type Logger } from './core/observability/logger';
import { PERMISSIONS_POLICY, helmetOptions } from './core/security';

/**
 * Boot order matters, and it is the same order the request path runs in
 * (`docs/architecture/02-backend-architecture.md` §7): security headers, CORS, body limits,
 * then versioning, then validation.
 *
 * The body limit is 1 MB and that is not an oversight — bytes go to object storage through
 * presigned URLs and never through the API, so any request larger than this is either a
 * mistake or an attempt (`docs/architecture/00-system-architecture.md` §3).
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get<AppConfig>(APP_CONFIG);
  const logger = app.get<Logger>(LOGGER);

  app.use(helmet(helmetOptions));
  app.use(
    (
      _request: unknown,
      response: { setHeader(name: string, value: string): void },
      next: () => void,
    ) => {
      response.setHeader('Permissions-Policy', PERMISSIONS_POLICY);
      next();
    },
  );

  app.enableCors({
    origin: config.http.corsOrigins,
    credentials: true,
    maxAge: 86_400,
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'Idempotency-Key',
      'If-Match',
      'X-Correlation-Id',
      'Accept-Language',
    ],
    exposedHeaders: ['X-Correlation-Id', 'Retry-After'],
  });

  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: API_VERSION.slice(1) });

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      // Unknown fields are rejected, never silently dropped: a client sending `isAdmin: true`
      // has a bug or an intention, and both deserve an answer.
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
    }),
  );

  if (config.http.openApiEnabled) {
    const openApi = new DocumentBuilder()
      .setTitle('Munaxa Docs API')
      .setDescription(
        'Enterprise document control. Every endpoint states its permission, its error codes and its idempotency behaviour.',
      )
      .setVersion(config.app.version)
      .addBearerAuth()
      .build();
    SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, openApi));
  }

  app.enableShutdownHooks();

  await app.listen(config.app.port);
  logger.info('API listening', {
    port: config.app.port,
    env: config.env,
    version: config.app.version,
    openApi: config.http.openApiEnabled,
  });
}

void bootstrap();
