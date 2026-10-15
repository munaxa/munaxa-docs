import { Module } from '@nestjs/common';

import { BLOB_REAPER } from '../retention/application/ports';
import { DefaultStorageService } from './application/storage.service';
import {
  DOWNLOAD_STAGING,
  FILE_OBJECT_REPOSITORY,
  STORAGE_SERVICE,
  UPLOAD_SESSION_REPOSITORY,
  VERIFIED_DOWNLOAD_DELIVERY,
  DOWNLOAD_REDEEMERS,
  DownloadRedeemerRegistry,
} from './application/ports';
import { DefaultVerifiedDownloadDelivery } from './application/verified-download.delivery';
import { DownloadLimitsCheck } from './application/download-limits.check';
import { LocalDownloadStaging } from './infrastructure/download-staging';
import { APP_CONFIG, type AppConfig } from '../../core/config';
import { LOGGER, type Logger } from '../../core/observability/logger';
import { PrismaFileObjectRepository } from './infrastructure/prisma-file-object.repository';
import { PrismaUploadSessionRepository } from './infrastructure/prisma-upload-session.repository';
import { StorageBlobReaper } from './infrastructure/blob-reaper.adapter';
import { UploadsController } from './presentation/uploads.controller';

import { StorageDashboardMetrics } from './infrastructure/dashboard-metrics.adapter';
import { DASHBOARD_STORAGE_METRICS } from '../dashboard/application/ports';
import { REPORT_STORAGE_SOURCE } from '../reporting/application/ports';
import { StorageReportSource } from './infrastructure/report-source.adapter';
/**
 * Storage — Where are the bytes, and are they intact?
 *
 * **Owns:** FileObject, UploadSession, dedupe, the antivirus gate
 * **Depends on:** — (the StoragePort only)
 *
 * Nothing in core. It is the only module that calls `STORAGE_PORT` and `ANTIVIRUS_PORT`, and Phase
 * 3 is where that stops being a statement about a contract and becomes a statement about code:
 * both ports now resolve to something that works.
 *
 * `STORAGE_SERVICE` is exported because Document and Preview need it — one to attach a blob to a
 * revision and to count the reference, the other to store a thumbnail. Both go through this
 * service; neither has ever seen `file_object`, and the boundary lint is what keeps it that way.
 *
 * What is deliberately *not* here: any method that returns bytes. Upload and download are
 * presigned and direct to storage
 * ([ADR-0007](../../../../../docs/architecture/adr/0007-storage-port-and-content-addressing.md)).
 */
@Module({
  controllers: [UploadsController],
  providers: [
    // Phase 15: the storage report — bytes held and bytes referenced, per library. Still no quota.
    { provide: REPORT_STORAGE_SOURCE, useClass: StorageReportSource },
    // Phase 13: bytes held and bytes deduplication saved. No quota — that is ADR-0012's and
    // Phase 21's, and Phase 10 recorded its absence deliberately.
    { provide: DASHBOARD_STORAGE_METRICS, useClass: StorageDashboardMetrics },
    { provide: FILE_OBJECT_REPOSITORY, useClass: PrismaFileObjectRepository },
    { provide: UPLOAD_SESSION_REPOSITORY, useClass: PrismaUploadSessionRepository },
    { provide: STORAGE_SERVICE, useClass: DefaultStorageService },
    // ADR-0026 §10: verified downloads. The staging directory is created (0700) and emptied when
    // the process starts, so nothing a crashed process staged survives it.
    {
      provide: DOWNLOAD_STAGING,
      useFactory: async (config: AppConfig, logger: Logger) => {
        const staging = new LocalDownloadStaging(config.download.stagingDir);
        const removed = await staging.prepare();
        if (removed > 0) {
          logger.warn('Removed download staging files left by an earlier process', { removed });
        }
        return staging;
      },
      inject: [APP_CONFIG, LOGGER],
    },
    { provide: VERIFIED_DOWNLOAD_DELIVERY, useClass: DefaultVerifiedDownloadDelivery },
    // One registry per application: each module that owns a kind of download registers its
    // redeemer here when it starts, and the redemption route dispatches on the token's kind.
    // A factory, not a value: a value is created once when this file loads and would be shared by
    // every application booted in the process, so a second boot would find its kinds taken.
    { provide: DOWNLOAD_REDEEMERS, useFactory: () => new DownloadRedeemerRegistry() },
    // Says at start-up which configured limits allow files no download can verify (D-7).
    DownloadLimitsCheck,
    // Phase 10: Retention's `BLOB_REAPER`, implemented by the module that owns the bytes — the
    // same inversion as `REVISION_WRITER`. The only code in the product that removes an object
    // from storage, and the first caller `StoragePort.delete` has had outside the upload path.
    { provide: BLOB_REAPER, useClass: StorageBlobReaper },
  ],
  exports: [
    DASHBOARD_STORAGE_METRICS,
    REPORT_STORAGE_SOURCE,
    STORAGE_SERVICE,
    BLOB_REAPER,
    VERIFIED_DOWNLOAD_DELIVERY,
    DOWNLOAD_REDEEMERS,
  ],
})
export class StorageModule {}
