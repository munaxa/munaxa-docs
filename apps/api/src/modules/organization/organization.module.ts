import { Module } from '@nestjs/common';

/**
 * Organization — Where in the organisation does this belong?
 *
 * **Owns:** Company, Entity, Branch, Department — the scope tree
 * **Depends on:** Identity
 *
 * Nothing in core. It publishes scope-tree changes, which invalidate permission caches.
 *
 * Phase 0.5 establishes this module's contracts: the repository and service interfaces in
 * `application/`, and the event contracts in `domain/events.ts`. The entities, use cases,
 * Prisma repositories and controllers that satisfy them are built by the phase that owns
 * this capability — see `README.md` in this folder.
 */
@Module({})
export class OrganizationModule {}
