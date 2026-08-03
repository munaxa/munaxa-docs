import { Module } from '@nestjs/common';

/**
 * Revision — What did it look like at each controlled point in time?
 *
 * **Owns:** DocumentRevision, compare, restore
 * **Depends on:** Document, Storage
 *
 * Nothing in core.
 *
 * Phase 0.5 establishes this module's contracts: the repository and service interfaces in
 * `application/`, and the event contracts in `domain/events.ts`. The entities, use cases,
 * Prisma repositories and controllers that satisfy them are built by the phase that owns
 * this capability — see `README.md` in this folder.
 */
@Module({})
export class RevisionModule {}
