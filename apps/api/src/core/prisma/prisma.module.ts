import { Global, Module } from '@nestjs/common';

import { PrismaService } from './prisma.service';
import { PrismaUnitOfWork, UNIT_OF_WORK } from './unit-of-work';

/**
 * Persistence, exported once. Modules inject `UNIT_OF_WORK` to own a transaction and
 * receive the transactional client; only infrastructure adapters touch `PrismaService`.
 */
@Global()
@Module({
  providers: [PrismaService, { provide: UNIT_OF_WORK, useClass: PrismaUnitOfWork }],
  exports: [PrismaService, UNIT_OF_WORK],
})
export class PrismaModule {}
