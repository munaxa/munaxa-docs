import { Injectable } from '@nestjs/common';

import type { DomainEventDraft } from '@edms/domain';

import { RecordStamps } from '../persistence/record-stamps';
import { requireTransaction } from '../prisma/unit-of-work';
import { requireContext } from '../tenancy/tenant-context';
import type { OutboxWriter } from './outbox.port';

/**
 * Writes outbox rows inside the caller's transaction.
 *
 * This is the whole of `ADR-0011`'s guarantee, and it is worth being precise about what it does and
 * does not do. It removes both failure modes of publishing directly to a queue: a job that runs
 * against a transaction which then rolled back (the row rolls back with it), and a change that
 * commits while its notification is lost to a Redis blip (the row is already committed and the
 * dispatcher will find it). What it does not do is deliver anything — that is the dispatcher's job,
 * and until one runs these rows accumulate as a durable, ordered record of what happened.
 *
 * That asymmetry is deliberate for Phase 2. The scope tree publishes `department-moved` because
 * ancestry changed, and the alternative to writing the row was dropping the event entirely: a
 * permission cache that is never told is worse than one told late. `available_at` defaults to now,
 * so nothing about the rows written here needs revisiting when the dispatcher arrives.
 *
 * `requireTransaction()` rather than an optional client: publishing outside a transaction is the one
 * thing the outbox exists to make impossible, so it fails rather than committing alone.
 */
@Injectable()
export class PrismaOutboxWriter implements OutboxWriter {
  constructor(private readonly stamps: RecordStamps) {}

  async publish(events: readonly DomainEventDraft[]): Promise<void> {
    if (events.length === 0) {
      return;
    }
    const { tenantId, correlationId } = requireContext();
    const createdAt = this.stamps.now();

    await requireTransaction().outboxMessage.createMany({
      data: events.map((event) => ({
        id: this.stamps.nextId(),
        tenantId,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        eventType: event.type,
        eventVersion: event.version,
        // Cast rather than serialised: Prisma writes a plain object into `jsonb` directly, and
        // `JSON.stringify` here would store a *string* containing JSON — which reads back as a
        // string and breaks every consumer that expects an object.
        payload: event.payload as object,
        correlationId,
        availableAt: createdAt,
        createdAt,
      })),
    });
  }
}
