import { Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';

import { ACL_RESOLVER } from './acl-resolver.port';
import { AclGuard } from './acl.guard';
import { DenyAllAclResolver } from './deny-all.acl-resolver';
import { RbacGuard } from './rbac.guard';
import { RoutePermissionRegistry } from './route-permission.registry';

/**
 * The authorization chain.
 *
 * `ACL_RESOLVER` belongs to the Library module, which owns the ACL entries; `POLICY_EVALUATOR`
 * and `FEATURE_FLAGS` belong to Administration, which owns the settings behind them. Core
 * declares the questions and the modules supply the answers.
 *
 * Until Library ships, the resolver here denies everything. Every default in this file points
 * the same way: an unimplemented decision is a refusal, never an allowance.
 */
@Global()
@Module({
  imports: [DiscoveryModule],
  providers: [
    RbacGuard,
    AclGuard,
    RoutePermissionRegistry,
    { provide: ACL_RESOLVER, useClass: DenyAllAclResolver },
  ],
  exports: [RbacGuard, AclGuard, ACL_RESOLVER],
})
export class AuthorizationModule {}
