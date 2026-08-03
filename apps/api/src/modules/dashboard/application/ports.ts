import type { DocumentId, UserId } from '@edms/domain';

/**
 * The dashboard owns no data.
 *
 * It composes what other modules already expose — the approval inbox, recent documents,
 * overdue tasks — so a widget cannot become a second, divergent definition of "overdue".
 */
export const DASHBOARD_SERVICE = Symbol('DashboardService');

export interface DashboardSummary {
  readonly pendingApprovals: number;
  readonly overdueApprovals: number;
  readonly myDrafts: number;
  readonly recentDocumentIds: readonly DocumentId[];
}

export interface DashboardService {
  summaryFor(userId: UserId): Promise<DashboardSummary>;
}
