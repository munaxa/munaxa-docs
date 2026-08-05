import { Injectable } from '@nestjs/common';

import type { DashboardRetentionMetrics } from '../../dashboard/application/ports';
import { requireTransaction } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';
import { dueScheduleWhere } from './prisma-retention.repositories';

/**
 * What the dashboard needs from Retention, answered by Retention.
 *
 * Two numbers, and they are gated by two different permissions rather than one, because they
 * answer to two different people. `retention:manage` holds the disposition queue: how much is due
 * for review is a records-management workload. `legal-hold:manage` holds the register: *which*
 * records are held, and on what matter, is counsel's business — the retention controller already
 * reads holds behind the same grant as writing them, deliberately, and a dashboard that leaked the
 * count under the looser permission would undo that in one tile.
 *
 * The disposition count is unbounded where `RetentionService.listDue` is not. The sweep reads in
 * batches because it processes what it reads; a tile reports how much there is, and one that
 * stopped counting at the batch size would sit at "200" through a backlog of any size.
 */
@Injectable()
export class RetentionDashboardMetrics implements DashboardRetentionMetrics {
  async countDispositionsDue(at: Date): Promise<number> {
    return requireTransaction().retentionSchedule.count({
      where: dueScheduleWhere(requireContext().tenantId, at),
    });
  }

  async countLiveLegalHolds(): Promise<number> {
    return requireTransaction().legalHold.count({
      where: { tenantId: requireContext().tenantId, releasedAt: null },
    });
  }
}
