import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { QueueName, type QueueNameKey } from '@edms/domain';

import { LOGGER, type Logger } from '../observability/logger';
import { QUEUE_PORT, type QueuePort } from '../../ports/queue.port';
import { TenantDatabase } from '../prisma/tenant-database';
import type { DispatchResult, OutboxDispatcher } from './outbox.port';

/**
 * The dispatcher. Recorded as **R5** in the Phase 0.5 debt report, and built here.
 *
 * Events have been accumulating in `outbox_message` transactionally since Phase 1 and nothing has
 * ever consumed one. That was defensible while nothing needed to react to an event; it stopped
 * being so the moment the workflow engine needed to schedule a reminder, because
 * [ADR-0011](../../../../../docs/architecture/adr/0011-transactional-outbox-for-async-work.md)
 * exists precisely to prevent the alternative: a reminder enqueued inside a transaction that then
 * rolls back is a reminder for something that never happened.
 *
 * ### `FOR UPDATE SKIP LOCKED`, and why it is raw SQL
 *
 * The claim is one statement: select the due, unprocessed rows, lock them, skip any another
 * instance already holds. Prisma has no expression for `SKIP LOCKED`, and the alternatives are both
 * wrong. Reading and then updating leaves a window in which two instances both read the same row
 * and both enqueue it. Locking *without* skipping makes a second instance block behind the first
 * rather than picking up different work, which turns horizontal scaling into a queue of dispatchers
 * waiting on each other.
 *
 * ### Marking processed is not the same as delivering
 *
 * A row is marked processed only after its job is enqueued, so a crash between the two leaves the
 * row unprocessed and the next pass re-enqueues it. That is at-least-once, deliberately: the job
 * identifier is derived from the outbox row's own identifier, so a duplicate delivery is one job
 * and every handler is idempotent on it anyway. Losing an event would be the unrecoverable failure;
 * delivering one twice is a handler's ordinary case.
 *
 * ### Per tenant, because a database is per tenant
 *
 * Under ADR-0015 there is one `outbox_message` table per tenant database, so a pass walks the
 * registry's placements and dispatches each in its own transaction. A tenant whose database is
 * unreachable fails its own pass and does not stop the others — which is the same reasoning that
 * makes `TenantDatabase` connect lazily.
 */
@Injectable()
export class PrismaOutboxDispatcher implements OutboxDispatcher {
  constructor(
    @Inject(TenantDatabase) private readonly databases: TenantDatabase,
    @Inject(QUEUE_PORT) private readonly queue: QueuePort,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async dispatchBatch(batchSize: number): Promise<DispatchResult> {
    const placements = await this.databases.placements();
    let claimed = 0;
    let enqueued = 0;
    let failed = 0;

    for (const placement of placements) {
      try {
        const pass = await this.dispatchTenant(placement.id, batchSize);
        claimed += pass.claimed;
        enqueued += pass.enqueued;
        failed += pass.failed;
      } catch (error) {
        // One tenant's database being unreachable is not a reason to stop dispatching everybody
        // else's. The rows stay unprocessed and the next pass finds them.
        this.logger.error('An outbox pass failed for one tenant', {
          tenantId: placement.id,
          reason: error instanceof Error ? error.message : 'unknown',
        });
      }
    }

    return { claimed, enqueued, failed };
  }

  private async dispatchTenant(tenantId: string, batchSize: number): Promise<DispatchResult> {
    return this.databases.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<ClaimedRow[]>`
        SELECT id, aggregate_type, aggregate_id, event_type, event_version, payload,
               correlation_id, attempts
        FROM outbox_message
        WHERE processed_at IS NULL
          AND available_at <= now()
        ORDER BY available_at, id
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED`;

      if (rows.length === 0) {
        return { claimed: 0, enqueued: 0, failed: 0 };
      }

      const delivered: string[] = [];
      const rejected: { id: string; reason: string }[] = [];

      for (const row of rows) {
        const lane = routeFor(row.event_type);
        if (lane === null) {
          // An event nothing consumes. Marked processed rather than retried forever: the row is the
          // durable record that it happened, and leaving it unprocessed would make the pending
          // count grow without bound and hide the events that genuinely could not be delivered.
          delivered.push(row.id);
          continue;
        }
        try {
          await this.queue.enqueue(
            lane,
            {
              eventId: row.id,
              tenantId,
              aggregateType: row.aggregate_type,
              aggregateId: row.aggregate_id,
              eventType: row.event_type,
              eventVersion: row.event_version,
              payload: row.payload,
              correlationId: row.correlation_id,
            },
            // Derived from the row, so a re-dispatch after a crash is the same job rather than a
            // second one. This is what makes at-least-once safe rather than merely tolerable.
            { jobId: `outbox:${row.id}` },
          );
          delivered.push(row.id);
        } catch (error) {
          rejected.push({
            id: row.id,
            reason: error instanceof Error ? error.message : 'unknown',
          });
        }
      }

      if (delivered.length > 0) {
        await tx.outboxMessage.updateMany({
          where: { id: { in: delivered } },
          data: { processedAt: new Date(), attempts: { increment: 1 } },
        });
      }
      for (const failure of rejected) {
        // Backed off by pushing `available_at` forward rather than by leaving the row alone, so a
        // queue that is down does not make every pass re-attempt the same rows and starve the ones
        // behind them. The delay grows with the attempt count and is capped, like every other
        // retry policy in the product.
        await tx.outboxMessage.update({
          where: { id: failure.id },
          data: {
            attempts: { increment: 1 },
            lastError: failure.reason.slice(0, 500),
            availableAt: new Date(Date.now() + backoffMs(rows, failure.id)),
          },
        });
      }

      return { claimed: rows.length, enqueued: delivered.length, failed: rejected.length };
    });
  }
}

interface ClaimedRow {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  event_version: number;
  payload: Prisma.JsonValue;
  correlation_id: string;
  attempts: number;
}

/**
 * Which lane an event type goes to.
 *
 * A prefix match rather than a table of every event, and that is a deliberate trade. The alternative
 * — a registry every module contributes its own routes to — is more precise and costs a
 * cross-module registration that nothing would notice was missing until an event silently stopped
 * being delivered. A prefix is derived from the aggregate name, which the event type already
 * carries, so a new event in an existing module routes correctly with no change here at all.
 *
 * An unrouted event is not an error: most events exist so that a later phase can consume them, and
 * the outbox row is the durable record either way.
 */
function routeFor(eventType: string): QueueNameKey | null {
  if (eventType.startsWith('workflow.')) {
    // Notifications, once Phase 12 builds delivery. Until then the job is consumed by nothing and
    // the lane is where a consumer will look — which is the point of routing it now rather than
    // discovering the routing table is empty.
    return QueueName.NOTIFICATIONS_DELIVER;
  }
  if (eventType.startsWith('document.') || eventType.startsWith('revision.')) {
    return QueueName.SEARCH_INDEX;
  }
  if (eventType.startsWith('notification.')) {
    return QueueName.NOTIFICATIONS_DELIVER;
  }
  return null;
}

/** Exponential, capped at five minutes, from the attempt count the row already carries. */
function backoffMs(rows: readonly ClaimedRow[], id: string): number {
  const attempts = rows.find((row) => row.id === id)?.attempts ?? 0;
  return Math.min(300_000, 1_000 * 2 ** Math.min(attempts, 8));
}
