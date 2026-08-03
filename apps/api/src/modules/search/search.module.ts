import { Module } from '@nestjs/common';

/**
 * Search — How is it found?
 *
 * **Owns:** The index projection, query, permission filtering, saved searches
 * **Depends on:** Document, Preview
 *
 * `SEARCH_PORT` and `INDEX_PORT` — PostgreSQL today, an external engine later, behind the same port.
 *
 * Phase 0.5 establishes this module's contracts: the repository and service interfaces in
 * `application/`, and the event contracts in `domain/events.ts`. The entities, use cases,
 * Prisma repositories and controllers that satisfy them are built by the phase that owns
 * this capability — see `README.md` in this folder.
 */
@Module({})
export class SearchModule {}
