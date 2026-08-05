import { Injectable } from '@nestjs/common';

import type { CountBreakdown, DashboardPeopleMetrics } from '../../dashboard/application/ports';
import { requireTransaction } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';

/**
 * What the dashboard needs from Identity, answered by Identity.
 *
 * Counts of accounts by state, and nothing that names one. A tile saying "3 disabled" is a fact
 * about the tenant's configuration; a tile saying *which three* would be a user list, which
 * Administration already serves behind `user:manage` with paging, search and an audit trail. The
 * dashboard links there rather than reproducing a slice of it.
 *
 * Deleted accounts are excluded rather than counted as a fourth state: a soft-deleted user is
 * removed, and folding them into "disabled" would make the number disagree with the list the tile
 * links to, which lists live rows.
 */
@Injectable()
export class IdentityDashboardMetrics implements DashboardPeopleMetrics {
  async countsByState(): Promise<CountBreakdown> {
    const rows = await requireTransaction().user.groupBy({
      by: ['status'],
      where: { tenantId: requireContext().tenantId, deletedAt: null },
      _count: { _all: true },
    });
    const entries = rows.map((row) => ({ key: row.status, count: row._count._all }));
    return { total: entries.reduce((sum, entry) => sum + entry.count, 0), entries };
  }
}
