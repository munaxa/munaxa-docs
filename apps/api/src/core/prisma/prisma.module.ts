import { Global, Module } from '@nestjs/common';

import { TenancyModule } from '../tenancy/tenancy.module';
import { PrismaUnitOfWork, UNIT_OF_WORK } from './unit-of-work';
import { TenantDatabase } from './tenant-database';

/**
 * Persistence, exported once. Modules inject `UNIT_OF_WORK` to own a transaction and receive the
 * transactional client; only infrastructure adapters touch `TenantDatabase`.
 *
 * It imports `TenancyModule` because a connection is now resolved from a tenant's placement: the
 * registry decides which database a transaction opens on, so persistence depends on tenancy rather
 * than the other way round.
 */
@Global()
@Module({
  imports: [TenancyModule],
  providers: [TenantDatabase, { provide: UNIT_OF_WORK, useClass: PrismaUnitOfWork }],
  exports: [TenantDatabase, UNIT_OF_WORK],
})
export class PrismaModule {}
