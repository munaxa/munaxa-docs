import { Module } from '@nestjs/common';

import { AdministrationModule } from '../administration/administration.module';
import { DocumentModule } from '../document/document.module';
import { IdentityModule } from '../identity/identity.module';
import {
  WORKFLOW_ADMIN_REPOSITORY,
  WORKFLOW_ADMIN_SERVICE,
} from './application/administration.ports';
import { ApprovalService } from './application/approval.service';
import { ParticipantResolver } from './application/participant-resolver';
import {
  APPROVAL_QUERY_REPOSITORY,
  APPROVAL_SERVICE,
  DOCUMENT_NUMBER_ALLOCATOR,
  WORKFLOW_CALENDAR,
  WORKFLOW_DIRECTORY,
  WORKFLOW_DELEGATION_GATE,
  WORKFLOW_DOCUMENT_GATE,
  WORKFLOW_ENGINE,
  WORKFLOW_ENGINE_REPOSITORY,
} from './application/ports';
import { WORKFLOW_VERSION_READER } from './application/version-reader.port';
import { WorkflowAdminService } from './application/workflow-admin.service';
import { WorkflowEngine } from './application/workflow-engine.service';
import { WorkflowTimers } from './application/workflow-timers.service';
import { DocumentContextAdapter } from './infrastructure/document-context.adapter';
import { WorkflowDelegationAdapter } from './infrastructure/workflow-delegation.adapter';
import { DocumentNumberAllocatorAdapter } from './infrastructure/document-number-allocator.adapter';
import { PrismaApprovalQueryRepository } from './infrastructure/prisma-approval-query.repository';
import { PrismaWorkflowAdminRepository } from './infrastructure/prisma-workflow-admin.repository';
import { PrismaWorkflowEngineRepository } from './infrastructure/prisma-workflow-engine.repository';
import { PrismaWorkflowVersionReader } from './infrastructure/prisma-workflow-version.reader';
import { WorkflowCalendarAdapter } from './infrastructure/workflow-calendar.adapter';
import { WorkflowDirectoryAdapter } from './infrastructure/workflow-directory.adapter';
import { WorkflowTimerConsumer } from './infrastructure/workflow-timer.consumer';
import { ApprovalController } from './presentation/approval.controller';
import { WorkflowAdminController } from './presentation/workflow-admin.controller';

import { WorkflowDashboardMetrics } from './infrastructure/dashboard-metrics.adapter';
import { DASHBOARD_APPROVAL_METRICS } from '../dashboard/application/ports';
import { REPORT_WORKFLOW_SOURCE } from '../reporting/application/ports';
import { WorkflowReportSource } from './infrastructure/report-source.adapter';
/**
 * Workflow — Who must agree before this becomes official?
 *
 * **Owns:** WorkflowDefinition and versions, Instance, Stage, ApprovalTask, escalation timers
 * **Depends on:** Document, Identity, Administration
 *
 * Nothing in core.
 *
 * Phase 2 built the **definitions** — versioned data, and the property everything here rests on: a
 * published version is immutable, because an instance binds to a version and editing one would
 * change the rules of an approval already running. Phase 4 builds the engine that reads one.
 *
 * ### What it imports, and why each one
 *
 * `DocumentModule` is the declared dependency, and the direction is ordinary rather than inverted:
 * Workflow sits below Document in the module order, so it may call it. It does so through
 * `WORKFLOW_DOCUMENT_GATE` — declared here, in this module's own vocabulary, implemented by an
 * adapter in this module's infrastructure that calls Document's application service. The port is
 * narrower than the service on purpose: the engine reads a document's context and moves its status,
 * and holding `DOCUMENT_SERVICE` would also let it move a document to another folder.
 *
 * `IdentityModule` and `AdministrationModule` answer the participant resolvers. Four of the seven
 * kinds are questions about people — role holders, department members, somebody's manager, whether
 * an account is usable — and one is a question about an approval group. `WORKFLOW_DIRECTORY`
 * composes both behind one interface, so the engine asks "who approves this" and never learns which
 * module answered.
 *
 * ### The seam Phase 4 cut, now bound
 *
 * `DOCUMENT_NUMBER_ALLOCATOR` — [ADR-0004] assigns a number at approval. Phase 4 declared the
 * port, left it deliberately unbound, and completed approvals with `numberAssigned: false`.
 * Phase 5 binds it to an adapter over Document's `DOCUMENT_NUMBER_SERVICE`, and binding it is
 * what made every completed approval numbered — the engine's completion path did not change,
 * which was the test of whether the seam was cut correctly. The port stays `@Optional` in the
 * engine, so a composition without the binding still produces the honest unnumbered outcome.
 *
 * `WORKFLOW_DELEGATION_GATE` — the second seam of the same kind, and the one Phase 4 named in a
 * comment. It binds to an adapter over Identity's `DELEGATION_SERVICE`, and binding it is what
 * relaxed the engine's single "the task belongs to you" check — which did not move, and did not
 * grow a second copy. It is `@Optional` in the engine and in `ApprovalController` for the same
 * reason the allocator is, with one difference worth stating: an unbound allocator degrades to an
 * unnumbered approval, and an unbound delegation gate degrades to the *stricter* behaviour, where
 * only the assignee decides. A seam whose absence loosens a control would be the wrong seam.
 */
@Module({
  imports: [DocumentModule, IdentityModule, AdministrationModule],
  controllers: [WorkflowAdminController, ApprovalController],
  providers: [
    // Phase 15: the approvals and workflow reports, composed with `approvalTaskWhere` so there is
    // still exactly one `dueAt < now` in this module, and reach-scoped through the document.
    { provide: REPORT_WORKFLOW_SOURCE, useClass: WorkflowReportSource },
    // Phase 13: the dashboard's approval counts, built from the inbox's own predicate — one
    // definition of "overdue" in this module and it is `approvalTaskWhere`.
    { provide: DASHBOARD_APPROVAL_METRICS, useClass: WorkflowDashboardMetrics },
    // --- Phase 2: definitions ---
    { provide: WORKFLOW_ADMIN_REPOSITORY, useClass: PrismaWorkflowAdminRepository },
    { provide: WORKFLOW_ADMIN_SERVICE, useClass: WorkflowAdminService },

    // --- Phase 4: the engine ---
    { provide: WORKFLOW_ENGINE_REPOSITORY, useClass: PrismaWorkflowEngineRepository },
    { provide: APPROVAL_QUERY_REPOSITORY, useClass: PrismaApprovalQueryRepository },
    { provide: WORKFLOW_VERSION_READER, useClass: PrismaWorkflowVersionReader },
    { provide: WORKFLOW_DOCUMENT_GATE, useClass: DocumentContextAdapter },
    // --- Phase 5: numbering, through the seam Phase 4 left for it ---
    { provide: DOCUMENT_NUMBER_ALLOCATOR, useClass: DocumentNumberAllocatorAdapter },
    { provide: WORKFLOW_DIRECTORY, useClass: WorkflowDirectoryAdapter },
    // --- Phase 11: the check Phase 4 said this phase relaxes ---
    { provide: WORKFLOW_DELEGATION_GATE, useClass: WorkflowDelegationAdapter },
    { provide: WORKFLOW_CALENDAR, useClass: WorkflowCalendarAdapter },
    ParticipantResolver,
    WorkflowTimers,
    WorkflowEngine,
    ApprovalService,
    { provide: WORKFLOW_ENGINE, useExisting: WorkflowEngine },
    { provide: APPROVAL_SERVICE, useExisting: ApprovalService },
    // Subscribes to the `workflow.timers` lane at boot, so a deadline that passes acts on itself.
    // Registered here rather than in the worker application because a consumer is a thin wrapper
    // around a use case, and this is the module that owns the use case.
    WorkflowTimerConsumer,
  ],
  exports: [
    REPORT_WORKFLOW_SOURCE,
    DASHBOARD_APPROVAL_METRICS,
    WORKFLOW_ENGINE,
    APPROVAL_SERVICE,
    APPROVAL_QUERY_REPOSITORY,
  ],
})
export class WorkflowModule {}
