import { Global, Module } from '@nestjs/common';

import { TenantIsolationGuard } from './tenant-isolation.guard';

/** Tenant context and the guard that refuses any request naming another tenant. */
@Global()
@Module({
  providers: [TenantIsolationGuard],
  exports: [TenantIsolationGuard],
})
export class TenancyModule {}
