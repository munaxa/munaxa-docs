import { describe, expect, it } from 'vitest';

import { ConfigurationError, loadConfig } from './configuration';

/**
 * The smallest environment that boots: a database, Redis, signing material, and *which tenant this
 * installation serves*. The last one is the addition Phase 2.5 makes non-optional — a process that
 * does not know which company it is serving has no database to connect to.
 */
const baseEnv = {
  DATABASE_URL: 'postgresql://app:secret@localhost:5432/edms',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  TENANT_ID: '019489f0-0000-7000-8000-000000000001',
  TENANT_SLUG: 'acme',
} satisfies NodeJS.ProcessEnv;

const CATALOGUE = JSON.stringify({
  defaults: { databaseUrlTemplate: 'postgresql://app:secret@localhost:5432/edms_{slug}' },
  tenants: [{ id: '019489f0-0000-7000-8000-000000000001', slug: 'acme' }],
});

describe('loadConfig', () => {
  it('applies documented defaults in development', () => {
    const config = loadConfig({ ...baseEnv });
    expect(config.app.port).toBe(3001);
    expect(config.storage.driver).toBe('NONE');
    expect(config.http.corsOrigins).toEqual(['http://localhost:3000']);
    // On premise unless stated otherwise: the default is the deployment a customer installs, not the
    // one we operate, because getting the hosted service's configuration wrong is our problem to
    // notice and getting a customer's wrong is theirs to suffer.
    expect(config.deployment.profile).toBe('ON_PREMISE');
    expect(config.deployment.tenants).toEqual({
      source: 'SINGLE',
      id: baseEnv.TENANT_ID,
      slug: 'acme',
    });
    expect(config.database.maxTenantClients).toBe(25);
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
      MAIL_DRIVER: 'RESEND',
      MAIL_RESEND_API_KEY: 're_ci_only_not_a_secret',
      MAIL_FROM_ADDRESS: 'docs@munaxa.com',
      AV_DRIVER: 'ICAP',
      AUDIT_CHECKPOINT_SECRET: 'c'.repeat(32),
      SIGNATURE_WITNESS_SECRET: 's'.repeat(32),
      CORS_ORIGINS: 'https://docs.munaxa.com,https://admin.munaxa.com',
    });
    expect(config.isProduction).toBe(true);
    expect(config.http.corsOrigins).toHaveLength(2);
    expect(config.http.openApiEnabled).toBe(false);
  });

  it('refuses a mail driver with no adapter behind it, in production', () => {
    // `MAIL_DRIVER` has named SMTP since Phase 0.5 and Phase 12 built the hosted adapter instead.
    // Refused at boot rather than at the first send, because a deployment that discovers its mail
    // driver has no adapter when an approver is not told about an approval has discovered it far
    // too late — the `OCR_DRIVER=HOSTED` precedent.
    expect(() =>
      loadConfig({
        ...baseEnv,
        NODE_ENV: 'production',
        OPENAPI_ENABLED: 'false',
        STORAGE_DRIVER: 'S3',
        STORAGE_BUCKET: 'edms-prod',
        MAIL_DRIVER: 'SMTP',
        MAIL_FROM_ADDRESS: 'docs@munaxa.com',
        AV_DRIVER: 'ICAP',
        AUDIT_CHECKPOINT_SECRET: 'c'.repeat(32),
        SIGNATURE_WITNESS_SECRET: 's'.repeat(32),
      }),
    ).toThrowError(ConfigurationError);
  });

  it('refuses a hosted mail driver with no key and no sender', () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        NODE_ENV: 'production',
        OPENAPI_ENABLED: 'false',
        STORAGE_DRIVER: 'S3',
        STORAGE_BUCKET: 'edms-prod',
        MAIL_DRIVER: 'RESEND',
        AV_DRIVER: 'ICAP',
        AUDIT_CHECKPOINT_SECRET: 'c'.repeat(32),
        SIGNATURE_WITNESS_SECRET: 's'.repeat(32),
      }),
    ).toThrowError(ConfigurationError);
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

/**
 * Which tenants a process serves is the first thing it has to know, so these are boot failures
 * rather than errors at the first request. Every one of them describes a configuration that would
 * otherwise look like a working installation.
 */
describe('describing which tenants this deployment serves', () => {
  it('takes a catalogue inline', () => {
    const config = loadConfig({
      ...baseEnv,
      TENANT_ID: undefined,
      TENANT_SLUG: undefined,
      TENANT_CATALOGUE: CATALOGUE,
    });
    expect(config.deployment.tenants).toEqual({ source: 'INLINE', document: CATALOGUE });
  });

  it('takes a catalogue as a file, for a mounted secret', () => {
    const config = loadConfig({
      ...baseEnv,
      TENANT_ID: undefined,
      TENANT_SLUG: undefined,
      TENANT_CATALOGUE_PATH: '/etc/munaxa/tenants.json',
    });
    expect(config.deployment.tenants).toEqual({
      source: 'FILE',
      path: '/etc/munaxa/tenants.json',
    });
  });

  it('refuses a single tenant and a catalogue together', () => {
    // Two answers to "which tenants exist" is worse than either answer: whichever the code happened
    // to read, the operator believes the other.
    expect(() => loadConfig({ ...baseEnv, TENANT_CATALOGUE: CATALOGUE })).toThrowError(
      ConfigurationError,
    );
  });

  it('refuses a catalogue given twice', () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        TENANT_ID: undefined,
        TENANT_SLUG: undefined,
        TENANT_CATALOGUE: CATALOGUE,
        TENANT_CATALOGUE_PATH: '/etc/munaxa/tenants.json',
      }),
    ).toThrowError(ConfigurationError);
  });

  it('refuses an installation that names no tenant at all', () => {
    expect(() => loadConfig({ ...baseEnv, TENANT_SLUG: undefined })).toThrowError(
      ConfigurationError,
    );
    expect(() => loadConfig({ ...baseEnv, TENANT_ID: undefined })).toThrowError(ConfigurationError);
  });

  it('refuses the cloud profile without a catalogue', () => {
    // The hosted service serves more than one company by definition, so a cloud process with one
    // tenant taken from its own environment is a misconfiguration that would only surface when the
    // second customer signed up.
    expect(() => loadConfig({ ...baseEnv, DEPLOYMENT_PROFILE: 'CLOUD' })).toThrowError(
      ConfigurationError,
    );
  });

  it('refuses a local filesystem in cloud production', () => {
    // Not shared between instances: a document uploaded through one is missing from the next.
    expect(() =>
      loadConfig({
        ...baseEnv,
        TENANT_ID: undefined,
        TENANT_SLUG: undefined,
        TENANT_CATALOGUE: CATALOGUE,
        DEPLOYMENT_PROFILE: 'CLOUD',
        NODE_ENV: 'production',
        OPENAPI_ENABLED: 'false',
        STORAGE_DRIVER: 'LOCAL',
        MAIL_DRIVER: 'RESEND',
        MAIL_RESEND_API_KEY: 're_ci_only_not_a_secret',
        MAIL_FROM_ADDRESS: 'docs@munaxa.com',
        AV_DRIVER: 'ICAP',
        AUDIT_CHECKPOINT_SECRET: 'c'.repeat(32),
        SIGNATURE_WITNESS_SECRET: 's'.repeat(32),
      }),
    ).toThrowError(ConfigurationError);
  });

  // Phase 16, and the same posture the checkpoint secret takes: a production deployment with
  // signatures enabled and no witness key would refuse every signing attempt at the use case,
  // discovered by whoever tries to sign rather than by whoever deploys.
  it('refuses production with no signature witness key', () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        NODE_ENV: 'production',
        OPENAPI_ENABLED: 'false',
        STORAGE_DRIVER: 'S3',
        STORAGE_BUCKET: 'edms-prod',
        MAIL_DRIVER: 'RESEND',
        MAIL_RESEND_API_KEY: 're_ci_only_not_a_secret',
        MAIL_FROM_ADDRESS: 'docs@munaxa.com',
        AV_DRIVER: 'ICAP',
        AUDIT_CHECKPOINT_SECRET: 'c'.repeat(32),
      }),
    ).toThrowError(ConfigurationError);
  });

  it('allows a local filesystem on premise, in production', () => {
    // One server, one directory, backed up with the database. Refusing it would mean telling a
    // customer to run object storage to use software installed on their own machine.
    const config = loadConfig({
      ...baseEnv,
      NODE_ENV: 'production',
      OPENAPI_ENABLED: 'false',
      STORAGE_DRIVER: 'LOCAL',
      MAIL_DRIVER: 'RESEND',
      MAIL_RESEND_API_KEY: 're_ci_only_not_a_secret',
      MAIL_FROM_ADDRESS: 'docs@munaxa.com',
      AV_DRIVER: 'ICAP',
      AUDIT_CHECKPOINT_SECRET: 'c'.repeat(32),
      SIGNATURE_WITNESS_SECRET: 's'.repeat(32),
    });
    expect(config.storage.driver).toBe('LOCAL');
  });

  it('refuses production without a key to sign audit checkpoints with', () => {
    // A checkpoint nobody signed is a row an attacker with the bucket can rewrite, which is
    // exactly the reading 13 §4 exists to prevent. Boot rather than incident is where that is
    // worth discovering.
    expect(() =>
      loadConfig({
        ...baseEnv,
        NODE_ENV: 'production',
        OPENAPI_ENABLED: 'false',
        STORAGE_DRIVER: 'LOCAL',
        MAIL_DRIVER: 'RESEND',
        MAIL_RESEND_API_KEY: 're_ci_only_not_a_secret',
        MAIL_FROM_ADDRESS: 'docs@munaxa.com',
        AV_DRIVER: 'ICAP',
      }),
    ).toThrowError(ConfigurationError);
  });

  it('buffers read auditing by default, and never past the hard bound', () => {
    const config = loadConfig({ ...baseEnv, AUDIT_READ_BUFFER_SIZE: '500' });
    // The hard bound is raised to meet a soft threshold above it rather than being silently
    // the smaller of the two: a buffer that flushed at 500 and fell back to synchronous writes
    // at 200 would never buffer anything.
    expect(config.audit.readBufferMax).toBe(1_000);
    expect(config.audit.readFlushIntervalMs).toBe(2_000);
    expect(config.audit.checkpointSecret).toBeNull();
  });
});
