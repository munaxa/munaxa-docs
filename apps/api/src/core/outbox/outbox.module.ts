import { Global, Module } from '@nestjs/common';

/**
 * The outbox is written by every module and dispatched by one process. Core owns the
 * contract; the implementation is bound alongside persistence.
 */
@Global()
@Module({})
export class OutboxModule {}
