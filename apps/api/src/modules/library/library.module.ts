import { Module } from '@nestjs/common';

/**
 * Library — Where do documents live, and who may reach into that place?
 *
 * **Owns:** Library, Folder, ACL entries on both
 * **Depends on:** Organization, Administration
 *
 * `ACL_RESOLVER` — the ACL entries live here, so the resolution algorithm lives with them.
 *
 * Phase 0.5 establishes this module's contracts: the repository and service interfaces in
 * `application/`, and the event contracts in `domain/events.ts`. The entities, use cases,
 * Prisma repositories and controllers that satisfy them are built by the phase that owns
 * this capability — see `README.md` in this folder.
 */
@Module({})
export class LibraryModule {}
