import { z } from 'zod';

/**
 * Typed configuration, validated once at boot.
 *
 * Two rules give this file its shape: a misconfigured process **fails to start** rather than
 * degrading silently at the first request, and a production deployment may never fall back
 * to a development driver (`docs/architecture/02-backend-architecture.md` §4).
 */
const environmentSchema = z.enum(['development', 'test', 'staging', 'production']);

/**
 * Which shape of deployment this process is part of.
 *
 * It exists because two things genuinely differ between a customer's own server and the hosted
 * service, and neither is a code path in a use case. **How many tenants there are**: on premise there
 * is normally one, derived from the base environment, so an installation needs no catalogue at all.
 * And **which providers are acceptable in production**: a filesystem is the right storage for a single
 * server and the wrong storage for a fleet, so production validation differs.
 *
 * It is deliberately *not* consulted anywhere else. Business logic that branched on the deployment
 * profile would be business logic that behaves differently for a customer who bought the same product
 * ([ADR-0015](../../../../../docs/architecture/adr/0015-database-per-tenant.md)).
 */
const deploymentProfileSchema = z.enum(['ON_PREMISE', 'CLOUD']);

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

    DEPLOYMENT_PROFILE: deploymentProfileSchema.default('ON_PREMISE'),

    /**
     * The single tenant's slug, for an installation that serves one company.
     *
     * Required when no catalogue is given, and refused when one is: a deployment either derives its
     * one tenant from this environment or reads a catalogue, and a configuration that did both would
     * have two answers to "which tenants exist".
     */
    TENANT_SLUG: z.string().trim().toLowerCase().optional(),
    /** The single tenant's identifier. Stable across restarts, because it is in every row. */
    TENANT_ID: z.string().uuid().optional(),

    /** The catalogue as JSON, for a container that receives it as an environment variable. */
    TENANT_CATALOGUE: z.string().min(1).optional(),
    /** The catalogue as a file, for a deployment that mounts it as a secret or a config map. */
    TENANT_CATALOGUE_PATH: z.string().min(1).optional(),

    DATABASE_URL: z.string().url(),
    /** The migration role. Separate from the application role, which has no BYPASSRLS. */
    DATABASE_MIGRATION_URL: z.string().url().optional(),
    /** Per **tenant**, not per process: the ceiling is this times the number of live clients. */
    DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(200).default(10),
    DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).default(15_000),
    /**
     * How many tenant databases one process holds connections to at once.
     *
     * A bound rather than a cache size: each client owns a pool, so the real limit is this times
     * `DATABASE_POOL_SIZE`, and PostgreSQL's `max_connections` is what it has to fit inside. The
     * least recently used client is disconnected when the bound is reached, which costs a reconnect
     * on the next request for that tenant and costs nothing at all for a single-tenant install.
     */
    DATABASE_MAX_TENANT_CLIENTS: z.coerce.number().int().min(1).max(1_000).default(25),

    REDIS_URL: z.string().url(),

    /** Signing material for access tokens. Rotated by adding a key, never by editing one. */
    JWT_ISSUER: z.string().default('https://docs.munaxa.com'),
    JWT_AUDIENCE: z.string().default('munaxa-docs'),
    JWT_ACCESS_SECRET: z.string().min(32),
    JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(900),
    JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().min(3_600).default(2_592_000),

    STORAGE_DRIVER: z.enum(['NONE', 'LOCAL', 'S3', 'AZURE_BLOB', 'R2', 'GCS']).default('NONE'),
    /** The bucket, container or root directory. A tenant's own prefix sits inside it. */
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
    // --- Tenancy, in every environment ---------------------------------------------------
    //
    // A deployment either derives its one tenant from this environment or reads a catalogue.
    // Checked everywhere rather than only in production, because a development environment that
    // silently ignored half its tenancy configuration is a development environment that proves
    // nothing about the deployment it is standing in for.
    const catalogueSources = [
      ['TENANT_CATALOGUE', config.TENANT_CATALOGUE],
      ['TENANT_CATALOGUE_PATH', config.TENANT_CATALOGUE_PATH],
    ].filter(([, value]) => value !== undefined);

    if (catalogueSources.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TENANT_CATALOGUE'],
        message: 'Give the catalogue inline or as a file, not both.',
      });
    }

    const hasCatalogue = catalogueSources.length > 0;
    if (hasCatalogue) {
      for (const key of ['TENANT_SLUG', 'TENANT_ID'] as const) {
        if (config[key] !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} describes a single-tenant install and cannot be combined with a catalogue.`,
          });
        }
      }
    } else {
      for (const key of ['TENANT_SLUG', 'TENANT_ID'] as const) {
        if (config[key] === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `Set ${key} for a single-tenant install, or give a tenant catalogue.`,
          });
        }
      }
      if (config.DEPLOYMENT_PROFILE === 'CLOUD') {
        // The hosted service serves more than one company by definition. A cloud process with one
        // tenant derived from its own environment is a misconfiguration that would look like a
        // working installation until the second customer signed up.
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['TENANT_CATALOGUE'],
          message: 'The cloud profile requires a tenant catalogue.',
        });
      }
    }

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
    if (config.DEPLOYMENT_PROFILE === 'CLOUD' && config.STORAGE_DRIVER === 'LOCAL') {
      // A filesystem is the right storage for one server and the wrong storage for a fleet: it is
      // not shared between instances, so a document uploaded through one is missing from the next.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['STORAGE_DRIVER'],
        message: 'The cloud profile requires object storage, not a local filesystem.',
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
  /** Read by the tenant registry and by production validation. Nowhere else. */
  readonly deployment: {
    readonly profile: z.infer<typeof deploymentProfileSchema>;
    /**
     * Where the catalogue comes from. `SINGLE` derives one tenant from this environment, which is
     * what an on-premise installation needs and what every test uses.
     */
    readonly tenants:
      | { readonly source: 'SINGLE'; readonly id: string; readonly slug: string }
      | { readonly source: 'INLINE'; readonly document: string }
      | { readonly source: 'FILE'; readonly path: string };
  };
  readonly app: { readonly name: string; readonly version: string; readonly port: number };
  readonly http: { readonly corsOrigins: readonly string[]; readonly openApiEnabled: boolean };
  readonly log: { readonly level: RawConfig['LOG_LEVEL'] };
  readonly database: {
    readonly url: string;
    readonly migrationUrl: string | null;
    readonly poolSize: number;
    readonly statementTimeoutMs: number;
    readonly maxTenantClients: number;
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

/**
 * Which of the three tenancy shapes the environment describes.
 *
 * The schema has already refused every combination but one, so this is a narrowing rather than a
 * decision — and the non-null assertions the alternative would need are exactly what that
 * validation exists to remove.
 */
function tenantSourceOf(raw: RawConfig): AppConfig['deployment']['tenants'] {
  if (raw.TENANT_CATALOGUE !== undefined) {
    return { source: 'INLINE', document: raw.TENANT_CATALOGUE };
  }
  if (raw.TENANT_CATALOGUE_PATH !== undefined) {
    return { source: 'FILE', path: raw.TENANT_CATALOGUE_PATH };
  }
  return { source: 'SINGLE', id: raw.TENANT_ID ?? '', slug: raw.TENANT_SLUG ?? '' };
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  // An empty variable means "not set", not "set to the empty string". Both `.env.example` and
  // most deployment tooling write `FOO=` for an optional value left unfilled, and without this
  // the file we ship as a starting point refuses to boot on `STORAGE_ENDPOINT: Invalid url`.
  const provided = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value.trim() !== ''),
  );
  const parsed = configSchema.safeParse(provided);
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
    deployment: { profile: raw.DEPLOYMENT_PROFILE, tenants: tenantSourceOf(raw) },
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
      maxTenantClients: raw.DATABASE_MAX_TENANT_CLIENTS,
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
