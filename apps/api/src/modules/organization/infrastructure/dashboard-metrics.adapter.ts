import { Injectable } from '@nestjs/common';

import type { DashboardOrganizationMetrics } from '../../dashboard/application/ports';
import { requireTransaction } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';

/**
 * What the dashboard needs from Organization, answered by Organization.
 *
 * One number, and it is deliberately one number rather than "documents per department", which is
 * the tile somebody will ask for next. That is a parameterised, paged, exportable breakdown over
 * two modules' tables — a *report*, and Phase 15's, with the permission and the export the brief
 * gives it. A dashboard tile showing a count is this phase's; the moment the tile grows a
 * dimension it is the report engine wearing a card.
 */
@Injectable()
export class OrganizationDashboardMetrics implements DashboardOrganizationMetrics {
  async countDepartments(): Promise<number> {
    return requireTransaction().department.count({
      where: { tenantId: requireContext().tenantId, deletedAt: null },
    });
  }
}
