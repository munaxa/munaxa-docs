import { Module } from '@nestjs/common';

import { DefaultStorageService } from './application/storage.service';
import {
  FILE_OBJECT_REPOSITORY,
  STORAGE_SERVICE,
  UPLOAD_SESSION_REPOSITORY,
} from './application/ports';
import { PrismaFileObjectRepository } from './infrastructure/prisma-file-object.repository';
import { PrismaUploadSessionRepository } from './infrastructure/prisma-upload-session.repository';
import { UploadsController } from './presentation/uploads.controller';

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
    { provide: FILE_OBJECT_REPOSITORY, useClass: PrismaFileObjectRepository },
    { provide: UPLOAD_SESSION_REPOSITORY, useClass: PrismaUploadSessionRepository },
    { provide: STORAGE_SERVICE, useClass: DefaultStorageService },
  ],
  exports: [STORAGE_SERVICE],
})
export class StorageModule {}
