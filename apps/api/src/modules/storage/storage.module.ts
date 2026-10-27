import { Module } from '@nestjs/common';

import { DocsLimit } from '@edms/domain';

import { UsageMeters } from '../../core/licensing/usage-meters';

import { BLOB_REAPER } from '../retention/application/ports';
import { DefaultStorageService } from './application/storage.service';
import {
  FILE_OBJECT_REPOSITORY,
  STORAGE_SERVICE,
  UPLOAD_SESSION_REPOSITORY,
  type FileObjectRepository,
} from './application/ports';
import { PrismaFileObjectRepository } from './infrastructure/prisma-file-object.repository';
import { PrismaUploadSessionRepository } from './infrastructure/prisma-upload-session.repository';
import { StorageBlobReaper } from './infrastructure/blob-reaper.adapter';
import { UploadsController } from './presentation/uploads.controller';

import { StorageDashboardMetrics } from './infrastructure/dashboard-metrics.adapter';
import { DASHBOARD_STORAGE_METRICS } from '../dashboard/application/ports';
import { REPORT_STORAGE_SOURCE } from '../reporting/application/ports';
import { StorageReportSource } from './infrastructure/report-source.adapter';
const STORAGE_USAGE_METER = Symbol('StorageUsageMeter');

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
    // Phase 10: Retention's `BLOB_REAPER`, implemented by the module that owns the bytes — the
    // same inversion as `REVISION_WRITER`. The only code in the product that removes an object
    // from storage, and the first caller `StoragePort.delete` has had outside the upload path.
    { provide: BLOB_REAPER, useClass: StorageBlobReaper },
    // ADR-0026: the stored-bytes level reported to the central subscription service — the same
    // count `enforceLimit` checks an upload against, so the two can never disagree.
    {
      provide: STORAGE_USAGE_METER,
      inject: [UsageMeters, FILE_OBJECT_REPOSITORY],
      useFactory: (meters: UsageMeters, files: FileObjectRepository) =>
        meters.register({
          metric: DocsLimit.STORAGE_BYTES,
          measure: () => files.quotaBytesInUse(),
        }),
    },
  ],
  exports: [DASHBOARD_STORAGE_METRICS, REPORT_STORAGE_SOURCE, STORAGE_SERVICE, BLOB_REAPER],
})
export class StorageModule {}
