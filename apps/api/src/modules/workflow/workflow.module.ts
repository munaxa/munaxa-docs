import { Module } from '@nestjs/common';

/**
 * Workflow — Who must agree before this becomes official?
 *
 * **Owns:** WorkflowDefinition and versions, Instance, Stage, ApprovalTask, escalation timers
 * **Depends on:** Document, Identity
 *
 * Nothing in core.
 *
 * Phase 0.5 establishes this module's contracts: the repository and service interfaces in
 * `application/`, and the event contracts in `domain/events.ts`. The entities, use cases,
 * Prisma repositories and controllers that satisfy them are built by the phase that owns
 * this capability — see `README.md` in this folder.
 */
@Module({})
export class WorkflowModule {}
