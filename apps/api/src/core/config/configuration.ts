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

    /**
     * Whether this process consumes background jobs as well as enqueuing them.
     *
     * Phase 4 is the first phase with anything to consume — the outbox dispatcher and the workflow
     * timers — and both run in the API process by default, because a single-server on-premise
     * installation is one process and a deployment where nothing consumes a lane is a deployment
     * where deadlines silently never fire.
     *
     * It is a switch rather than an assumption so that a horizontally scaled deployment can say so:
     * every instance enqueues, and one runs the consumers. Stated in configuration rather than
     * inferred from a hostname or an instance index, because "who is consuming this queue" must not
     * be something an operator has to work out.
     */
    QUEUE_CONSUMERS_ENABLED: booleanFromEnv.default(true),

    /** How many outbox rows the dispatcher claims per pass, and how often it looks. */
    OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(1_000).default(100),
    OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(200).max(60_000).default(2_000),

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
    /**
     * The object store's credentials.
     *
     * Optional in the schema and required by the driver, which is not the same as optional: an S3
     * deployment on an instance role legitimately supplies neither, and one on a static key pair
     * supplies both. Supplying exactly one is the misconfiguration worth catching, and it is
     * caught below rather than at the first upload.
     */
    STORAGE_ACCESS_KEY_ID: z.string().optional(),
    STORAGE_SECRET_ACCESS_KEY: z.string().optional(),
    STORAGE_SESSION_TOKEN: z.string().optional(),
    /**
     * Whether the bucket is addressed as a path segment rather than as a subdomain.
     *
     * MinIO and most S3-compatible stores need it; AWS deprecated it and Cloudflare R2 never had
     * it. It is a property of the endpoint rather than of the code, which is why it is a variable
     * and not a driver.
     */
    STORAGE_FORCE_PATH_STYLE: booleanFromEnv.default(false),
    /** Where the `LOCAL` driver keeps its files. Each tenant's prefix is a directory inside it. */
    STORAGE_LOCAL_ROOT: z.string().default('./.storage'),
    /**
     * The base URL browsers should use to reach the API's own transfer endpoints.
     *
     * The `LOCAL` driver has no presigning service in front of it, so the API issues its own
     * signed URLs against itself. They have to be absolute and reachable from a browser, which the
     * API cannot infer from the socket it is listening on when it sits behind a reverse proxy.
     */
    STORAGE_PUBLIC_URL: z.string().url().optional(),

    SEARCH_DRIVER: z.enum(['POSTGRES', 'OPENSEARCH']).default('POSTGRES'),
    OCR_DRIVER: z.enum(['NONE', 'TESSERACT', 'HOSTED']).default('NONE'),
    /** Where the `TESSERACT` driver finds its binary. A path, so an installer can pin one. */
    OCR_TESSERACT_PATH: z.string().default('tesseract'),
    /** The languages the engine is asked to read, in its own syntax. */
    OCR_LANGUAGES: z.string().default('ara+eng'),
    MAIL_DRIVER: z.enum(['NONE', 'SMTP', 'RESEND']).default('NONE'),
    AV_DRIVER: z.enum(['NONE', 'ICAP', 'HOSTED']).default('NONE'),
    /**
     * The office-to-PDF converter. `NONE` degrades honestly: Office documents keep their
     * extracted text and lose their paginated rendition — the same posture as `OCR_DRIVER=NONE`.
     * Deliberately absent from the production must-be-real list beside it: a deployment that
     * previews Office documents as text is degraded, not misconfigured.
     */
    OFFICE_DRIVER: z.enum(['NONE', 'LIBREOFFICE']).default('NONE'),
    OFFICE_LIBREOFFICE_PATH: z.string().default('soffice'),

    /**
     * The render sandbox's resource caps (`14-preview-architecture.md` §5). Deployment-tunable
     * because they are capacity statements, not correctness ones — every value here trades
     * "how large a document previews" against "how much one job may cost".
     */
    PREVIEW_RENDER_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(60_000),
    /** Sources above this are not rendered at all — the honest answer for a 2 GB scan. */
    PREVIEW_MAX_SOURCE_BYTES: z.coerce.number().int().min(1_048_576).default(134_217_728),
    PREVIEW_MAX_OUTPUT_BYTES: z.coerce.number().int().min(65_536).default(67_108_864),
    PREVIEW_MAX_PAGES: z.coerce.number().int().min(1).max(10_000).default(500),
    PREVIEW_MAX_TEXT_BYTES: z.coerce.number().int().min(4_096).default(2_097_152),
    PREVIEW_MAX_ARCHIVE_ENTRIES: z.coerce.number().int().min(16).default(4_096),
    PREVIEW_MAX_ARCHIVE_EXPANSION_RATIO: z.coerce.number().int().min(2).default(200),
    PREVIEW_MAX_PIXELS: z.coerce.number().int().min(65_536).default(40_000_000),

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

    // --- Storage, in every environment ---------------------------------------------------
    //
    // These were production-only until Phase 3, and they were wrong to be. They describe what a
    // *driver* needs in order to work at all, not what production demands of a deployment — an S3
    // driver with no bucket cannot address an object in staging either, and the failure it
    // produces there is a 500 on the first upload rather than a refusal to start. A development
    // environment that silently ignores half its storage configuration is a development
    // environment that proves nothing about the deployment it stands in for, which is the same
    // reasoning that put tenancy validation outside this block.
    if (config.STORAGE_DRIVER !== 'NONE' && config.STORAGE_DRIVER !== 'LOCAL') {
      if (!config.STORAGE_BUCKET) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['STORAGE_BUCKET'],
          message: 'A remote storage driver requires STORAGE_BUCKET.',
        });
      }
      // One half of a key pair is never a working configuration, and it is the shape a partly
      // filled `.env` takes. Neither is legitimate — an instance role supplies its own — so it is
      // the mismatch that is refused, not the absence.
      const keyId = config.STORAGE_ACCESS_KEY_ID !== undefined;
      const secret = config.STORAGE_SECRET_ACCESS_KEY !== undefined;
      if (keyId !== secret) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [keyId ? 'STORAGE_SECRET_ACCESS_KEY' : 'STORAGE_ACCESS_KEY_ID'],
          message: 'Give both halves of the storage key pair, or neither.',
        });
      }
    }
    if (config.DEPLOYMENT_PROFILE === 'CLOUD' && config.STORAGE_DRIVER === 'LOCAL') {
      // A filesystem is the right storage for one server and the wrong storage for a fleet: it is
      // not shared between instances, so a document uploaded through one is missing from the next.
      // Checked outside the production block for the same reason as the rest: a cloud staging
      // environment on a local filesystem is a staging environment that cannot reproduce its own
      // production defects.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['STORAGE_DRIVER'],
        message: 'The cloud profile requires object storage, not a local filesystem.',
      });
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
  /**
   * Background work.
   *
   * Phase 4 is the first phase with any: the outbox has been accumulating events transactionally
   * since Phase 1 with nothing consuming them, and the workflow engine's deadlines are delayed jobs.
   */
  readonly queue: {
    readonly consumersEnabled: boolean;
    readonly outboxBatchSize: number;
    readonly outboxPollIntervalMs: number;
  };
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
    /** Null when the deployment supplies credentials some other way — an instance role. */
    readonly credentials: {
      readonly accessKeyId: string;
      readonly secretAccessKey: string;
      readonly sessionToken: string | null;
    } | null;
    readonly forcePathStyle: boolean;
    readonly localRoot: string;
    readonly publicUrl: string | null;
  };
  readonly providers: {
    readonly search: RawConfig['SEARCH_DRIVER'];
    readonly ocr: RawConfig['OCR_DRIVER'];
    readonly mail: RawConfig['MAIL_DRIVER'];
    readonly antivirus: RawConfig['AV_DRIVER'];
    readonly office: RawConfig['OFFICE_DRIVER'];
  };
  readonly ocr: {
    readonly tesseractPath: string;
    readonly languages: string;
  };
  readonly office: {
    readonly libreofficePath: string;
  };
  /** The render sandbox's resource caps (`14-preview-architecture.md` §5). */
  readonly preview: {
    readonly timeoutMs: number;
    readonly maxSourceBytes: number;
    readonly maxOutputBytes: number;
    readonly maxPages: number;
    readonly maxTextBytes: number;
    readonly maxArchiveEntries: number;
    readonly maxArchiveExpansionRatio: number;
    readonly maxPixels: number;
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
    queue: {
      consumersEnabled: raw.QUEUE_CONSUMERS_ENABLED,
      outboxBatchSize: raw.OUTBOX_BATCH_SIZE,
      outboxPollIntervalMs: raw.OUTBOX_POLL_INTERVAL_MS,
    },
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
      credentials:
        raw.STORAGE_ACCESS_KEY_ID !== undefined && raw.STORAGE_SECRET_ACCESS_KEY !== undefined
          ? {
              accessKeyId: raw.STORAGE_ACCESS_KEY_ID,
              secretAccessKey: raw.STORAGE_SECRET_ACCESS_KEY,
              sessionToken: raw.STORAGE_SESSION_TOKEN ?? null,
            }
          : null,
      forcePathStyle: raw.STORAGE_FORCE_PATH_STYLE,
      localRoot: raw.STORAGE_LOCAL_ROOT,
      publicUrl: raw.STORAGE_PUBLIC_URL ?? null,
    },
    providers: {
      search: raw.SEARCH_DRIVER,
      ocr: raw.OCR_DRIVER,
      mail: raw.MAIL_DRIVER,
      antivirus: raw.AV_DRIVER,
      office: raw.OFFICE_DRIVER,
    },
    ocr: {
      tesseractPath: raw.OCR_TESSERACT_PATH,
      languages: raw.OCR_LANGUAGES,
    },
    office: {
      libreofficePath: raw.OFFICE_LIBREOFFICE_PATH,
    },
    preview: {
      timeoutMs: raw.PREVIEW_RENDER_TIMEOUT_MS,
      maxSourceBytes: raw.PREVIEW_MAX_SOURCE_BYTES,
      maxOutputBytes: raw.PREVIEW_MAX_OUTPUT_BYTES,
      maxPages: raw.PREVIEW_MAX_PAGES,
      maxTextBytes: raw.PREVIEW_MAX_TEXT_BYTES,
      maxArchiveEntries: raw.PREVIEW_MAX_ARCHIVE_ENTRIES,
      maxArchiveExpansionRatio: raw.PREVIEW_MAX_ARCHIVE_EXPANSION_RATIO,
      maxPixels: raw.PREVIEW_MAX_PIXELS,
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
