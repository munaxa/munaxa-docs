import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { DocumentModule } from '../document/document.module';
import { IdentityModule } from '../identity/identity.module';
import { OrganizationModule } from '../organization/organization.module';
import { RetentionModule } from '../retention/retention.module';
import { StorageModule } from '../storage/storage.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { ReportDefinitionService } from './application/report-definition.service';
import { ReportExportService } from './application/report-export.service';
import { DefaultReportingService } from './application/reporting.service';
import {
  REPORTING_SERVICE,
  REPORT_DEFINITION_REPOSITORY,
  REPORT_EXPORT_REPOSITORY,
} from './application/ports';
import { ReportingLaneConsumer } from './infrastructure/reporting-lane.consumer';
import {
  PrismaReportDefinitionRepository,
  PrismaReportExportRepository,
} from './infrastructure/prisma-reporting.repositories';
import { ReportingController } from './presentation/reporting.controller';

/**
 * Reporting — What is the state of the whole?
 *
 * **Owns:** ReportDefinition, ReportExport, the report catalogue, the export lane
 * **Depends on:** Document, Workflow, Storage, Identity, Organization, Retention, Audit
 *
 * Nothing in core.
 *
 * ---
 *
 * ## Seven imports, and none of them is a table
 *
 * The Phase 0.5 header said this module depends on "Search, Audit, Workflow". One of those turned
 * out right. **Search is not a dependency**: the index holds documents and nothing else, so seven of
 * the ten reports could not be answered from it, and the three that could would be answered from a
 * projection that is only eventually consistent with the record — a report that disagrees with the
 * document it describes is worse than a slow one. What the capability actually needed was every
 * module that owns rows a report is about, which is what it imports.
 *
 * Each of those provides a `REPORT_*_SOURCE`, declared in *this* module's vocabulary and
 * implemented over the predicate its own list is built from — the inverted dependency the dashboard
 * uses eight times, applied to queries rather than to counts. `application/ports.ts` records why
 * that shape was chosen over materialised read models and over the search index, and what each
 * would have cost.
 *
 * ## It has an `infrastructure/` and the dashboard does not
 *
 * Phase 13 enforced "the dashboard owns no data" by giving the module nothing to own data *with* —
 * no `infrastructure/`, no reachable Prisma import. This module cannot do that, because it genuinely
 * owns two tables: a saved definition and an export job. So the rule is narrower and still
 * structural: **`infrastructure/` reaches `report_definition` and `report_export` and nothing else**,
 * and the unit test asserts the model count rather than trusting review. A `document.findMany` here
 * would be the second definition of what a document population is, and the report — a file somebody
 * prints and circulates — would be the copy people believed.
 *
 * ## What a definition holds, and why it matters more than it looks
 *
 * Parameters. Never a query, a column list or a table name. That is the enforcement of the
 * constraint at the head of `application/ports.ts`: a tenant that could author a query would be a
 * tenant that could pin a column, and no migration would ever again be a decision this repository
 * alone could take.
 */
@Module({
  imports: [
    DocumentModule,
    WorkflowModule,
    StorageModule,
    IdentityModule,
    OrganizationModule,
    RetentionModule,
    AuditModule,
  ],
  controllers: [ReportingController],
  providers: [
    { provide: REPORT_DEFINITION_REPOSITORY, useClass: PrismaReportDefinitionRepository },
    { provide: REPORT_EXPORT_REPOSITORY, useClass: PrismaReportExportRepository },
    { provide: REPORTING_SERVICE, useClass: DefaultReportingService },
    ReportDefinitionService,
    ReportExportService,
    ReportingLaneConsumer,
  ],
  exports: [REPORTING_SERVICE],
})
export class ReportingModule {}
