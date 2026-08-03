import { Module } from '@nestjs/common';

/**
 * Dashboard — What needs my attention right now?
 *
 * **Owns:** Dashboard composition over other modules’ read models
 * **Depends on:** Reporting, Workflow, Document, Search
 *
 * Nothing in core.
 *
 * Phase 0.5 establishes this module's contracts: the repository and service interfaces in
 * `application/`, and the event contracts in `domain/events.ts`. The entities, use cases,
 * Prisma repositories and controllers that satisfy them are built by the phase that owns
 * this capability — see `README.md` in this folder.
 */
@Module({})
export class DashboardModule {}
