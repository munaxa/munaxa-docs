import { describe, expect, it } from 'vitest';

import { ConfigurationError, loadConfig } from './configuration';

const baseEnv = {
  DATABASE_URL: 'postgresql://app:secret@localhost:5432/edms',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
} satisfies NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('applies documented defaults in development', () => {
    const config = loadConfig({ ...baseEnv });
    expect(config.app.port).toBe(3001);
    expect(config.storage.driver).toBe('NONE');
    expect(config.http.corsOrigins).toEqual(['http://localhost:3000']);
  });

  it('refuses to start production on placeholder providers', () => {
    expect(() =>
      loadConfig({ ...baseEnv, NODE_ENV: 'production', OPENAPI_ENABLED: 'false' }),
    ).toThrowError(ConfigurationError);
  });

  it('starts production when every provider is named', () => {
    const config = loadConfig({
      ...baseEnv,
      NODE_ENV: 'production',
      OPENAPI_ENABLED: 'false',
      STORAGE_DRIVER: 'S3',
      STORAGE_BUCKET: 'edms-prod',
      MAIL_DRIVER: 'SMTP',
      AV_DRIVER: 'ICAP',
      CORS_ORIGINS: 'https://docs.munaxa.com,https://admin.munaxa.com',
    });
    expect(config.isProduction).toBe(true);
    expect(config.http.corsOrigins).toHaveLength(2);
    expect(config.http.openApiEnabled).toBe(false);
  });

  it('never echoes a rejected value in the error', () => {
    try {
      loadConfig({ ...baseEnv, JWT_ACCESS_SECRET: 'too-short' });
      expect.unreachable('expected a configuration error');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as Error).message).not.toContain('too-short');
    }
  });

  it('requires the settings that have no safe default', () => {
    expect(() => loadConfig({})).toThrowError(ConfigurationError);
  });

  it('reads an empty variable as unset, not as an empty value', () => {
    // `.env.example` writes `STORAGE_ENDPOINT=` for an optional value left unfilled, as does
    // most deployment tooling. Treating that as a value made the file we ship as a starting
    // point fail to boot on "STORAGE_ENDPOINT: Invalid url".
    const config = loadConfig({
      ...baseEnv,
      STORAGE_ENDPOINT: '',
      STORAGE_BUCKET: '',
      STORAGE_REGION: '   ',
    });

    expect(config.storage.endpoint).toBeNull();
    expect(config.storage.bucket).toBeNull();
    expect(config.storage.region).toBeNull();
  });

  it('still rejects a variable that is present and wrong', () => {
    expect(() => loadConfig({ ...baseEnv, STORAGE_ENDPOINT: 'not-a-url' })).toThrowError(
      ConfigurationError,
    );
  });
});
