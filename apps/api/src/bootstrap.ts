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

/**
 * The OpenAPI **document** and the OpenAPI **explorer** — Phase 17, and they are not the same
 * thing.
 *
 * They were one flag until this phase, and treating them as one was the mistake. 15 §6 has said
 * since Phase 0 that OpenAPI is *"served at `/api/docs` in non-production **and emitted as a build
 * artifact**"* — two deliverables with two audiences:
 *
 * - **The explorer** is an interactive HTML surface that enumerates every route and offers a "try
 *   it" button against the running deployment. Correctly refused in production, and configuration
 *   still refuses to boot with `OPENAPI_ENABLED` there.
 * - **The document** is a contract. It is what an SDK is generated from, what a customer's
 *   integration team reads, and what 15 §8's compatibility rule is diffed against between
 *   releases. Refusing to serve it in production means the one deployment whose contract anybody
 *   cares about is the one that will not state it — which is exactly backwards for a phase whose
 *   brief is "SDK preparation".
 *
 * So `/api/openapi.json` is served in every environment `OPENAPI_DOCUMENT_ENABLED` permits,
 * production included. It renders no HTML, executes nothing, and describes routes that every
 * guard in the product still refuses — enumerating an API has never been a permission this
 * product pretended to enforce, since `RoutePermissionRegistry` publishes the whole route table at
 * boot and 15 §8 requires deprecations to be *announced* in the document.
 *
 * ## What this deliberately does not do: a second definition of every shape
 *
 * The document below is built from the controllers' routes, their methods and their parameters —
 * what Nest already knows — and **not** from a hand-maintained set of `@ApiProperty` decorators on
 * DTO classes. 15 §6 says `@edms/contracts` is the source of truth and every contract in it is a
 * zod schema; a decorator set beside them would be a second definition of each shape, diverging
 * the first time somebody edited one and not the other.
 *
 * The consequence is stated rather than hidden: **the document describes the route surface and not
 * the body shapes**, so it is not yet enough to generate a fully typed SDK from. Closing that
 * needs a zod-to-JSON-Schema projection over `@edms/contracts` — one derivation from the existing
 * source of truth, not a second one beside it — and the report names it as the seam this phase
 * ships rather than adding a fifth declared-but-unbound contract. That is Phase 15's precedent,
 * applied here.
 */
export function configureOpenApi(app: INestApplication, config: AppConfig): void {
  if (!config.http.openApiEnabled && !config.http.openApiDocumentEnabled) {
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
  const document = SwaggerModule.createDocument(app, openApi);

  if (config.http.openApiDocumentEnabled) {
    // The document alone, on its own route, with no explorer attached. `raw: false` is what keeps
    // the two separable — `SwaggerModule.setup` would mount the HTML as well.
    app.use('/api/openapi.json', (_request: unknown, response: JsonResponse) => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(document));
    });
  }

  if (config.http.openApiEnabled) {
    SwaggerModule.setup('api/docs', app, document);
  }
}

/** The two methods the document route uses. Narrower than Express's `Response`, deliberately. */
interface JsonResponse {
  setHeader(name: string, value: string): void;
  end(body: string): void;
}
