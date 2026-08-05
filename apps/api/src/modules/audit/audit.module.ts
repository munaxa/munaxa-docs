import { Global, Module } from '@nestjs/common';

import { ACTIVITY_READER } from '../../core/activity/activity.port';
import { AUDIT_WRITER } from '../../core/audit/audit-writer.port';
import { READ_AUDIT_BUFFER } from '../../core/audit/read-audit.port';
import { StorageModule } from '../storage/storage.module';
import { AuditExportService } from './application/audit-export.service';
import { AuditReadService } from './application/audit-read.service';
import { AuditVerificationService } from './application/audit-verification.service';
import { DefaultAuditService } from './application/default-audit.service';
import {
  AUDIT_CHECKPOINT_STORE,
  AUDIT_EXPORT_REPOSITORY,
  AUDIT_REPOSITORY,
  AUDIT_SERVICE,
} from './application/ports';
import { AuditActivityReader } from './infrastructure/audit-activity.reader';
import { AuditLaneConsumer } from './infrastructure/audit-lane.consumer';
import { BufferedReadAuditWriter } from './infrastructure/buffered-read-audit.writer';
import { ChainedAuditWriter } from './infrastructure/chained-audit.writer';
import { PrismaAuditExportRepository } from './infrastructure/prisma-audit-export.repository';
import { PrismaAuditRepository } from './infrastructure/prisma-audit.repository';
import { StorageCheckpointStore } from './infrastructure/storage-checkpoint.store';
import { AuditController } from './presentation/audit.controller';

import { REPORT_AUDIT_SOURCE } from '../reporting/application/ports';
import { AuditReportSource } from './infrastructure/report-source.adapter';
/**
 * Audit — What happened, when, by whom — provably?
 *
 * **Owns:** AuditEvent, the hash chain, evidence export
 * **Depends on:** Storage (for the bundle's bytes and the checkpoint store), Library (through
 * `ACL_RESOLVER`, which is `@Global`)
 *
 * `AUDIT_WRITER` — it owns the chain, so it owns the only way to append to it. The port is
 * declared in `core/` because every module writes to it; the binding is here because only
 * this module knows how the chain is maintained. Global, for the same reason: audit is a
 * cross-cutting obligation, not a dependency a module should have to remember to import.
 *
 * Phase 1 implemented the write path. **Phase 9 builds the read path, and it is the read path that
 * makes the trail evidence rather than storage**: the timeline and the audit search of 13 §6, the
 * daily verification of §4 with its signed checkpoints kept outside the database, the evidence
 * export of §6, and the buffered read auditing §5 has specified since Phase 0 and which was
 * synchronous until now. `AUDIT_SERVICE` is no longer unbound.
 *
 * `StorageModule` is imported for two things a bundle needs and this module has no business
 * reimplementing: bytes and signed URLs. That is a genuine new dependency and it points the right
 * way — audit is above storage in `02 §3`'s order, and Storage knows nothing about audit beyond
 * writing its own rows through the port every module writes through.
 */
@Global()
@Module({
  imports: [StorageModule],
  controllers: [AuditController],
  providers: [
    // Phase 15: the audit report — a projection over `AuditReadService.search`, never a second
    // query beside it, and behind `audit:view` as well as `report:view`.
    { provide: REPORT_AUDIT_SOURCE, useClass: AuditReportSource },
    { provide: AUDIT_REPOSITORY, useClass: PrismaAuditRepository },
    { provide: AUDIT_EXPORT_REPOSITORY, useClass: PrismaAuditExportRepository },
    { provide: AUDIT_WRITER, useClass: ChainedAuditWriter },
    { provide: AUDIT_CHECKPOINT_STORE, useClass: StorageCheckpointStore },
    // Activity is a view of the trail, not a second log — see core/activity/activity.port.ts.
    { provide: ACTIVITY_READER, useClass: AuditActivityReader },
    // §5's buffer. Registered as a class as well as a token because it implements Nest's
    // lifecycle hooks, and a `useClass` binding alone would give the container two instances —
    // one holding the buffered events and one flushing an empty one on shutdown.
    BufferedReadAuditWriter,
    { provide: READ_AUDIT_BUFFER, useExisting: BufferedReadAuditWriter },
    AuditReadService,
    AuditVerificationService,
    AuditExportService,
    DefaultAuditService,
    { provide: AUDIT_SERVICE, useExisting: DefaultAuditService },
    AuditLaneConsumer,
  ],
  exports: [
    REPORT_AUDIT_SOURCE,
    AUDIT_WRITER,
    AUDIT_REPOSITORY,
    ACTIVITY_READER,
    READ_AUDIT_BUFFER,
    AUDIT_CHECKPOINT_STORE,
    AUDIT_SERVICE,
  ],
})
export class AuditModule {}
