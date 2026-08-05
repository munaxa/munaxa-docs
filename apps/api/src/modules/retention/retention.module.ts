import { Module } from '@nestjs/common';

import { DefaultLegalHoldService } from './application/legal-hold.service';
import {
  LEGAL_HOLD_REPOSITORY,
  LEGAL_HOLD_SERVICE,
  RETENTION_POLICY_READER,
  RETENTION_SCHEDULE_REPOSITORY,
  RETENTION_SCHEDULER,
  TOMBSTONE_REPOSITORY,
} from './application/ports';
import { RetentionSchedulerService } from './application/retention-scheduler.service';
import {
  PrismaLegalHoldRepository,
  PrismaRetentionPolicyReader,
  PrismaRetentionScheduleRepository,
  PrismaTombstoneRepository,
} from './infrastructure/prisma-retention.repositories';

/**
 * Retention — How long must it be kept, and what happens then?
 *
 * **Owns:** RetentionSchedule, LegalHold, DocumentTombstone, disposition review, purge
 * **Depends on:** Document, Storage — *from the other half*; see below.
 *
 * The capability is composed as **two Nest modules over one folder**, and the split is the
 * module graph's, not the domain's. This half is what sits *below* Document: the schedule
 * repositories, the legal hold, and the scheduler seam Document's own delete, restore and
 * publication call inside their transactions. The other half — `DispositionModule` — is what
 * sits *above* Document: the sweep that asks Document to purge, the recycle bin that reads
 * across modules, the lane consumer and the HTTP surface. One module doing both would need
 * Document and be needed by it, which is the cycle `forwardRef` exists to paper over and this
 * product prefers not to have.
 */
@Module({
  providers: [
    { provide: RETENTION_SCHEDULE_REPOSITORY, useClass: PrismaRetentionScheduleRepository },
    { provide: LEGAL_HOLD_REPOSITORY, useClass: PrismaLegalHoldRepository },
    { provide: TOMBSTONE_REPOSITORY, useClass: PrismaTombstoneRepository },
    { provide: RETENTION_POLICY_READER, useClass: PrismaRetentionPolicyReader },
    { provide: LEGAL_HOLD_SERVICE, useClass: DefaultLegalHoldService },
    { provide: RETENTION_SCHEDULER, useClass: RetentionSchedulerService },
  ],
  exports: [
    RETENTION_SCHEDULE_REPOSITORY,
    LEGAL_HOLD_REPOSITORY,
    TOMBSTONE_REPOSITORY,
    RETENTION_POLICY_READER,
    LEGAL_HOLD_SERVICE,
    RETENTION_SCHEDULER,
  ],
})
export class RetentionModule {}
