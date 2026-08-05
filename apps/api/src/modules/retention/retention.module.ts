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

import { RetentionDashboardMetrics } from './infrastructure/dashboard-metrics.adapter';
import { DASHBOARD_RETENTION_METRICS } from '../dashboard/application/ports';
import { REPORT_RETENTION_SOURCE } from '../reporting/application/ports';
import { RetentionReportSource } from './infrastructure/report-source.adapter';
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
    // Phase 15: the expired-documents report, behind `retention:manage` as well as `report:view`
    // — the disposition queue's own gate, so a report cannot be the looser of two doors.
    { provide: REPORT_RETENTION_SOURCE, useClass: RetentionReportSource },
    // Phase 13: the disposition queue's depth and the live-hold count, each behind its own
    // permission at the composing service — see `dashboard-metrics.adapter.ts`.
    { provide: DASHBOARD_RETENTION_METRICS, useClass: RetentionDashboardMetrics },
    { provide: RETENTION_SCHEDULE_REPOSITORY, useClass: PrismaRetentionScheduleRepository },
    { provide: LEGAL_HOLD_REPOSITORY, useClass: PrismaLegalHoldRepository },
    { provide: TOMBSTONE_REPOSITORY, useClass: PrismaTombstoneRepository },
    { provide: RETENTION_POLICY_READER, useClass: PrismaRetentionPolicyReader },
    { provide: LEGAL_HOLD_SERVICE, useClass: DefaultLegalHoldService },
    { provide: RETENTION_SCHEDULER, useClass: RetentionSchedulerService },
  ],
  exports: [
    REPORT_RETENTION_SOURCE,
    DASHBOARD_RETENTION_METRICS,
    RETENTION_SCHEDULE_REPOSITORY,
    LEGAL_HOLD_REPOSITORY,
    TOMBSTONE_REPOSITORY,
    RETENTION_POLICY_READER,
    LEGAL_HOLD_SERVICE,
    RETENTION_SCHEDULER,
  ],
})
export class RetentionModule {}
