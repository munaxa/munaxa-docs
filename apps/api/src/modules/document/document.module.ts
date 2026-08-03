import { Module } from '@nestjs/common';

/**
 * Document — What is this document, in the business's terms?
 *
 * **Owns:** Document, DocumentMetadataValue, Tag, Link, check-out Lock
 * **Depends on:** Library, Administration
 *
 * Nothing in core. It is the product's root aggregate and the busiest publisher of events.
 *
 * Phase 0.5 establishes this module's contracts: the repository and service interfaces in
 * `application/`, and the event contracts in `domain/events.ts`. The entities, use cases,
 * Prisma repositories and controllers that satisfy them are built by the phase that owns
 * this capability — see `README.md` in this folder.
 */
@Module({})
export class DocumentModule {}
