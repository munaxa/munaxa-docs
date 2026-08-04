import { Global, Module } from '@nestjs/common';

import { OUTBOX_DISPATCHER, OUTBOX_WRITER } from './outbox.port';
import { OutboxDispatchScheduler } from './outbox-dispatch.scheduler';
import { PrismaOutboxDispatcher } from './prisma-outbox.dispatcher';
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
 * **Phase 4 binds the dispatcher**, which Phase 0.5 recorded as R5 and Phase 2 deliberately left
 * unbound. Leaving it unbound was defensible while nothing needed to react to an event; it stopped
 * being so the moment the workflow engine needed to schedule a reminder, because that is the exact
 * failure ADR-0011 exists to prevent — a job enqueued inside a transaction that then rolls back.
 * Nothing written before this needed revisiting: `available_at` was already set and the rows were
 * already durable and ordered, so the first pass found the accumulated events and delivered them in
 * the order they were written.
 */
@Global()
@Module({
  providers: [
    { provide: OUTBOX_WRITER, useClass: PrismaOutboxWriter },
    { provide: OUTBOX_DISPATCHER, useClass: PrismaOutboxDispatcher },
    OutboxDispatchScheduler,
  ],
  exports: [OUTBOX_WRITER, OUTBOX_DISPATCHER, OutboxDispatchScheduler],
})
export class OutboxModule {}
