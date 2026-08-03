import { z } from 'zod';

/**
 * Typed configuration, validated once at boot.
 *
 * Two rules give this file its shape: a misconfigured process **fails to start** rather than
 * degrading silently at the first request, and a production deployment may never fall back
 * to a development driver (`docs/architecture/02-backend-architecture.md` §4).
 */
const environmentSchema = z.enum(['development', 'test', 'staging', 'production']);

const booleanFromEnv = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .or(z.boolean());

export const configSchema = z
  .object({
    NODE_ENV: environmentSchema.default('development'),
    APP_NAME: z.string().default('munaxa-docs-api'),
    APP_VERSION: z.string().default('0.1.0'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
    /** Allowed browser origins. Never `*`: the API is credentialed. */
    CORS_ORIGINS: z.string().default('http://localhost:3000'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    DATABASE_URL: z.string().url(),
    /** The migration role. Separate from the application role, which has no BYPASSRLS. */
    DATABASE_MIGRATION_URL: z.string().url().optional(),
    DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(200).default(10),
    DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).default(15_000),

    REDIS_URL: z.string().url(),

    /** Signing material for access tokens. Rotated by adding a key, never by editing one. */
    JWT_ISSUER: z.string().default('https://docs.munaxa.com'),
    JWT_AUDIENCE: z.string().default('munaxa-docs'),
    JWT_ACCESS_SECRET: z.string().min(32),
    JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(900),
    JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().min(3_600).default(2_592_000),

    STORAGE_DRIVER: z.enum(['NONE', 'LOCAL', 'S3', 'AZURE_BLOB', 'R2', 'GCS']).default('NONE'),
    STORAGE_BUCKET: z.string().optional(),
    STORAGE_REGION: z.string().optional(),
    STORAGE_ENDPOINT: z.string().url().optional(),
    STORAGE_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3_600).default(300),
    STORAGE_MAX_UPLOAD_BYTES: z.coerce.number().int().min(1).default(2_147_483_648),

    SEARCH_DRIVER: z.enum(['POSTGRES', 'OPENSEARCH']).default('POSTGRES'),
    OCR_DRIVER: z.enum(['NONE', 'TESSERACT', 'HOSTED']).default('NONE'),
    MAIL_DRIVER: z.enum(['NONE', 'SMTP', 'RESEND']).default('NONE'),
    AV_DRIVER: z.enum(['NONE', 'ICAP', 'HOSTED']).default('NONE'),

    RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).default(60),
    RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().min(1).default(300),

    OPENAPI_ENABLED: booleanFromEnv.default(true),
    SENTRY_DSN: z.string().url().optional(),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  })
  .superRefine((config, ctx) => {
    if (config.NODE_ENV !== 'production') {
      return;
    }
    // Production may not run on a placeholder. An unconfigured driver in production is a
    // silent outage waiting for its first upload, so it is a boot failure instead.
    const productionDrivers = [
      ['STORAGE_DRIVER', config.STORAGE_DRIVER],
      ['MAIL_DRIVER', config.MAIL_DRIVER],
      ['AV_DRIVER', config.AV_DRIVER],
    ] as const;
    for (const [key, value] of productionDrivers) {
      if (value === 'NONE') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} must name a real provider in production.`,
        });
      }
    }
    if (config.STORAGE_DRIVER !== 'LOCAL' && !config.STORAGE_BUCKET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['STORAGE_BUCKET'],
        message: 'A remote storage driver requires STORAGE_BUCKET.',
      });
    }
    if (config.OPENAPI_ENABLED) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['OPENAPI_ENABLED'],
        message: 'The OpenAPI explorer is not served in production.',
      });
    }
  });

export type RawConfig = z.infer<typeof configSchema>;

/** The shape the application reads. Grouped, so a module injects what it needs and no more. */
export interface AppConfig {
  readonly env: z.infer<typeof environmentSchema>;
  readonly isProduction: boolean;
  readonly app: { readonly name: string; readonly version: string; readonly port: number };
  readonly http: { readonly corsOrigins: readonly string[]; readonly openApiEnabled: boolean };
  readonly log: { readonly level: RawConfig['LOG_LEVEL'] };
  readonly database: {
    readonly url: string;
    readonly migrationUrl: string | null;
    readonly poolSize: number;
    readonly statementTimeoutMs: number;
  };
  readonly redis: { readonly url: string };
  readonly auth: {
    readonly issuer: string;
    readonly audience: string;
    readonly accessSecret: string;
    readonly accessTtlSeconds: number;
    readonly refreshTtlSeconds: number;
  };
  readonly storage: {
    readonly driver: RawConfig['STORAGE_DRIVER'];
    readonly bucket: string | null;
    readonly region: string | null;
    readonly endpoint: string | null;
    readonly signedUrlTtlSeconds: number;
    readonly maxUploadBytes: number;
  };
  readonly providers: {
    readonly search: RawConfig['SEARCH_DRIVER'];
    readonly ocr: RawConfig['OCR_DRIVER'];
    readonly mail: RawConfig['MAIL_DRIVER'];
    readonly antivirus: RawConfig['AV_DRIVER'];
  };
  readonly rateLimit: { readonly windowSeconds: number; readonly maxRequests: number };
  readonly observability: {
    readonly sentryDsn: string | null;
    readonly otlpEndpoint: string | null;
  };
}

export class ConfigurationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigurationError';
  }
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = configSchema.safeParse(source);
  if (!parsed.success) {
    // The message names the variables, never their values: an invalid secret must not be
    // echoed into a log line by the very error that rejected it.
    throw new ConfigurationError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  const raw = parsed.data;
  return {
    env: raw.NODE_ENV,
    isProduction: raw.NODE_ENV === 'production',
    app: { name: raw.APP_NAME, version: raw.APP_VERSION, port: raw.PORT },
    http: {
      corsOrigins: raw.CORS_ORIGINS.split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
      openApiEnabled: raw.OPENAPI_ENABLED,
    },
    log: { level: raw.LOG_LEVEL },
    database: {
      url: raw.DATABASE_URL,
      migrationUrl: raw.DATABASE_MIGRATION_URL ?? null,
      poolSize: raw.DATABASE_POOL_SIZE,
      statementTimeoutMs: raw.DATABASE_STATEMENT_TIMEOUT_MS,
    },
    redis: { url: raw.REDIS_URL },
    auth: {
      issuer: raw.JWT_ISSUER,
      audience: raw.JWT_AUDIENCE,
      accessSecret: raw.JWT_ACCESS_SECRET,
      accessTtlSeconds: raw.JWT_ACCESS_TTL_SECONDS,
      refreshTtlSeconds: raw.JWT_REFRESH_TTL_SECONDS,
    },
    storage: {
      driver: raw.STORAGE_DRIVER,
      bucket: raw.STORAGE_BUCKET ?? null,
      region: raw.STORAGE_REGION ?? null,
      endpoint: raw.STORAGE_ENDPOINT ?? null,
      signedUrlTtlSeconds: raw.STORAGE_SIGNED_URL_TTL_SECONDS,
      maxUploadBytes: raw.STORAGE_MAX_UPLOAD_BYTES,
    },
    providers: {
      search: raw.SEARCH_DRIVER,
      ocr: raw.OCR_DRIVER,
      mail: raw.MAIL_DRIVER,
      antivirus: raw.AV_DRIVER,
    },
    rateLimit: {
      windowSeconds: raw.RATE_LIMIT_WINDOW_SECONDS,
      maxRequests: raw.RATE_LIMIT_MAX_REQUESTS,
    },
    observability: {
      sentryDsn: raw.SENTRY_DSN ?? null,
      otlpEndpoint: raw.OTEL_EXPORTER_OTLP_ENDPOINT ?? null,
    },
  };
}
