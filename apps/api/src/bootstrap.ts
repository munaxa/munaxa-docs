import { type INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';

import { API_VERSION } from '@edms/contracts';

import { APP_CONFIG, type AppConfig } from './core/config';
import { PERMISSIONS_POLICY, helmetOptions } from './core/security';

/**
 * Everything that turns a resolved container into the running API.
 *
 * Extracted from `main.ts` so that the end-to-end tests configure the application by *calling
 * this*, rather than by repeating it. A test that assembles its own pipeline proves that its
 * own pipeline works; the interesting failures — a guard order, a missing prefix, a validation
 * rule — are exactly the ones such a test cannot see.
 *
 * Boot order matters, and it is the same order the request path runs in
 * (`docs/architecture/02-backend-architecture.md` §7): security headers, CORS, body limits,
 * then versioning, then validation.
 */
export function configureApp(app: INestApplication): AppConfig {
  const config = app.get<AppConfig>(APP_CONFIG);

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

  return config;
}

/** Served outside production only; configuration refuses to boot with it enabled there. */
export function configureOpenApi(app: INestApplication, config: AppConfig): void {
  if (!config.http.openApiEnabled) {
    return;
  }
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
