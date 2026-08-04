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
  WORKFLOW_DOCUMENT_GATE,
  WORKFLOW_ENGINE,
  WORKFLOW_ENGINE_REPOSITORY,
} from './application/ports';
import { WORKFLOW_VERSION_READER } from './application/version-reader.port';
import { WorkflowAdminService } from './application/workflow-admin.service';
import { WorkflowEngine } from './application/workflow-engine.service';
import { WorkflowTimers } from './application/workflow-timers.service';
import { DocumentContextAdapter } from './infrastructure/document-context.adapter';
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
 */
@Module({
  imports: [DocumentModule, IdentityModule, AdministrationModule],
  controllers: [WorkflowAdminController, ApprovalController],
  providers: [
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
  exports: [WORKFLOW_ENGINE, APPROVAL_SERVICE, APPROVAL_QUERY_REPOSITORY],
})
export class WorkflowModule {}
