import { describe, expect, it } from 'vitest';

import { ConfigurationError, loadConfig } from './configuration';
import { describePlatformConfig, loadPlatformConfig } from './platform';

/**
 * What this file is for.
 *
 * P4.6 moved ten settings out of the product's zod schema and into `@munaxa/config`. The variables
 * did not move, the defaults did not move, and the bounds did not move — and *that* is the claim
 * worth testing, because every one of those three is something a schema migration silently breaks.
 *
 * A deployment cannot be asked to change to accommodate a refactor it did not request. The
 * assertions below are the ones that would have caught it if it had been.
 */

const baseEnv = {
  DATABASE_URL: 'postgresql://app:secret@localhost:5432/edms',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  TENANT_ID: '019489f0-0000-7000-8000-000000000001',
  TENANT_SLUG: 'acme',
} satisfies NodeJS.ProcessEnv;

describe('the variables an existing deployment already sets', () => {
  it('reads every platform field from its historical name', () => {
    const config = loadConfig({
      ...baseEnv,
      JWT_ISSUER: 'https://docs.example.test',
      JWT_ACCESS_TTL_SECONDS: '600',
      JWT_REFRESH_TTL_SECONDS: '86400',
      SESSION_IDLE_TTL_SECONDS: '3600',
      SESSION_ABSOLUTE_TTL_SECONDS: '604800',
      SESSION_MAX_CONCURRENT: '4',
      CORS_ORIGINS: 'https://a.test, https://b.test',
      LOG_LEVEL: 'debug',
    });

    expect(config.auth.issuer).toBe('https://docs.example.test');
    expect(config.auth.accessSecret).toBe('a'.repeat(32));
    expect(config.auth.maxConcurrentSessions).toBe(4);
    expect(config.log.level).toBe('debug');
    expect(config.redis.url).toBe('redis://localhost:6379');
    // Trimmed and split exactly as `loadConfig` split it by hand before the migration.
    expect(config.http.corsOrigins).toEqual(['https://a.test', 'https://b.test']);
  });

  it('keeps the seconds these variables have always counted in', () => {
    // The platform field is a duration and resolves to milliseconds. `fromSeconds` restates the
    // encoding at the source, so `600` still means ten minutes rather than being rejected as a
    // duration with no unit — and `AppConfig` still states seconds, so no consumer moved.
    const config = loadConfig({
      ...baseEnv,
      JWT_ACCESS_TTL_SECONDS: '600',
      JWT_REFRESH_TTL_SECONDS: '86400',
      SESSION_IDLE_TTL_SECONDS: '3600',
      SESSION_ABSOLUTE_TTL_SECONDS: '604800',
    });

    expect(config.auth.accessTtlSeconds).toBe(600);
    expect(config.auth.refreshTtlSeconds).toBe(86_400);
    expect(config.auth.sessionIdleTtlSeconds).toBe(3_600);
    expect(config.auth.sessionAbsoluteTtlSeconds).toBe(604_800);
  });

  it('rejects a seconds value that is not whole seconds, naming the variable the operator set', () => {
    expect(() => loadConfig({ ...baseEnv, JWT_ACCESS_TTL_SECONDS: '10m' })).toThrowError(
      /JWT_ACCESS_TTL_SECONDS/,
    );
  });
});

describe('the defaults an existing deployment relies on', () => {
  it('keeps this product’s defaults where the platform’s differ', () => {
    const config = loadConfig({ ...baseEnv });

    // Each of these is a value the platform defaults differently. An installation that never set
    // the variable must not change behaviour because validation moved.
    expect(config.auth.sessionIdleTtlSeconds).toBe(28_800); // platform: 900
    expect(config.auth.sessionAbsoluteTtlSeconds).toBe(2_592_000); // platform: 43_200
    expect(config.auth.issuer).toBe('https://docs.munaxa.com'); // platform: 'munaxa'
    expect(config.http.corsOrigins).toEqual(['http://localhost:3000']); // platform: []
  });

  it('keeps the defaults the platform already agrees with', () => {
    const config = loadConfig({ ...baseEnv });
    expect(config.auth.accessTtlSeconds).toBe(900);
    expect(config.auth.refreshTtlSeconds).toBe(2_592_000);
    expect(config.auth.maxConcurrentSessions).toBe(10);
    expect(config.log.level).toBe('info');
  });

  it('never lets a supplied default shadow the variable the operator set', () => {
    // The subtle one. `parseConfig` reads a field's own key before its aliases, so injecting
    // `MUNAXA_SESSION_IDLE_TIMEOUT` as a fallback while `SESSION_IDLE_TTL_SECONDS` was set would
    // discard what the operator wrote — and the deployment would look configured and not be.
    const config = loadConfig({ ...baseEnv, SESSION_IDLE_TTL_SECONDS: '1800' });
    expect(config.auth.sessionIdleTtlSeconds).toBe(1_800);
  });

  it('lets a new deployment use the platform’s own names', () => {
    const resolved = loadPlatformConfig({
      MUNAXA_SIGNING_SECRET: 'b'.repeat(32),
      MUNAXA_REDIS_URL: 'redis://localhost:6379',
      MUNAXA_SESSION_IDLE_TIMEOUT: '45m',
    });
    expect(resolved.MUNAXA_SESSION_IDLE_TIMEOUT).toBe(2_700_000);
    expect(resolved.MUNAXA_SIGNING_SECRET).toBe('b'.repeat(32));
  });
});

describe('the bounds this product enforced before the migration', () => {
  it.each([
    ['JWT_ACCESS_TTL_SECONDS', '30'],
    ['JWT_ACCESS_TTL_SECONDS', '7200'],
    ['JWT_REFRESH_TTL_SECONDS', '60'],
    ['SESSION_IDLE_TTL_SECONDS', '60'],
    ['SESSION_IDLE_TTL_SECONDS', '86400'],
    ['SESSION_ABSOLUTE_TTL_SECONDS', '60'],
    ['SESSION_MAX_CONCURRENT', '500'],
  ])('still refuses %s=%s', (variable, value) => {
    // The platform's own field would accept every one of these: its durations have no ceiling and
    // its concurrency has no upper bound. Dropping them on adoption would have been a weakening
    // dressed as a migration.
    expect(() => loadConfig({ ...baseEnv, [variable]: value })).toThrowError(new RegExp(variable));
  });

  it('still requires Redis, and still requires it to be a URL', () => {
    const { REDIS_URL: _omitted, ...withoutRedis } = baseEnv;
    expect(() => loadConfig(withoutRedis)).toThrowError(/REDIS_URL/);
    expect(() => loadConfig({ ...baseEnv, REDIS_URL: 'not-a-url' })).toThrowError(/REDIS_URL/);
  });

  it('still requires signing material of at least 32 characters', () => {
    expect(() => loadConfig({ ...baseEnv, JWT_ACCESS_SECRET: 'short' })).toThrowError(
      /JWT_ACCESS_SECRET/,
    );
  });

  it('refuses a lineage that may idle longer than it may live', () => {
    // New, and the kind of rule a schema with cross-field refinements is for: both values were
    // independently valid before, and their relationship went unchecked.
    expect(() =>
      loadConfig({
        ...baseEnv,
        SESSION_IDLE_TTL_SECONDS: '28800',
        SESSION_ABSOLUTE_TTL_SECONDS: '3600',
      }),
    ).toThrowError(/SESSION_IDLE_TTL_SECONDS/);
  });
});

describe('startup failure', () => {
  it('reports platform and product problems in one message', () => {
    // Two validators now run. The whole value of failing at startup is that an operator learns
    // everything wrong in one restart, so a design that threw on the first parser would have
    // halved it.
    const { REDIS_URL: _omitted, ...env } = baseEnv;
    let error: unknown;
    try {
      loadConfig({ ...env, PORT: '99999' });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ConfigurationError);
    const issues = (error as ConfigurationError).issues.join('\n');
    expect(issues).toMatch(/REDIS_URL/); // platform
    expect(issues).toMatch(/PORT/); // product
  });

  it('never puts a value in the message', () => {
    let error: unknown;
    try {
      loadConfig({ ...baseEnv, JWT_ACCESS_SECRET: 'this-secret-is-too-short' });
    } catch (caught) {
      error = caught;
    }
    expect((error as ConfigurationError).message).not.toContain('this-secret-is-too-short');
  });
});

describe('the startup diagnostic', () => {
  it('renders platform settings under the names the application uses', () => {
    const described = describePlatformConfig({ ...baseEnv, LOG_LEVEL: 'warn' });
    expect(described).toMatchObject({
      log: { level: 'warn' },
      auth: { issuer: 'https://docs.munaxa.com', maxConcurrentSessions: 10 },
    });
  });

  it('cannot carry a secret, because none is in it', () => {
    // Excluded rather than redacted: a field that is not in the object cannot leak from it however
    // this rendering is later reused. The Redis URL is out too — `redis://user:pass@host` is a
    // credential the schema does not mark as one.
    const described = describePlatformConfig({
      ...baseEnv,
      REDIS_URL: 'redis://someone:hunter2@localhost:6379',
    });
    expect(JSON.stringify(described)).not.toContain('a'.repeat(32));
    expect(JSON.stringify(described)).not.toContain('hunter2');
  });
});
