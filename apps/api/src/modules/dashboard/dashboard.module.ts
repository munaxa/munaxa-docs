import { Module } from '@nestjs/common';

import { DocumentModule } from '../document/document.module';
import { IdentityModule } from '../identity/identity.module';
import { NotificationModule } from '../notification/notification.module';
import { OrganizationModule } from '../organization/organization.module';
import { RetentionModule } from '../retention/retention.module';
import { StorageModule } from '../storage/storage.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { DefaultDashboardService } from './application/dashboard.service';
import { DASHBOARD_SERVICE } from './application/ports';
import { DashboardController } from './presentation/dashboard.controller';

/**
 * Dashboard — What needs my attention right now?
 *
 * **Owns:** Dashboard composition over other modules' read models
 * **Depends on:** Document, Workflow, Storage, Identity, Organization, Retention, Notification
 *
 * Nothing in core.
 *
 * ---
 *
 * **This module has no `domain/` and no `infrastructure/`, and that is the design rather than an
 * omission.** Its README's rule — "the dashboard owns no data; it composes what other modules
 * already expose, so a widget cannot become a second, divergent definition of 'overdue'" — is a
 * constraint that a dashboard can violate on every widget, and the only way to keep it is to give
 * the module nothing to violate it *with*. There is no Prisma client reachable from anything under
 * `dashboard/`, so a count computed here is impossible rather than discouraged.
 *
 * What it needs is declared in `application/ports.ts` in the dashboard's own vocabulary, and
 * implemented by whichever module owns the table — the inverted dependency Document already uses
 * for `REVISION_WRITER` and `DOCUMENT_CONTENT_GATE`, applied seven times. Every adapter is built
 * from the predicate its own module's list is built from, so "4 drafts" and the four rows behind
 * the link are one query counted two ways.
 *
 * The Phase 0.5 header said this module depends on "Reporting, Workflow, Document, Search". Two of
 * those turned out wrong and the report says why. **Reporting** is bound to nothing and is Phase
 * 15's: a tile showing a count is this phase's, a parameterised, paged, exportable query is not,
 * and depending on `REPORTING_SERVICE` would have meant either building it here or importing an
 * empty module. **Search** is not a dependency either — every dashboard figure is an aggregate over
 * a table, and none of them is a query anybody typed. What the capability actually needed was
 * Storage, Identity, Organization, Retention and Notification, which is what it imports.
 */
@Module({
  imports: [
    DocumentModule,
    WorkflowModule,
    StorageModule,
    IdentityModule,
    OrganizationModule,
    RetentionModule,
    NotificationModule,
  ],
  controllers: [DashboardController],
  providers: [{ provide: DASHBOARD_SERVICE, useClass: DefaultDashboardService }],
  exports: [DASHBOARD_SERVICE],
})
export class DashboardModule {}
