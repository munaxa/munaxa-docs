import { Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';

import { AclGuard } from './acl.guard';
import { RbacGuard } from './rbac.guard';
import { RoutePermissionRegistry } from './route-permission.registry';

/**
 * The authorization chain.
 *
 * `ACL_RESOLVER` belongs to the Library module, which owns the ACL entries; `POLICY_EVALUATOR`
 * and `FEATURE_FLAGS` belong to Administration, which owns the settings behind them. Core
 * declares the questions and the modules supply the answers.
 *
 * Phase 8 replaced the deny-all placeholder with Library's real resolver, bound in
 * `LibraryModule` (`@Global`, the `AuditModule` pattern) because this module may not import a
 * module to reach the implementation. The default direction is unchanged: the resolver is
 * closed by default, so an unimplemented decision is still a refusal, never an allowance.
 */
@Global()
@Module({
  imports: [DiscoveryModule],
  providers: [RbacGuard, AclGuard, RoutePermissionRegistry],
  exports: [RbacGuard, AclGuard],
})
export class AuthorizationModule {}
