import { Injectable } from '@nestjs/common';

import type { AnyId, AuditSubjectTypeKey } from '@edms/domain';
import type { Page, PageRequest } from '@edms/utils';

import { AuditExportService } from './audit-export.service';
import { AuditReadService } from './audit-read.service';
import { AuditVerificationService } from './audit-verification.service';
import type {
  AuditEventRecord,
  AuditExportRecord,
  AuditSearchCriteria,
  AuditService,
  ChainVerification,
} from './ports';

/**
 * `AUDIT_SERVICE`, bound at last.
 *
 * A facade over three services rather than one class doing all three, because reading the trail,
 * verifying it and exporting it are three genuinely different jobs with three different callers —
 * a controller, a scheduled lane and an export lane — and folding them together would give a
 * request-path class a dependency on the queue and the object store.
 *
 * The port exists all the same, and is bound rather than being deleted in favour of the three
 * concrete services, because it is the shape `13-audit-architecture.md` describes and the one a
 * later phase's use case should depend on. A dashboard asking "is the chain intact" should ask
 * audit, not `AuditVerificationService`.
 */
@Injectable()
export class DefaultAuditService implements AuditService {
  constructor(
    private readonly read: AuditReadService,
    private readonly verification: AuditVerificationService,
    private readonly exports: AuditExportService,
  ) {}

  timelineFor(
    subjectType: AuditSubjectTypeKey,
    subjectId: AnyId,
    page: PageRequest,
  ): Promise<Page<AuditEventRecord>> {
    return this.read.timelineFor(subjectType, subjectId, page);
  }

  search(criteria: AuditSearchCriteria, page: PageRequest): Promise<Page<AuditEventRecord>> {
    return this.read.search(criteria, page);
  }

  verifyChain(): Promise<ChainVerification> {
    return this.verification.verify();
  }

  requestExport(
    from: Date,
    to: Date,
    filters: Readonly<Record<string, string>>,
  ): Promise<AuditExportRecord> {
    return this.exports.request(from, to, filters);
  }
}
