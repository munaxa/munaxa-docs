import { Module } from '@nestjs/common';

import { DocumentModule } from '../document/document.module';
import { LibraryModule } from '../library/library.module';
import { StorageModule } from '../storage/storage.module';
import {
  RECYCLE_BIN_REPOSITORY,
  RECYCLE_BIN_SERVICE,
  RETENTION_SERVICE,
} from './application/ports';
import { DefaultRecycleBinService } from './application/recycle-bin.service';
import { DefaultRetentionService } from './application/retention.service';
import { PrismaRecycleBinRepository } from './infrastructure/prisma-recycle-bin.repository';
import { RetentionLaneConsumer } from './infrastructure/retention-lane.consumer';
import { RetentionModule } from './retention.module';
import {
  LegalHoldsController,
  RecycleBinController,
  RetentionController,
} from './presentation/retention.controller';

/**
 * Retention's execution half — the side of the capability that sits *above* Document.
 *
 * `RetentionModule` (same folder) is the half Document depends on: the repositories, the legal
 * hold, the scheduler seam. This module is the half that depends on Document: the sweep asks it to
 * purge through `DOCUMENT_DISPOSITION` (which Document binds and exports, the same inversion as
 * `REVISION_WRITER`), the reaper asks Storage to reclaim through `BLOB_REAPER` (bound and exported
 * by Storage), and the recycle bin reads across both. Splitting the capability at exactly this
 * line is what keeps the module graph acyclic without a `forwardRef` — see `retention.module.ts`.
 *
 * `LibraryModule` is imported for the folder restore path the recycle bin links to, and because
 * the bin's read joins `folder` for paths — the read-model exception `README.md` records.
 */
@Module({
  imports: [RetentionModule, DocumentModule, LibraryModule, StorageModule],
  controllers: [RecycleBinController, LegalHoldsController, RetentionController],
  providers: [
    { provide: RECYCLE_BIN_REPOSITORY, useClass: PrismaRecycleBinRepository },
    { provide: RECYCLE_BIN_SERVICE, useClass: DefaultRecycleBinService },
    { provide: RETENTION_SERVICE, useClass: DefaultRetentionService },
    RetentionLaneConsumer,
  ],
  exports: [RETENTION_SERVICE],
})
export class DispositionModule {}
