import { Module } from '@nestjs/common';

import {
  WORKFLOW_ADMIN_REPOSITORY,
  WORKFLOW_ADMIN_SERVICE,
} from './application/administration.ports';
import { WorkflowAdminService } from './application/workflow-admin.service';
import { PrismaWorkflowAdminRepository } from './infrastructure/prisma-workflow-admin.repository';
import { WorkflowAdminController } from './presentation/workflow-admin.controller';

/**
 * Workflow — Who must agree before this becomes official?
 *
 * **Owns:** WorkflowDefinition and versions, Instance, Stage, ApprovalTask, escalation timers
 * **Depends on:** Document, Identity
 *
 * Nothing in core.
 *
 * Phase 2 builds the **definitions** — the data the engine reads — and the property the engine depends
 * on most: a published version is immutable, because an instance binds to a version and editing one
 * would change the rules of an approval already running
 * ([`07-workflow-architecture.md` §1](../../../../../docs/architecture/07-workflow-architecture.md)).
 *
 * It does not build the engine. Nothing here starts an instance, resolves a participant or decides a
 * task, and the version validator deliberately stops short of asking whether a resolver yields anybody
 * — that is a question about a particular document at a particular moment, answered at stage activation
 * (§2), where a resolver that yields nobody fails submission loudly rather than skipping a control.
 */
@Module({
  controllers: [WorkflowAdminController],
  providers: [
    { provide: WORKFLOW_ADMIN_REPOSITORY, useClass: PrismaWorkflowAdminRepository },
    { provide: WORKFLOW_ADMIN_SERVICE, useClass: WorkflowAdminService },
  ],
})
export class WorkflowModule {}
