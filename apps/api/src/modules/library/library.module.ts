import { Global, Module } from '@nestjs/common';

import { ACL_RESOLVER } from '../../core/authorization/acl-resolver.port';
import { OrganizationModule } from '../organization/organization.module';
import {
  LIBRARY_ADMIN_REPOSITORY,
  LIBRARY_ADMIN_SERVICE,
} from './application/administration.ports';
import { FolderContentsRegistry } from './application/folder-contents.port';
import { LibraryAdminService } from './application/library-admin.service';
import { DefaultPermissionService } from './application/permission.service';
import {
  ACL_REPOSITORY,
  ACL_SUBJECT_NAME_READER,
  PERMISSION_SERVICE,
  SCOPE_CHAIN_READER,
} from './application/ports';
import { PrismaAclRepository } from './infrastructure/prisma-acl.repository';
import { PrismaAclSubjectNameReader } from './infrastructure/prisma-acl-subject-name.reader';
import { PrismaAclResolver } from './infrastructure/prisma-acl.resolver';
import { PrismaLibraryAdminRepository } from './infrastructure/prisma-library-admin.repository';
import { PrismaScopeChainReader } from './infrastructure/prisma-scope-chain.reader';
import {
  FolderAdminController,
  LibraryAdminController,
} from './presentation/library-admin.controller';
import { PermissionsController } from './presentation/permissions.controller';

/**
 * Library — Where do documents live, and who may reach into that place?
 *
 * **Owns:** Library, Folder, ACL entries on both, the ACL resolver
 * **Depends on:** Organization, Administration
 *
 * `ACL_RESOLVER` — the ACL entries live here, so the resolution algorithm lives with them.
 * Phase 8 binds the first real resolver, because the search index must materialise its
 * `acl_subjects` from "the same pure resolver the API uses" and a resolver that denies
 * everything cannot serve an index anybody may see. What it resolves is what genuinely exists —
 * the tenant-level role grant, closed by default; the entries and the walk arrive with the
 * phase that builds grants, extending this binding rather than replacing anything above it
 * (see `infrastructure/prisma-acl.resolver.ts`).
 *
 * The module is `@Global` for the same reason `AuditModule` is: the port is declared in
 * `core/` because core's own `AclGuard` asks it, and core may not import a module — so the
 * owning module carries the binding to it, exactly as Audit carries `AUDIT_WRITER`.
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
@Global()
@Module({
  imports: [OrganizationModule],
  controllers: [LibraryAdminController, FolderAdminController, PermissionsController],
  providers: [
    { provide: LIBRARY_ADMIN_REPOSITORY, useClass: PrismaLibraryAdminRepository },
    { provide: LIBRARY_ADMIN_SERVICE, useClass: LibraryAdminService },
    { provide: ACL_RESOLVER, useClass: PrismaAclResolver },
    // Phase 14: the entries the resolver has been walking a chain of since Phase 8 without ever
    // finding one, the reader that assembles the chain, and the service that edits both.
    { provide: ACL_REPOSITORY, useClass: PrismaAclRepository },
    { provide: ACL_SUBJECT_NAME_READER, useClass: PrismaAclSubjectNameReader },
    { provide: SCOPE_CHAIN_READER, useClass: PrismaScopeChainReader },
    { provide: PERMISSION_SERVICE, useClass: DefaultPermissionService },
    // Phase 10: the slot the folder-delete cascade reaches its documents through. Declared here,
    // filled by Document at boot — a registry rather than a binding, because Document already
    // imports this module and plain DI cannot express the inversion without a cycle (see
    // `application/folder-contents.port.ts`).
    FolderContentsRegistry,
  ],
  // Phase 3: a document sits in a folder, and Document resolves the folder through this service
  // rather than by reading the tree. The folder tree is the chain the ACL resolver walks, and a
  // second reader of it would be a second opinion about who can see what.
  exports: [LIBRARY_ADMIN_SERVICE, ACL_RESOLVER, PERMISSION_SERVICE, FolderContentsRegistry],
})
export class LibraryModule {}
