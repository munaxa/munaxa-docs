import { Module } from '@nestjs/common';

import { OrganizationModule } from '../organization/organization.module';
import {
  LIBRARY_ADMIN_REPOSITORY,
  LIBRARY_ADMIN_SERVICE,
} from './application/administration.ports';
import { LibraryAdminService } from './application/library-admin.service';
import { PrismaLibraryAdminRepository } from './infrastructure/prisma-library-admin.repository';
import {
  FolderAdminController,
  LibraryAdminController,
} from './presentation/library-admin.controller';

/**
 * Library — Where do documents live, and who may reach into that place?
 *
 * **Owns:** Library, Folder, ACL entries on both
 * **Depends on:** Organization, Administration
 *
 * `ACL_RESOLVER` — the ACL entries live here, so the resolution algorithm lives with them. Still
 * unbound: Phase 2 builds the tree a grant is *made on*, not the grants or the walk. Until the
 * resolver arrives, `DENY_ALL` is what answers object-level questions, which is the correct answer
 * to give while there is nothing to grant.
 *
 * Phase 0.5 established this module's contracts. Phase 2 builds the place: libraries owned by exactly
 * one organisation node, each created with its root folder in one transaction, and a folder tree with
 * the depth ceiling, cascade delete and exact restore that
 * [`05-database-design.md` §4](../../../../../docs/architecture/05-database-design.md) specifies.
 *
 * `OrganizationModule` is imported for one reason: a library's owner node is resolved through
 * `ORGANIZATION_SERVICE` before it is written. That is a call to another module's *application
 * service*, which is the only legal direction — never into its repositories or its Prisma models.
 */
@Module({
  imports: [OrganizationModule],
  controllers: [LibraryAdminController, FolderAdminController],
  providers: [
    { provide: LIBRARY_ADMIN_REPOSITORY, useClass: PrismaLibraryAdminRepository },
    { provide: LIBRARY_ADMIN_SERVICE, useClass: LibraryAdminService },
  ],
})
export class LibraryModule {}
