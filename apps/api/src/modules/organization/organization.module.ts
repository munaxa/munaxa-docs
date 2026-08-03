import { Module } from '@nestjs/common';

import { ORGANIZATION_SERVICE } from './application/ports';
import { DefaultOrganizationService } from './application/organization.service';
import { SCOPE_REPOSITORY } from './application/scope.ports';
import { PrismaScopeRepository } from './infrastructure/prisma-scope.repository';

/**
 * Organisation — Where in the business does this belong?
 *
 * **Owns:** Company, Entity, Branch, Department, and a person's department membership
 * **Depends on:** Identity
 *
 * This is the scope tree the permission model walks: TENANT → COMPANY → ENTITY → DEPARTMENT,
 * with departments nesting. A branch is a location rather than a level — its code appears in
 * document numbers and a department may sit at one, but permission does not flow through it.
 *
 * Phase 1 builds the tree and the read side the ACL resolver needs. Creating and editing the
 * nodes — with soft delete, restore, search and pagination — is Phase 2, which owns that
 * capability.
 */
@Module({
  providers: [
    { provide: SCOPE_REPOSITORY, useClass: PrismaScopeRepository },
    { provide: ORGANIZATION_SERVICE, useClass: DefaultOrganizationService },
  ],
  exports: [ORGANIZATION_SERVICE, SCOPE_REPOSITORY],
})
export class OrganizationModule {}
