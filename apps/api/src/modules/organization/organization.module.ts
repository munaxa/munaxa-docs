import { Module } from '@nestjs/common';

import {
  ORGANIZATION_SERVICE,
  SCOPE_ADMIN_REPOSITORY,
  SCOPE_ADMIN_SERVICE,
} from './application/ports';
import { DefaultOrganizationService } from './application/organization.service';
import { ScopeAdminService } from './application/scope-admin.service';
import { SCOPE_REPOSITORY } from './application/scope.ports';
import { PrismaScopeAdminRepository } from './infrastructure/prisma-scope-admin.repository';
import { PrismaScopeRepository } from './infrastructure/prisma-scope.repository';
import { OrganizationController } from './presentation/organization.controller';

import { OrganizationDashboardMetrics } from './infrastructure/dashboard-metrics.adapter';
import { DASHBOARD_ORGANIZATION_METRICS } from '../dashboard/application/ports';
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
 * Phase 1 built the tree and the read side the ACL resolver needs. Phase 2 adds the writes:
 * creating, editing, moving, soft-deleting and restoring nodes, with search, paging and filtering,
 * and the two events that tell the permission caches ancestry changed.
 *
 * Only the read side is exported. A module that could reach `ScopeAdminService` could reorganise the
 * tree while resolving an ACL against it, and nothing outside this module has any business doing
 * that — the administration surface has exactly one consumer, the controller below.
 */
@Module({
  controllers: [OrganizationController],
  providers: [
    // Phase 13: the department count behind the administrator tile.
    { provide: DASHBOARD_ORGANIZATION_METRICS, useClass: OrganizationDashboardMetrics },
    { provide: SCOPE_REPOSITORY, useClass: PrismaScopeRepository },
    { provide: ORGANIZATION_SERVICE, useClass: DefaultOrganizationService },
    { provide: SCOPE_ADMIN_REPOSITORY, useClass: PrismaScopeAdminRepository },
    { provide: SCOPE_ADMIN_SERVICE, useClass: ScopeAdminService },
  ],
  exports: [DASHBOARD_ORGANIZATION_METRICS, ORGANIZATION_SERVICE, SCOPE_REPOSITORY],
})
export class OrganizationModule {}
