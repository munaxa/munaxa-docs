import { Global, Module } from '@nestjs/common';

import { API_PREFIX } from '@edms/contracts';

import { APP_CONFIG, type AppConfig } from '../core/config';
import { LOGGER, type Logger } from '../core/observability/logger';
import { ANTIVIRUS_PORT } from '../ports/antivirus.port';
import { CACHE_PORT } from '../ports/cache.port';
import { CLOCK_PORT, type ClockPort } from '../ports/clock.port';
import { NOTIFICATION_PORT, type NotificationPort } from '../ports/notification.port';
import { OUTBOUND_HTTP_PORT } from '../ports/outbound-http.port';
import { QUEUE_CONSUMER, QUEUE_PORT } from '../ports/queue.port';
import { OCR_PORT, type OcrPort } from '../ports/ocr.port';
import { INDEX_PORT, SEARCH_PORT, type IndexPort } from '../ports/search.port';
import { STORAGE_PORT, type StoragePort } from '../ports/storage.port';
import { TENANT_REGISTRY, type TenantRegistry } from '../core/tenancy/tenant-registry.port';
import { RedisCacheAdapter } from './cache/redis-cache.adapter';
import { BullMqQueueAdapter } from './queue/bullmq.adapter';
import { SystemClockAdapter } from './clock/system-clock.adapter';
import { AllowListedHttpAdapter } from './providers/allow-listed-http.adapter';
import { ResendMailAdapter } from './providers/resend-mail.adapter';
import { TesseractOcrAdapter } from './providers/tesseract-ocr.adapter';
import {
  UnconfiguredAntivirusAdapter,
  UnconfiguredNotificationAdapter,
  UnconfiguredOcrAdapter,
  UnconfiguredStorageAdapter,
} from './providers/unconfigured.adapters';
import { PostgresIndexAdapter } from './search/postgres-index.adapter';
import { PostgresSearchAdapter } from './search/postgres-search.adapter';
import { LocalTransferController } from './storage/local-transfer.controller';
import { LOCAL_TRANSFER_PATH } from './storage/local-transfer-token';
import { LocalStorageAdapter } from './storage/local.adapter';
import { S3StorageAdapter } from './storage/s3.adapter';
import type { SigningCredentials } from './storage/sigv4';
import { LOCAL_STORAGE_ADAPTER } from './storage/storage.tokens';
import { PLACED_SEARCH_PORT, TenantScopedSearch } from './tenancy/tenant-scoped-search';
import { TenantScopedStorage } from './tenancy/tenant-scoped-storage';

/**
 * The composition root for external capabilities.
 *
 * This is the only file in the application that knows which provider is in use. A use case
 * asks for `STORAGE_PORT`; whether that is S3, Azure Blob or a local directory is decided
 * here, from validated configuration (`docs/architecture/02-backend-architecture.md` §4).
 *
 * **Phase 4 binds the queue**, which is the first thing in the product to run work outside a
 * request. `QUEUE_PORT` was declared in Phase 0.5 with its lanes and retry policies written down
 * beside it and nothing bound to it, so the outbox accumulated events nothing consumed and the
 * deadline half of the workflow architecture did not exist. One adapter provides both halves —
 * producing and consuming — because they share a connection pool and a shutdown.
 *
 * Phase 0.5 bound the two adapters that carry no vendor decision — the system clock and Redis —
 * and bound every other port to the adapter that fails naming the environment variable that would
 * configure it. **Phase 3 fills in storage**, which is the first port to get a real vendor adapter:
 * one filesystem driver for a single-server installation, and one S3 driver that serves AWS, MinIO
 * and Cloudflare R2 alike. Everything else is unchanged and still refuses.
 *
 * **Phase 2.5 wraps storage and search in their tenant scoping here**, and that placement is the point.
 * The vendor adapters written in this phase are bound *underneath* the wrapper, so they inherit
 * isolation neither of them had to implement — and cannot opt out of, because nothing above this file
 * can reach them directly ([ADR-0015](../../../../docs/architecture/adr/0015-database-per-tenant.md)).
 * Neither adapter contains the word "tenant", which is the check that this held.
 */

/** AWS's own endpoint for a region, when a deployment names none of its own. */
function defaultS3Endpoint(region: string): string {
  return `https://s3.${region}.amazonaws.com`;
}

function storageAdapterFor(config: AppConfig, clock: ClockPort): StoragePort {
  switch (config.storage.driver) {
    case 'LOCAL':
      return new LocalStorageAdapter({
        root: config.storage.localRoot,
        transferUrl: localTransferUrl(config),
        // The deployment's own signing material rather than a second secret to manage. The token
        // is domain-separated inside `local-transfer-token.ts`, so a transfer capability is not a
        // token anything else will accept.
        signingSecret: config.auth.accessSecret,
        now: () => clock.now(),
      });
    case 'S3':
    case 'R2':
      // One adapter, two driver names. They differ in endpoint and addressing style, which is
      // configuration — so `R2` selects the same code and exists as its own value because naming
      // the provider in an environment file is how an operator says what they are running.
      return new S3StorageAdapter({
        driver: config.storage.driver,
        bucket: requireBucket(config),
        region: config.storage.region ?? 'us-east-1',
        endpoint:
          config.storage.endpoint ?? defaultS3Endpoint(config.storage.region ?? 'us-east-1'),
        forcePathStyle: config.storage.forcePathStyle,
        credentials: signingCredentials(config),
        now: () => clock.now(),
      });
    // AZURE_BLOB and GCS each get their adapter in the phase that needs one; until then the
    // driver is accepted by configuration and fails at first use, rather than silently
    // pretending to store bytes.
    case 'NONE':
    default:
      return new UnconfiguredStorageAdapter();
  }
}

/**
 * The filesystem adapter, or null.
 *
 * Built twice under `LOCAL` — once as the port, once here — which is deliberate rather than
 * careless: the transfer endpoints need the adapter's own streaming methods, and re-resolving the
 * bound `STORAGE_PORT` would hand them the tenant-scoping wrapper instead. The wrapper is the one
 * thing the endpoints must *not* have, because by the time a token is redeemed the key it names is
 * already scoped and prefixing it a second time would address `acme/acme/…`.
 */
function localAdapterFor(config: AppConfig, clock: ClockPort): LocalStorageAdapter | null {
  return config.storage.driver === 'LOCAL'
    ? new LocalStorageAdapter({
        root: config.storage.localRoot,
        transferUrl: localTransferUrl(config),
        signingSecret: config.auth.accessSecret,
        now: () => clock.now(),
      })
    : null;
}

function localTransferUrl(config: AppConfig): string {
  // The API cannot infer its own public address from the socket it listens on when it sits behind
  // a reverse proxy, so `STORAGE_PUBLIC_URL` says it. Falling back to the loopback address is
  // right for development and wrong in front of a proxy, which is why the variable exists.
  const base = (config.storage.publicUrl ?? `http://localhost:${String(config.app.port)}`).replace(
    /\/$/,
    '',
  );
  return `${base}/${API_PREFIX}/${LOCAL_TRANSFER_PATH}`;
}

/**
 * The credentials the S3 adapter signs with.
 *
 * Empty strings when the deployment supplies none, which is a legitimate configuration — an EC2
 * instance role or an IRSA-annotated service account issues them out of band. Signing with empty
 * material produces a signature the store rejects, which is the right failure: it names the request
 * that failed rather than crashing the process at boot for a deployment shape that works.
 *
 * Reading an instance metadata endpoint to discover them is deliberately not done here. That is a
 * network call this product never intended to make, and it is what the SDK would have brought with
 * it — see `sigv4.ts`.
 */
function signingCredentials(config: AppConfig): SigningCredentials {
  const credentials = config.storage.credentials;
  if (credentials === null) {
    return { accessKeyId: '', secretAccessKey: '' };
  }
  return {
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    ...(credentials.sessionToken !== null && { sessionToken: credentials.sessionToken }),
  };
}

/**
 * The OCR engine, chosen by configuration.
 *
 * `HOSTED` is accepted by the schema — Phase 0.5's promise of a cloud engine — and refused
 * here, at boot, because no hosted adapter exists yet and a value that boots but never
 * extracts would be `NONE` wearing a different name. The refusal names the variable.
 */
function ocrAdapterFor(config: AppConfig): OcrPort {
  switch (config.providers.ocr) {
    case 'TESSERACT':
      return new TesseractOcrAdapter(config.ocr.tesseractPath);
    case 'HOSTED':
      throw new Error('OCR_DRIVER=HOSTED has no adapter yet; use TESSERACT or NONE.');
    case 'NONE':
    default:
      return new UnconfiguredOcrAdapter();
  }
}

/**
 * The search engine, chosen by configuration — Phase 8 replaces the unconfigured refusal.
 *
 * `OPENSEARCH` is accepted by the schema — ADR-0008's promise of the second generation — and
 * refused here, at boot, because no OpenSearch adapter exists yet and a value that boots but
 * never answers would be an outage discovered at the first query rather than the deployment.
 * The refusal names the variable — the `OCR_DRIVER=HOSTED` precedent, exactly.
 */
/**
 * The mail provider, chosen by configuration — Phase 12 replaces the unconfigured refusal.
 *
 * `SMTP` is accepted by the schema — 18 §3's promise for on-premise — and never reaches this
 * function: `configuration.ts` refuses it at boot, naming the decision, because a value that
 * boots and then fails at the first send is an outage discovered when an approver is not told
 * about an approval. The `OCR_DRIVER=HOSTED` precedent, exactly.
 *
 * `NONE` keeps the Phase 0.5 refusal, which is the correct behaviour for an unconfigured
 * deployment and the one CI runs under: the delivery service records a refusal like any other
 * failure, and nothing is silently dropped.
 */
function mailAdapterFor(config: AppConfig): NotificationPort {
  if (config.providers.mail !== 'RESEND') {
    return new UnconfiguredNotificationAdapter();
  }
  const { resendApiKey, fromAddress } = config.mail;
  if (resendApiKey === null || fromAddress === null) {
    // Production validation already requires both. This covers the other environments, where a
    // half-configured driver would otherwise send from `undefined`.
    throw new Error('MAIL_DRIVER=RESEND requires MAIL_RESEND_API_KEY and MAIL_FROM_ADDRESS.');
  }
  return new ResendMailAdapter({
    apiKey: resendApiKey,
    endpoint: config.mail.resendEndpoint,
    fromAddress,
    fromName: config.mail.fromName,
    timeoutMs: config.mail.timeoutMs,
  });
}

function searchAdapterFor(config: AppConfig): PostgresSearchAdapter {
  switch (config.providers.search) {
    case 'OPENSEARCH':
      throw new Error('SEARCH_DRIVER=OPENSEARCH has no adapter yet; use POSTGRES.');
    case 'POSTGRES':
    default:
      return new PostgresSearchAdapter();
  }
}

function indexAdapterFor(config: AppConfig, clock: ClockPort): IndexPort {
  switch (config.providers.search) {
    case 'OPENSEARCH':
      throw new Error('SEARCH_DRIVER=OPENSEARCH has no adapter yet; use POSTGRES.');
    case 'POSTGRES':
    default:
      return new PostgresIndexAdapter(clock);
  }
}

function requireBucket(config: AppConfig): string {
  // Boot validation already refuses a remote driver with no bucket, so this narrows rather than
  // decides — and it throws rather than defaulting, because a default bucket name is a default
  // place to put another customer's documents.
  if (config.storage.bucket === null) {
    throw new Error('STORAGE_BUCKET is required for this storage driver.');
  }
  return config.storage.bucket;
}

@Global()
@Module({
  controllers: [LocalTransferController],
  providers: [
    SystemClockAdapter,
    RedisCacheAdapter,
    BullMqQueueAdapter,
    { provide: CLOCK_PORT, useExisting: SystemClockAdapter },
    { provide: CACHE_PORT, useExisting: RedisCacheAdapter },
    // Both halves of the queue are one adapter, and one instance: the producers and the workers
    // share a connection pool and a shutdown, and two instances would mean two of each.
    { provide: QUEUE_PORT, useExisting: BullMqQueueAdapter },
    { provide: QUEUE_CONSUMER, useExisting: BullMqQueueAdapter },
    {
      // The vendor adapter, chosen by configuration, then wrapped so every key it is given carries the
      // tenant's prefix and every key it answers with is checked against it.
      provide: STORAGE_PORT,
      useFactory: (config: AppConfig, registry: TenantRegistry, clock: ClockPort): StoragePort =>
        new TenantScopedStorage(storageAdapterFor(config, clock), registry),
      inject: [APP_CONFIG, TENANT_REGISTRY, CLOCK_PORT],
    },
    {
      provide: LOCAL_STORAGE_ADAPTER,
      useFactory: localAdapterFor,
      inject: [APP_CONFIG, CLOCK_PORT],
    },
    // The engine, chosen by configuration, bound *underneath* the tenant scoping — the
    // Phase 2.5 wrapper is untouched, so the adapter inherits isolation it cannot opt out of.
    {
      provide: PLACED_SEARCH_PORT,
      useFactory: searchAdapterFor,
      inject: [APP_CONFIG],
    },
    { provide: SEARCH_PORT, useClass: TenantScopedSearch },
    {
      provide: INDEX_PORT,
      useFactory: indexAdapterFor,
      inject: [APP_CONFIG, CLOCK_PORT],
    },
    // `PREVIEW_PORT` and `RENDERER_REGISTRY` are bound by the Preview module, which is what
    // "binds in core" has meant in its contract since Phase 0.5: the renderers are that
    // module's plugins, and this file would otherwise have to import them all.
    { provide: OCR_PORT, useFactory: ocrAdapterFor, inject: [APP_CONFIG] },
    { provide: NOTIFICATION_PORT, useFactory: mailAdapterFor, inject: [APP_CONFIG] },
    { provide: ANTIVIRUS_PORT, useClass: UnconfiguredAntivirusAdapter },
    // Phase 17: the only thing in the product that may reach a tenant-chosen address, and the
    // whole of 17 §6's SSRF row. One binding, so there is no second way out.
    {
      // A factory rather than `useClass`, because the adapter's last two constructor arguments are
      // the network itself — `fetch` and the DNS resolver — defaulted to the globals so that
      // production wiring names neither, and injectable by a test so that a suite asserting the
      // SSRF checks never opens a socket. Nest cannot supply a defaulted parameter it has no token
      // for, so the two are left to their defaults here.
      provide: OUTBOUND_HTTP_PORT,
      useFactory: (config: AppConfig, log: Logger) => new AllowListedHttpAdapter(config, log),
      inject: [APP_CONFIG, LOGGER],
    },
  ],
  exports: [
    CLOCK_PORT,
    CACHE_PORT,
    QUEUE_PORT,
    QUEUE_CONSUMER,
    STORAGE_PORT,
    LOCAL_STORAGE_ADAPTER,
    SEARCH_PORT,
    INDEX_PORT,
    OCR_PORT,
    NOTIFICATION_PORT,
    OUTBOUND_HTTP_PORT,
    ANTIVIRUS_PORT,
  ],
})
export class InfrastructureModule {}
