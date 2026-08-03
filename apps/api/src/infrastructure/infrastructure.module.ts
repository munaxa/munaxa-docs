import { Global, Module } from '@nestjs/common';

import { APP_CONFIG, type AppConfig } from '../core/config';
import { ANTIVIRUS_PORT } from '../ports/antivirus.port';
import { CACHE_PORT } from '../ports/cache.port';
import { CLOCK_PORT } from '../ports/clock.port';
import { NOTIFICATION_PORT } from '../ports/notification.port';
import { OCR_PORT } from '../ports/ocr.port';
import { PREVIEW_PORT } from '../ports/preview.port';
import { SEARCH_PORT } from '../ports/search.port';
import { STORAGE_PORT, type StoragePort } from '../ports/storage.port';
import { TENANT_REGISTRY, type TenantRegistry } from '../core/tenancy/tenant-registry.port';
import { RedisCacheAdapter } from './cache/redis-cache.adapter';
import { SystemClockAdapter } from './clock/system-clock.adapter';
import {
  UnconfiguredAntivirusAdapter,
  UnconfiguredNotificationAdapter,
  UnconfiguredOcrAdapter,
  UnconfiguredPreviewAdapter,
  UnconfiguredSearchAdapter,
  UnconfiguredStorageAdapter,
} from './providers/unconfigured.adapters';
import { PLACED_SEARCH_PORT, TenantScopedSearch } from './tenancy/tenant-scoped-search';
import { TenantScopedStorage } from './tenancy/tenant-scoped-storage';

/**
 * The composition root for external capabilities.
 *
 * This is the only file in the application that knows which provider is in use. A use case
 * asks for `STORAGE_PORT`; whether that is S3, Azure Blob or a local directory is decided
 * here, from validated configuration (`docs/architecture/02-backend-architecture.md` §4).
 *
 * Phase 0.5 binds the two adapters that carry no vendor decision — the system clock and
 * Redis — and binds every other port to the adapter that fails naming the environment
 * variable that would configure it. A vendor adapter arrives with the phase that needs it:
 * writing it means adding a class and one case below, and touching nothing else.
 *
 * **Phase 2.5 wraps storage and search in their tenant scoping here**, and that placement is the point.
 * A vendor adapter written in a later phase is bound *underneath* the wrapper, so it inherits isolation
 * it never had to implement — and cannot opt out of, because nothing above this file can reach it
 * directly ([ADR-0015](../../../../docs/architecture/adr/0015-database-per-tenant.md)).
 */
function storageAdapterFor(config: AppConfig): StoragePort {
  switch (config.storage.driver) {
    // LOCAL, S3, AZURE_BLOB, R2 and GCS each get their adapter in the phase that needs it;
    // until then the driver is accepted by configuration and fails at first use, rather than
    // silently pretending to store bytes.
    case 'NONE':
    default:
      return new UnconfiguredStorageAdapter();
  }
}

@Global()
@Module({
  providers: [
    SystemClockAdapter,
    RedisCacheAdapter,
    { provide: CLOCK_PORT, useExisting: SystemClockAdapter },
    { provide: CACHE_PORT, useExisting: RedisCacheAdapter },
    {
      // The vendor adapter, chosen by configuration, then wrapped so every key it is given carries the
      // tenant's prefix and every key it answers with is checked against it.
      provide: STORAGE_PORT,
      useFactory: (config: AppConfig, registry: TenantRegistry): StoragePort =>
        new TenantScopedStorage(storageAdapterFor(config), registry),
      inject: [APP_CONFIG, TENANT_REGISTRY],
    },
    { provide: PLACED_SEARCH_PORT, useClass: UnconfiguredSearchAdapter },
    { provide: SEARCH_PORT, useClass: TenantScopedSearch },
    { provide: OCR_PORT, useClass: UnconfiguredOcrAdapter },
    { provide: NOTIFICATION_PORT, useClass: UnconfiguredNotificationAdapter },
    { provide: ANTIVIRUS_PORT, useClass: UnconfiguredAntivirusAdapter },
    { provide: PREVIEW_PORT, useClass: UnconfiguredPreviewAdapter },
  ],
  exports: [
    CLOCK_PORT,
    CACHE_PORT,
    STORAGE_PORT,
    SEARCH_PORT,
    OCR_PORT,
    NOTIFICATION_PORT,
    ANTIVIRUS_PORT,
    PREVIEW_PORT,
  ],
})
export class InfrastructureModule {}
