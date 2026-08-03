import { Global, Module } from '@nestjs/common';

import { ConfigTenantRegistry } from './config-tenant.registry';
import { TENANT_REGISTRY } from './tenant-registry.port';
import { TenantIsolationGuard } from './tenant-isolation.guard';

/**
 * Tenant context, the registry that says where each tenant's infrastructure lives, and the guard that
 * refuses any request naming another tenant.
 *
 * The registry is bound to the configuration-backed adapter, which serves both deployments: one
 * placement derived from the environment on premise, a catalogue in the cloud. A control-plane
 * adapter replaces this one line and nothing else
 * ([ADR-0015](../../../../../docs/architecture/adr/0015-database-per-tenant.md)).
 */
@Global()
@Module({
  providers: [
    TenantIsolationGuard,
    ConfigTenantRegistry,
    { provide: TENANT_REGISTRY, useExisting: ConfigTenantRegistry },
  ],
  exports: [TenantIsolationGuard, TENANT_REGISTRY],
})
export class TenancyModule {}
