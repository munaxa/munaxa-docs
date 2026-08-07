import {
  defineConfig,
  fromSeconds,
  nestConfig,
  parseConfig,
  pickSchema,
  remapSchema,
  PLATFORM_SCHEMA,
  type ConfigIssue,
  type Resolved,
} from '@munaxa/config';

/**
 * The settings `@munaxa/config` owns, read from the variables this product already deploys.
 *
 * ## Why this is ten fields and not a hundred and ten
 *
 * The Platform owns what a *setting means* — that a signing secret is key material and not a
 * word, that a session has an idle deadline and an absolute one. It has no opinion about how many
 * pages a preview may render or which CSV profile an evidence bundle is written under, and it
 * should not acquire one. So this file takes the ten settings that are genuinely platform
 * infrastructure and leaves the rest in `configuration.ts`, where the product validates them.
 *
 * `pickSchema` is what makes that possible: adopting `PLATFORM_SCHEMA` whole would drag in
 * `MUNAXA_ENCRYPTION_KEY`, a required secret for field encryption this product does not use. A
 * new required secret in every deployment, for a capability nobody wired, is how an incremental
 * migration turns into one nobody performs.
 *
 * ## Why no variable is renamed
 *
 * `remapSchema` points each platform field at the name this product has always deployed.
 * `JWT_ACCESS_SECRET` still means what it meant; `SESSION_IDLE_TTL_SECONDS` still counts in
 * seconds, because `fromSeconds` restates the encoding at the source rather than at the field.
 * No Helm value, CI secret, App Service setting or `.env` changes. That was the constraint the
 * whole design had to satisfy — a migration requiring simultaneous variable renames across every
 * customer installation is a migration that does not happen.
 *
 * ## Why the product still validates these
 *
 * The Platform's bounds are the platform's: `MUNAXA_ACCESS_TOKEN_TTL` is a duration with no
 * ceiling, while this product has refused an access token longer than an hour since Phase 1.
 * Dropping that on adoption would be a weakening dressed as a migration. The refinements below
 * restate every product bound the zod schema enforced, so they still fail at startup, in the same
 * aggregated message, naming the same variable the operator set.
 */

/**
 * The platform fields this product consumes, and the variables each is read from.
 *
 * Every entry is a field with a live consumer. A platform field nobody reads would be validation
 * theatre: it would fail deployments over a value that changes no behaviour.
 */
export const PLATFORM_FIELDS = remapSchema(
  pickSchema(PLATFORM_SCHEMA, [
    'MUNAXA_SIGNING_SECRET',
    'MUNAXA_REDIS_URL',
    'MUNAXA_LOG_LEVEL',
    'MUNAXA_ACCESS_TOKEN_TTL',
    'MUNAXA_REFRESH_TOKEN_TTL',
    'MUNAXA_SESSION_IDLE_TIMEOUT',
    'MUNAXA_SESSION_ABSOLUTE_TIMEOUT',
    'MUNAXA_SESSION_MAX_CONCURRENT',
    'MUNAXA_TOKEN_ISSUER',
    'MUNAXA_TRUSTED_ORIGINS',
  ]),
  {
    // Landing paths, so `nestConfig` produces the shape `AppConfig` already has. Only the fields
    // whose units survive the crossing carry one — see `toPlatformSection`.
    MUNAXA_SIGNING_SECRET: { env: 'JWT_ACCESS_SECRET', path: 'auth.accessSecret' },
    MUNAXA_REDIS_URL: { env: 'REDIS_URL', path: 'redis.url' },
    MUNAXA_LOG_LEVEL: { env: 'LOG_LEVEL', path: 'log.level' },
    MUNAXA_TOKEN_ISSUER: { env: 'JWT_ISSUER', path: 'auth.issuer' },
    MUNAXA_SESSION_MAX_CONCURRENT: {
      env: 'SESSION_MAX_CONCURRENT',
      path: 'auth.maxConcurrentSessions',
    },
    // `list()` splits on commas, trims and drops empties — which is exactly what `loadConfig` did
    // by hand at this variable's call site, so the resolved value is identical.
    MUNAXA_TRUSTED_ORIGINS: { env: 'CORS_ORIGINS', path: 'http.corsOrigins' },

    // Durations. The platform counts milliseconds; these variables have counted whole seconds
    // since Phase 1, and renaming them is exactly what this migration may not do. `fromSeconds`
    // restates the encoding at the source, so `JWT_ACCESS_TTL_SECONDS=900` feeds a field that
    // parses `15m` without the platform relaxing what it accepts.
    MUNAXA_ACCESS_TOKEN_TTL: { env: fromSeconds('JWT_ACCESS_TTL_SECONDS') },
    MUNAXA_REFRESH_TOKEN_TTL: { env: fromSeconds('JWT_REFRESH_TTL_SECONDS') },
    MUNAXA_SESSION_IDLE_TIMEOUT: { env: fromSeconds('SESSION_IDLE_TTL_SECONDS') },
    MUNAXA_SESSION_ABSOLUTE_TIMEOUT: { env: fromSeconds('SESSION_ABSOLUTE_TTL_SECONDS') },
  },
);

export type PlatformConfig = Resolved<typeof PLATFORM_FIELDS>;

/**
 * The fields whose value crosses into `AppConfig` unchanged, and therefore carry a landing path.
 *
 * The four durations are absent because their unit changes on the way — see `toPlatformSection`.
 * Nesting them at their own `MUNAXA_*` keys would put a second, millisecond-valued copy of each
 * timeout in the config object beside the seconds-valued one every consumer reads, which is
 * exactly the sort of near-duplicate that gets picked up by mistake.
 */
const NESTED_FIELDS = pickSchema(PLATFORM_FIELDS, [
  'MUNAXA_SIGNING_SECRET',
  'MUNAXA_REDIS_URL',
  'MUNAXA_LOG_LEVEL',
  'MUNAXA_TOKEN_ISSUER',
  'MUNAXA_SESSION_MAX_CONCURRENT',
  'MUNAXA_TRUSTED_ORIGINS',
]);

const SECOND_MS = 1_000;

/**
 * This product's bounds on the platform's fields, restated as refinements.
 *
 * Each one is a rule the zod schema enforced before this migration, kept because dropping it
 * would be a weakening. They are expressed in seconds, because that is the unit the operator
 * types and therefore the unit the message has to name.
 */
const bounds = (
  variable: string,
  ms: number,
  min: number,
  max?: number,
): ConfigIssue | undefined => {
  const seconds = ms / SECOND_MS;
  if (seconds >= min && (max === undefined || seconds <= max)) return undefined;
  const expected = max === undefined ? `at least ${min} seconds` : `${min}–${max} seconds`;
  return { key: variable, problem: `expected ${expected}, got ${seconds}` };
};

export const PLATFORM_CONFIG = defineConfig(PLATFORM_FIELDS, {
  refine: [
    (config) => {
      const issues: ConfigIssue[] = [];

      // The platform's field is a plain string defaulting to empty, because the platform treats an
      // absent Redis as "use the in-process cache". This product has required a real Redis since
      // Phase 1 — the outbox dispatcher, the workflow timers and the ACL cache all assume one — so
      // the requirement and the URL check are restated here rather than lost.
      if (config.MUNAXA_REDIS_URL === '') {
        issues.push({ key: 'REDIS_URL', problem: 'missing required url (REDIS_URL)' });
      } else if (!isUrl(config.MUNAXA_REDIS_URL)) {
        issues.push({ key: 'REDIS_URL', problem: 'expected an absolute URL' });
      }

      const ranges: readonly [string, number, number, number?][] = [
        ['JWT_ACCESS_TTL_SECONDS', config.MUNAXA_ACCESS_TOKEN_TTL, 60, 3_600],
        ['JWT_REFRESH_TTL_SECONDS', config.MUNAXA_REFRESH_TOKEN_TTL, 3_600],
        ['SESSION_IDLE_TTL_SECONDS', config.MUNAXA_SESSION_IDLE_TIMEOUT, 300, 28_800],
        ['SESSION_ABSOLUTE_TTL_SECONDS', config.MUNAXA_SESSION_ABSOLUTE_TIMEOUT, 3_600, 2_592_000],
      ];
      for (const [variable, ms, min, max] of ranges) {
        const issue = bounds(variable, ms, min, max);
        if (issue !== undefined) issues.push(issue);
      }

      if (config.MUNAXA_SESSION_MAX_CONCURRENT > 100) {
        issues.push({ key: 'SESSION_MAX_CONCURRENT', problem: 'expected <= 100' });
      }

      // A lineage that may sit idle for longer than it may live is a bound that never binds. The
      // two variables were independently valid before and this relationship went unchecked, which
      // is the sort of thing a schema with cross-field rules is for.
      if (config.MUNAXA_SESSION_IDLE_TIMEOUT > config.MUNAXA_SESSION_ABSOLUTE_TIMEOUT) {
        issues.push({
          key: 'SESSION_IDLE_TTL_SECONDS',
          problem: 'cannot exceed SESSION_ABSOLUTE_TTL_SECONDS',
        });
      }

      return issues;
    },
  ],
});

/**
 * The defaults this product has deployed, for fields where the platform's differs.
 *
 * This is the one place the migration could have caused a silent regression, so it is explicit
 * rather than incidental. `MUNAXA_SESSION_IDLE_TIMEOUT` defaults to fifteen minutes in the
 * platform and has defaulted to eight hours here since the session migration; an installation
 * that never set the variable would have started signing its users out every fifteen minutes.
 * `MUNAXA_TOKEN_ISSUER` and `MUNAXA_TRUSTED_ORIGINS` are the same story with different values.
 *
 * Supplied through the *source* rather than by redefining the field, because redefining a
 * platform field is refused — and rightly: a product quietly overriding what the platform says a
 * session timeout means is how a security setting stops meaning what it says. A default is not a
 * meaning, so declaring it beside the deployment it belongs to is the honest place for it.
 *
 * The cost is that this table has to be maintained against the platform's defaults. See the P4.6
 * report for the enhancement that would remove it.
 */
const DOCS_DEFAULTS: Readonly<Record<string, string>> = {
  MUNAXA_SESSION_IDLE_TIMEOUT: '28800s',
  MUNAXA_SESSION_ABSOLUTE_TIMEOUT: '2592000s',
  MUNAXA_TOKEN_ISSUER: 'https://docs.munaxa.com',
  MUNAXA_TRUSTED_ORIGINS: 'http://localhost:3000',
};

/**
 * `process.env`, plus this product's default for any platform field nothing supplies.
 *
 * The check spans the canonical name *and every alias*, which is the whole subtlety: `parseConfig`
 * reads a field's own key before its aliases, so injecting `MUNAXA_SESSION_IDLE_TIMEOUT` while the
 * operator had set `SESSION_IDLE_TTL_SECONDS` would silently discard what they set.
 */
export function withDocsDefaults(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = { ...source };
  for (const [key, fallback] of Object.entries(DOCS_DEFAULTS)) {
    const definition = PLATFORM_FIELDS[key as keyof typeof PLATFORM_FIELDS];
    const names = [key, ...(definition?.aliases ?? []).map((alias) => alias.name)];
    if (names.every((name) => (merged[name] ?? '') === '')) {
      merged[key] = fallback;
    }
  }
  return merged;
}

/** Parse the platform's settings. Throws `PlatformError` listing every problem at once. */
export function loadPlatformConfig(
  source: Readonly<Record<string, string | undefined>>,
): PlatformConfig {
  return parseConfig(PLATFORM_CONFIG, withDocsDefaults(source));
}

/**
 * The platform's settings, in the shape `AppConfig` already had.
 *
 * The four durations change unit on the way. `AppConfig` states them in seconds, because that is
 * what every consumer reads and what the variables are named; the platform resolves them to
 * milliseconds. Converting here rather than changing `AppConfig` is the difference between a
 * configuration migration and a rewrite of every call site — and `fromSeconds` guaranteed whole
 * seconds went in, so nothing is lost coming back.
 */
export interface PlatformSection {
  readonly auth: {
    readonly accessSecret: string;
    readonly issuer: string;
    readonly maxConcurrentSessions: number;
    readonly accessTtlSeconds: number;
    readonly refreshTtlSeconds: number;
    readonly sessionIdleTtlSeconds: number;
    readonly sessionAbsoluteTtlSeconds: number;
  };
  readonly redis: { readonly url: string };
  readonly log: { readonly level: PlatformConfig['MUNAXA_LOG_LEVEL'] };
  readonly http: { readonly corsOrigins: readonly string[] };
}

export function toPlatformSection(config: PlatformConfig): PlatformSection {
  return {
    auth: {
      accessSecret: config.MUNAXA_SIGNING_SECRET,
      issuer: config.MUNAXA_TOKEN_ISSUER,
      maxConcurrentSessions: config.MUNAXA_SESSION_MAX_CONCURRENT,
      accessTtlSeconds: config.MUNAXA_ACCESS_TOKEN_TTL / SECOND_MS,
      refreshTtlSeconds: config.MUNAXA_REFRESH_TOKEN_TTL / SECOND_MS,
      sessionIdleTtlSeconds: config.MUNAXA_SESSION_IDLE_TIMEOUT / SECOND_MS,
      sessionAbsoluteTtlSeconds: config.MUNAXA_SESSION_ABSOLUTE_TIMEOUT / SECOND_MS,
    },
    redis: { url: config.MUNAXA_REDIS_URL },
    log: { level: config.MUNAXA_LOG_LEVEL },
    http: { corsOrigins: config.MUNAXA_TRUSTED_ORIGINS },
  };
}

/**
 * The platform's settings as an operator would want to read them at startup.
 *
 * `nestConfig` renders them under the paths declared above — `log.level`, `auth.issuer` — so the
 * line names each setting the way the application does rather than by its `MUNAXA_*` key.
 *
 * Secrets are **excluded rather than redacted**. `redactConfig` would replace
 * `MUNAXA_SIGNING_SECRET` with `[redacted]`, which is correct and one refactor away from not
 * being; a field that is not in the object cannot leak from it however this rendering is later
 * reused. `MUNAXA_REDIS_URL` is out for the same reason — `redis://user:password@host` is a
 * credential that the schema does not mark as one.
 *
 * Read paths are deliberately not taken from this: it is `Record<string, unknown>`, and a typed
 * section a consumer indexes into by string is typed in name only. That is `toPlatformSection`.
 */
const DIAGNOSTIC_FIELDS = pickSchema(NESTED_FIELDS, [
  'MUNAXA_LOG_LEVEL',
  'MUNAXA_TOKEN_ISSUER',
  'MUNAXA_SESSION_MAX_CONCURRENT',
  'MUNAXA_TRUSTED_ORIGINS',
]);

export function describePlatformConfig(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, unknown> {
  // Re-parses rather than being handed the resolved object, so that `AppConfig` keeps the shape it
  // has always had. Parsing is pure and happens once at startup; threading a second config object
  // through the bootstrap to save it would be the migration reaching into code it has no business
  // in.
  return nestConfig(DIAGNOSTIC_FIELDS, loadPlatformConfig(source));
}

function isUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}
