import { Global, Module } from '@nestjs/common';

import { OUTBOX_WRITER } from './outbox.port';
import { PrismaOutboxWriter } from './prisma-outbox.writer';

/**
 * The outbox is written by every module and dispatched by one process. Core owns the contract.
 *
 * Phase 2 binds the **writer**, because its first real events — a department moved, so inherited
 * permissions changed — had nowhere to go otherwise, and dropping them was not an option: a
 * permission cache that is never told is worse than one told late. Rows are written inside the
 * caller's transaction, which is the whole of what
 * [ADR-0011](../../../../../docs/architecture/adr/0011-transactional-outbox-for-async-work.md)
 * asks of a publisher.
 *
 * `OUTBOX_DISPATCHER` stays unbound. Claiming rows with `FOR UPDATE SKIP LOCKED` and enqueuing them
 * belongs with the worker that consumes them, and nothing written here needs revisiting when it
 * arrives — `available_at` is already set, and the rows are already durable and ordered.
 */
@Global()
@Module({
  providers: [{ provide: OUTBOX_WRITER, useClass: PrismaOutboxWriter }],
  exports: [OUTBOX_WRITER],
})
export class OutboxModule {}
