import { Injectable } from '@nestjs/common';

import type { UserId } from '@edms/domain';

import type { CountBreakdown, DashboardApprovalMetrics } from '../../dashboard/application/ports';
import { RecordStamps } from '../../../core/persistence';
import { requireTransaction } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';
import { approvalTaskWhere } from './prisma-approval-query.repository';

/**
 * What the dashboard needs from Workflow, answered by Workflow.
 *
 * Both approval counts are built by `approvalTaskWhere` — the inbox's own predicate — so "3
 * pending, 1 overdue" on the dashboard and the three rows in the inbox are the same set. This
 * module owns what "overdue" means, and this is the seam that keeps it owning it.
 *
 * The tenant-wide pair is the same predicate with **no assignee at all**, which is exactly why it
 * is gated: `tenantCounts` answers "how much approval work exists in this organisation", which is
 * a question about everybody's inbox. Its caller checks `report:view` before asking; nothing here
 * decides that, because a read model that carried the permission would be a read model holding a
 * policy.
 */
@Injectable()
export class WorkflowDashboardMetrics implements DashboardApprovalMetrics {
  constructor(private readonly stamps: RecordStamps) {}

  async countsForAssignees(
    assigneeIds: readonly UserId[],
  ): Promise<{ readonly pending: number; readonly overdue: number }> {
    if (assigneeIds.length === 0) {
      // No subject means no inbox. Answering with the tenant-wide count here would turn an
      // unauthenticated composition into a disclosure of everybody's workload.
      return { pending: 0, overdue: 0 };
    }
    return this.counts(assigneeIds);
  }

  async tenantCounts(): Promise<{ readonly pending: number; readonly overdue: number }> {
    return this.counts([]);
  }

  async instanceCountsByState(): Promise<CountBreakdown> {
    const rows = await requireTransaction().workflowInstance.groupBy({
      by: ['state'],
      where: { tenantId: this.tenantId() },
      _count: { _all: true },
    });
    const entries = rows.map((row) => ({ key: row.state, count: row._count._all }));
    return { total: entries.reduce((sum, entry) => sum + entry.count, 0), entries };
  }

  private async counts(
    assigneeIds: readonly string[],
  ): Promise<{ readonly pending: number; readonly overdue: number }> {
    const tenantId = this.tenantId();
    const now = this.stamps.now();
    const tx = requireTransaction();

    // Two counts rather than one grouped query: "overdue" is a subset of "pending" rather than a
    // sibling of it, so a `groupBy` would need a computed column to split on and would answer with
    // a shape the caller has to reassemble anyway.
    const [pending, overdue] = await Promise.all([
      tx.approvalTask.count({ where: approvalTaskWhere({ tenantId, assigneeIds, now }) }),
      tx.approvalTask.count({
        where: approvalTaskWhere({ tenantId, assigneeIds, overdue: true, now }),
      }),
    ]);
    return { pending, overdue };
  }

  private tenantId(): string {
    return requireContext().tenantId;
  }
}
