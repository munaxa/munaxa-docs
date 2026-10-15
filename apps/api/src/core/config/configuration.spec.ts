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

/** The smallest environment that boots in production, so each refusal below varies one thing. */
const productionEnv = {
  ...baseEnv,
  NODE_ENV: 'production',
  OPENAPI_ENABLED: 'false',
  STORAGE_DRIVER: 'S3',
  STORAGE_BUCKET: 'edms-prod',
  MAIL_DRIVER: 'RESEND',
  MAIL_RESEND_API_KEY: 're_ci_only_not_a_secret',
  MAIL_FROM_ADDRESS: 'docs@munaxa.com',
  AV_DRIVER: 'ICAP',
  AV_ICAP_URL: 'icap://scanner.internal:1344/avscan',
  AUDIT_CHECKPOINT_SECRET: 'c'.repeat(32),
  SIGNATURE_WITNESS_SECRET: 's'.repeat(32),
  MFA_TOTP_SEALING_KEY: 'm'.repeat(32),
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
      AV_ICAP_URL: 'icap://scanner.internal:1344/avscan',
      AUDIT_CHECKPOINT_SECRET: 'c'.repeat(32),
      SIGNATURE_WITNESS_SECRET: 's'.repeat(32),
      MFA_TOTP_SEALING_KEY: 'm'.repeat(32),
      CORS_ORIGINS: 'https://docs.munaxa.com,https://admin.munaxa.com',
    });
    expect(config.isProduction).toBe(true);
    expect(config.http.corsOrigins).toHaveLength(2);
    expect(config.http.openApiEnabled).toBe(false);
  });

  it('refuses an SMTP driver with no relay to send through', () => {
    // Phase 18 built the SMTP adapter Phase 12 refused, so the boot refusal is no longer "there is
    // no adapter" — it is "this driver has not been told where to send". Caught at boot rather
    // than at the first send, because a deployment that discovers its mail configuration is
    // incomplete when an approver is not told about an approval has discovered it far too late.
    expect(() =>
      loadConfig({ ...productionEnv, MAIL_DRIVER: 'SMTP', MAIL_RESEND_API_KEY: undefined }),
    ).toThrowError(ConfigurationError);
  });

  it('starts production on a configured SMTP relay — 18 §3’s on-premise row', () => {
    const config = loadConfig({
      ...productionEnv,
      MAIL_DRIVER: 'SMTP',
      MAIL_RESEND_API_KEY: undefined,
      MAIL_SMTP_HOST: 'relay.internal',
      MAIL_SMTP_USERNAME: 'docs',
      MAIL_SMTP_PASSWORD: 'relay-secret',
    });

    expect(config.providers.mail).toBe('SMTP');
    expect(config.mail.smtp).toMatchObject({
      host: 'relay.internal',
      port: 587,
      security: 'STARTTLS',
      rejectUnauthorized: true,
    });
    // Derived from the web host rather than from the container's hostname, which never resolves.
    expect(config.mail.smtp.clientName).toBe('localhost');
  });

  it('refuses SMTP credentials on an unencrypted channel', () => {
    // Both mechanisms base64 the password, which is an encoding rather than a protection.
    expect(() =>
      loadConfig({
        ...baseEnv,
        MAIL_DRIVER: 'SMTP',
        MAIL_FROM_ADDRESS: 'docs@munaxa.com',
        MAIL_SMTP_HOST: 'relay.internal',
        MAIL_SMTP_SECURITY: 'NONE',
        MAIL_SMTP_USERNAME: 'docs',
        MAIL_SMTP_PASSWORD: 'relay-secret',
      }),
    ).toThrowError(ConfigurationError);
  });

  it('refuses half an SMTP credential, which is what a partly filled .env looks like', () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        MAIL_DRIVER: 'SMTP',
        MAIL_FROM_ADDRESS: 'docs@munaxa.com',
        MAIL_SMTP_HOST: 'relay.internal',
        MAIL_SMTP_USERNAME: 'docs',
      }),
    ).toThrowError(ConfigurationError);
  });

  it('refuses an unvalidated relay certificate in production', () => {
    expect(() =>
      loadConfig({
        ...productionEnv,
        MAIL_DRIVER: 'SMTP',
        MAIL_RESEND_API_KEY: undefined,
        MAIL_SMTP_HOST: 'relay.internal',
        MAIL_SMTP_REJECT_UNAUTHORIZED: 'false',
      }),
    ).toThrowError(ConfigurationError);
  });

  it('refuses an observability variable no exporter reads', () => {
    // A value that is accepted and ignored is worse than one that is refused: an operator who sets
    // it believes errors are reaching Sentry, and discovers otherwise during the incident.
    expect(() => loadConfig({ ...baseEnv, SENTRY_DSN: 'https://k@sentry.example/1' })).toThrowError(
      ConfigurationError,
    );
    expect(() =>
      loadConfig({ ...baseEnv, OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example' }),
    ).toThrowError(ConfigurationError);
  });

  it('trusts no proxy unless the deployment names one', () => {
    expect(loadConfig(baseEnv).http.trustProxy).toEqual({ kind: 'NONE' });
    expect(loadConfig({ ...baseEnv, TRUST_PROXY: '1' }).http.trustProxy).toEqual({
      kind: 'HOPS',
      hops: 1,
    });
    expect(loadConfig({ ...baseEnv, TRUST_PROXY: '10.0.0.0/8, loopback' }).http.trustProxy).toEqual(
      { kind: 'ADDRESSES', entries: ['10.0.0.0/8', 'loopback'] },
    );
  });

  it('refuses a proxy setting that would trust every address, or that is not an address', () => {
    // Trusting everyone lets any client write its own address and so choose its own rate limit.
    for (const value of ['true', '*', 'web-1.internal', '10.0.0.0/40']) {
      expect(() => loadConfig({ ...baseEnv, TRUST_PROXY: value })).toThrowError(/TRUST_PROXY/);
    }
  });

  it('refuses a metrics exporter with no scrape token', () => {
    // The body is queue depths, error rates and refusal counts by permission: operator-only.
    expect(() => loadConfig({ ...baseEnv, METRICS_DRIVER: 'PROMETHEUS' })).toThrowError(
      ConfigurationError,
    );

    const config = loadConfig({
      ...baseEnv,
      METRICS_DRIVER: 'PROMETHEUS',
      METRICS_SCRAPE_TOKEN: 't'.repeat(32),
    });
    expect(config.observability.metricsDriver).toBe('PROMETHEUS');
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
        AV_ICAP_URL: 'icap://scanner.internal:1344/avscan',
        AUDIT_CHECKPOINT_SECRET: 'c'.repeat(32),
        SIGNATURE_WITNESS_SECRET: 's'.repeat(32),
        MFA_TOTP_SEALING_KEY: 'm'.repeat(32),
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

describe('the tenant connection pool', () => {
  it('defaults DATABASE_POOL_SIZE to 10 per tenant and DATABASE_MAX_TENANT_CLIENTS to 25', () => {
    const config = loadConfig(baseEnv);
    expect(config.database.poolSize).toBe(10);
    expect(config.database.maxTenantClients).toBe(25);
  });

  it('respects an explicitly configured DATABASE_POOL_SIZE', () => {
    expect(loadConfig({ ...baseEnv, DATABASE_POOL_SIZE: '4' }).database.poolSize).toBe(4);
  });
});

/**
 * `STORAGE_CREDENTIALS_SOURCE=ECS_TASK_ROLE` signs S3 requests with the ECS task role instead of a
 * key pair. Every way of half-configuring it is a boot failure, so a deployment cannot start up
 * believing it uses the role while signing with something else.
 */
describe('the object-storage credential source', () => {
  const ecsEnv = {
    ...productionEnv,
    STORAGE_CREDENTIALS_SOURCE: 'ECS_TASK_ROLE',
    STORAGE_REGION: 'me-central-1',
    AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/task-id',
  } satisfies NodeJS.ProcessEnv;

  it('defaults to STATIC, with the configured key pair', () => {
    const config = loadConfig({
      ...productionEnv,
      STORAGE_ACCESS_KEY_ID: 'AKIA-STATIC',
      STORAGE_SECRET_ACCESS_KEY: 'static-secret',
    });
    expect(config.storage.credentialsSource).toBe('STATIC');
    expect(config.storage.credentials).toMatchObject({ accessKeyId: 'AKIA-STATIC' });
    expect(config.storage.ecsCredentialsRelativeUri).toBeNull();
  });

  it('accepts ECS_TASK_ROLE with S3 and the relative URI ECS sets', () => {
    const config = loadConfig(ecsEnv);
    expect(config.storage.credentialsSource).toBe('ECS_TASK_ROLE');
    expect(config.storage.ecsCredentialsRelativeUri).toBe('/v2/credentials/task-id');
    expect(config.storage.credentials).toBeNull();
  });

  it.each(['STORAGE_ACCESS_KEY_ID', 'STORAGE_SECRET_ACCESS_KEY', 'STORAGE_SESSION_TOKEN'])(
    'refuses %s alongside ECS_TASK_ROLE',
    (key) => {
      expect(() => loadConfig({ ...ecsEnv, [key]: 'configured' })).toThrowError(
        new RegExp(`${key} cannot be combined`),
      );
    },
  );

  it('refuses ECS_TASK_ROLE with R2', () => {
    expect(() =>
      loadConfig({
        ...ecsEnv,
        STORAGE_DRIVER: 'R2',
        STORAGE_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
      }),
    ).toThrowError(/cannot sign for Cloudflare R2/);
  });

  it('refuses ECS_TASK_ROLE with local storage', () => {
    expect(() => loadConfig({ ...ecsEnv, STORAGE_DRIVER: 'LOCAL' })).toThrowError(
      /STORAGE_CREDENTIALS_SOURCE/,
    );
  });

  it('refuses ECS_TASK_ROLE without AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', () => {
    expect(() =>
      loadConfig({ ...ecsEnv, AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: undefined }),
    ).toThrowError(/AWS_CONTAINER_CREDENTIALS_RELATIVE_URI/);
    expect(() =>
      loadConfig({ ...ecsEnv, AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '' }),
    ).toThrowError(/AWS_CONTAINER_CREDENTIALS_RELATIVE_URI/);
  });

  it('refuses a relative URI that is not a path', () => {
    for (const uri of ['v2/credentials', '//attacker.example/creds']) {
      expect(() =>
        loadConfig({ ...ecsEnv, AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: uri }),
      ).toThrowError(/AWS_CONTAINER_CREDENTIALS_RELATIVE_URI/);
    }
  });

  it('refuses a source it does not know', () => {
    expect(() =>
      loadConfig({ ...productionEnv, STORAGE_CREDENTIALS_SOURCE: 'INSTANCE_ROLE' }),
    ).toThrowError(/STORAGE_CREDENTIALS_SOURCE/);
  });
});

/**
 * Which tenants a process serves is the first thing it has to know, so these are boot failures
 * rather than errors at the first request. Every one of them describes a configuration that would
 * otherwise look like a working installation.
 */
describe('the antivirus driver — RC D-3', () => {
  // Production accepted `ICAP` and `HOSTED` while the port stayed bound to the unconfigured
  // adapter, so a deployment booted and scanned nothing. A driver name must now have an adapter and
  // an address, in every environment.
  it('starts production on ICAP with a scanner address, and parses it', () => {
    const config = loadConfig({ ...productionEnv });
    expect(config.providers.antivirus).toBe('ICAP');
    expect(config.antivirus.icap).toEqual({
      host: 'scanner.internal',
      port: 1344,
      service: '/avscan',
    });
    expect(config.antivirus.maxBytes).toBe(134_217_728);
    expect(config.antivirus.timeoutMs).toBe(120_000);
  });

  it('refuses ICAP with no scanner address, in production and out of it', () => {
    for (const env of [productionEnv, { ...baseEnv, AV_DRIVER: 'ICAP' }]) {
      expect(() => loadConfig({ ...env, AV_ICAP_URL: undefined })).toThrowError(/AV_ICAP_URL/);
    }
  });

  it('refuses HOSTED, which has no adapter, in production and out of it', () => {
    expect(() =>
      loadConfig({ ...productionEnv, AV_DRIVER: 'HOSTED', AV_ICAP_URL: undefined }),
    ).toThrowError(/AV_DRIVER=HOSTED has no adapter/);
    expect(() => loadConfig({ ...baseEnv, AV_DRIVER: 'HOSTED' })).toThrowError(/AV_DRIVER/);
  });

  it('still refuses NONE in production', () => {
    expect(() =>
      loadConfig({ ...productionEnv, AV_DRIVER: 'NONE', AV_ICAP_URL: undefined }),
    ).toThrowError(/AV_DRIVER must name a real provider/);
  });

  it.each([
    'http://scanner:1344/avscan',
    'icaps://scanner:11344/avscan',
    'icap://scanner:1344',
    'nonsense',
  ])('refuses the scanner address %s', (url) => {
    expect(() => loadConfig({ ...productionEnv, AV_ICAP_URL: url })).toThrowError(/AV_ICAP_URL/);
  });

  it('refuses a scanner address with no driver to use it, rather than ignoring it', () => {
    expect(() =>
      loadConfig({ ...baseEnv, AV_ICAP_URL: 'icap://scanner:1344/avscan' }),
    ).toThrowError(/AV_ICAP_URL is set but AV_DRIVER is not ICAP/);
  });

  it('bounds the bytes scanned at once and the wait for them (ADR-0026 §10, Phase A)', () => {
    const config = loadConfig(productionEnv);
    expect(config.antivirus.budgetBytes).toBe(268_435_456);
    expect(config.antivirus.queueTimeoutMs).toBe(60_000);
    expect(() => loadConfig({ ...productionEnv, AV_SCAN_BUDGET_BYTES: '1000' })).toThrowError(
      /AV_SCAN_BUDGET_BYTES/,
    );
  });

  it('refuses an orphan grace shorter than the longest a completion can take', () => {
    const config = loadConfig(productionEnv);
    expect(config.storage.orphanGraceSeconds).toBe(86_400);
    expect(config.storage.orphanSweepDryRun).toBe(false);
    // Default queue wait 60 s + scan timeout 120 s + a minute = 240 s.
    expect(() =>
      loadConfig({ ...productionEnv, STORAGE_ORPHAN_GRACE_SECONDS: '239' }),
    ).toThrowError(/STORAGE_ORPHAN_GRACE_SECONDS/);
    expect(
      loadConfig({ ...productionEnv, STORAGE_ORPHAN_GRACE_SECONDS: '240' }).storage
        .orphanGraceSeconds,
    ).toBe(240);
    expect(
      loadConfig({ ...productionEnv, STORAGE_ORPHAN_SWEEP_DRY_RUN: 'true' }).storage
        .orphanSweepDryRun,
    ).toBe(true);
  });

  it('sets verified downloads up with bounded staging, and refuses a file limit past it (ADR-0026 §10)', () => {
    const config = loadConfig(productionEnv);
    expect(config.download).toMatchObject({
      linkTtlSeconds: 60,
      stagingMaxBytes: 2_147_483_648,
      maxFileBytes: 1_073_741_824,
      maxConcurrent: 8,
      queueTimeoutMs: 30_000,
      minFreeBytes: 536_870_912,
    });
    expect(config.download.stagingDir).toMatch(/munaxa-download-staging$/u);
    expect(
      loadConfig({
        ...productionEnv,
        DOWNLOAD_STAGING_DIR: '/var/lib/munaxa-docs/download-staging',
      }).download.stagingDir,
    ).toBe('/var/lib/munaxa-docs/download-staging');
    expect(() =>
      loadConfig({
        ...productionEnv,
        DOWNLOAD_STAGING_MAX_BYTES: '1048576',
        DOWNLOAD_MAX_FILE_BYTES: '2097152',
      }),
    ).toThrowError(/DOWNLOAD_MAX_FILE_BYTES/);
    expect(() => loadConfig({ ...productionEnv, DOWNLOAD_LINK_TTL_SECONDS: '5' })).toThrowError(
      /DOWNLOAD_LINK_TTL_SECONDS/,
    );
    expect(() => loadConfig({ ...productionEnv, DOWNLOAD_MAX_CONCURRENT: '0' })).toThrowError(
      /DOWNLOAD_MAX_CONCURRENT/,
    );
  });

  it('bounds the scan size and the scan time', () => {
    expect(() => loadConfig({ ...productionEnv, AV_ICAP_MAX_BYTES: '10' })).toThrowError(
      /AV_ICAP_MAX_BYTES/,
    );
    expect(() => loadConfig({ ...productionEnv, AV_SCAN_TIMEOUT_MS: '0' })).toThrowError(
      /AV_SCAN_TIMEOUT_MS/,
    );
    expect(loadConfig({ ...productionEnv, AV_SCAN_TIMEOUT_MS: '30000' }).antivirus.timeoutMs).toBe(
      30_000,
    );
  });
});

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
        AV_ICAP_URL: 'icap://scanner.internal:1344/avscan',
        AUDIT_CHECKPOINT_SECRET: 'c'.repeat(32),
        SIGNATURE_WITNESS_SECRET: 's'.repeat(32),
        MFA_TOTP_SEALING_KEY: 'm'.repeat(32),
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
        AV_ICAP_URL: 'icap://scanner.internal:1344/avscan',
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
      AV_ICAP_URL: 'icap://scanner.internal:1344/avscan',
      AUDIT_CHECKPOINT_SECRET: 'c'.repeat(32),
      SIGNATURE_WITNESS_SECRET: 's'.repeat(32),
      MFA_TOTP_SEALING_KEY: 'm'.repeat(32),
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
        AV_ICAP_URL: 'icap://scanner.internal:1344/avscan',
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

/**
 * Previous values of the three long-lived secrets — R-3, R-4, R-5 of the Hetzner readiness report;
 * `docs/operations/key-rotation.md`.
 */
describe('rotated secrets', () => {
  const PREVIOUS = [
    ['MFA_TOTP_SEALING_PREVIOUS_KEYS', 'MFA_TOTP_SEALING_KEY'],
    ['AUDIT_CHECKPOINT_PREVIOUS_SECRETS', 'AUDIT_CHECKPOINT_SECRET'],
    ['SIGNATURE_WITNESS_PREVIOUS_SECRETS', 'SIGNATURE_WITNESS_SECRET'],
  ] as const;
  const older = 'o'.repeat(32);
  const oldest = 'p'.repeat(40);

  /** The message a refusal carries, so a test can check it never echoes a value. */
  function refusal(env: NodeJS.ProcessEnv): string {
    try {
      loadConfig(env);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      return (error as Error).message;
    }
    throw new Error('Expected the configuration to be refused.');
  }

  it('holds none unless told to', () => {
    const config = loadConfig({ ...productionEnv });
    expect(config.mfa.previousSealingKeys).toEqual([]);
    expect(config.audit.previousCheckpointSecrets).toEqual([]);
    expect(config.signature.previousWitnessSecrets).toEqual([]);
  });

  it('reads a comma-separated list, trimming spaces and empty entries', () => {
    const config = loadConfig({
      ...productionEnv,
      MFA_TOTP_SEALING_PREVIOUS_KEYS: ` ${older} , ${oldest},`,
      AUDIT_CHECKPOINT_PREVIOUS_SECRETS: older,
      SIGNATURE_WITNESS_PREVIOUS_SECRETS: `${older},${oldest}`,
    });
    expect(config.mfa.previousSealingKeys).toEqual([older, oldest]);
    expect(config.audit.previousCheckpointSecrets).toEqual([older]);
    expect(config.signature.previousWitnessSecrets).toEqual([older, oldest]);
    // The current values are untouched by the previous ones.
    expect(config.mfa.sealingKey).toBe('m'.repeat(32));
  });

  it.each(PREVIOUS)('refuses %s without a current value', (previous, current) => {
    const env: NodeJS.ProcessEnv = { ...baseEnv, [previous]: older };
    delete env[current];
    expect(refusal(env)).toContain(`${previous}: Previous values need ${current} to be set.`);
  });

  it.each(PREVIOUS)('refuses %s repeating the current value', (previous, current) => {
    const message = refusal({ ...productionEnv, [previous]: `${older},${productionEnv[current]}` });
    expect(message).toContain(`${previous}: Must not repeat ${current}.`);
    expect(message).not.toContain(productionEnv[current]);
  });

  it.each(PREVIOUS)('refuses %s naming one value twice', (previous) => {
    expect(refusal({ ...productionEnv, [previous]: `${older},${older}` })).toContain(
      `${previous}: Each previous value must appear once.`,
    );
  });

  it.each(PREVIOUS)('refuses a short value in %s without echoing it', (previous) => {
    const short = 'too-short-to-be-a-key';
    const message = refusal({ ...productionEnv, [previous]: short });
    expect(message).toContain(previous);
    expect(message).not.toContain(short);
  });

  it('holds at most eight', () => {
    const nine = Array.from({ length: 9 }, (_, index) => String(index).repeat(32)).join(',');
    expect(refusal({ ...productionEnv, SIGNATURE_WITNESS_PREVIOUS_SECRETS: nine })).toContain(
      'At most eight previous values are held.',
    );
  });
});
