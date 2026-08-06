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
/** The most rows one tenant contributes to the backlog gauge. See `pending()`. */
const PENDING_SAMPLE_BOUND = 10_000;

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

  /**
   * The undelivered backlog across every placement.
   *
   * Bounded per tenant rather than counted exactly, for the reason 19 §3 gives for every other
   * count in this product: an exact count over a large unprocessed table is the expensive query,
   * and the number an alert fires on is "is the backlog above a threshold", not "is it 41,912".
   * The bound is generous enough that the gauge is exact in every healthy deployment and
   * saturates, visibly, in an unhealthy one.
   */
  async pending(): Promise<number> {
    const placements = await this.databases.placements();
    let pending = 0;
    for (const placement of placements) {
      try {
        pending += await this.databases.withTenant(placement.id, async (tx) => {
          const rows = await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM outbox_message
            WHERE processed_at IS NULL
            LIMIT ${PENDING_SAMPLE_BOUND}`;
          return rows.length;
        });
      } catch (error) {
        // Sampling is not worth failing over. A tenant whose database is unreachable is already
        // reported by the readiness probe, which is the surface that question belongs on.
        this.logger.warn('The outbox backlog could not be sampled for one tenant', {
          tenantId: placement.id,
          reason: error instanceof Error ? error.message : 'unknown',
        });
      }
    }
    return pending;
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
        const lanes = routesFor(row.event_type);
        if (lanes.length === 0) {
          // An event nothing consumes. Marked processed rather than retried forever: the row is the
          // durable record that it happened, and leaving it unprocessed would make the pending
          // count grow without bound and hide the events that genuinely could not be delivered.
          delivered.push(row.id);
          continue;
        }
        try {
          for (const lane of lanes) {
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
              // Derived from the row and the lane, so a re-dispatch after a crash — including one
              // that fell between two lanes of the same row — replaces rather than duplicates.
              // This is what makes at-least-once safe rather than merely tolerable.
              { jobId: `outbox:${row.id}:${lane}` },
            );
          }
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
 * Which lanes an event type goes to.
 *
 * A prefix match rather than a table of every event, and that is a deliberate trade. The alternative
 * — a registry every module contributes its own routes to — is more precise and costs a
 * cross-module registration that nothing would notice was missing until an event silently stopped
 * being delivered. A prefix is derived from the aggregate name, which the event type already
 * carries, so a new event in an existing module routes correctly with no change here at all.
 * (Phase 7 kept the decision when it became the second consumer: what it needed was a second
 * *lane* per prefix, not a registry.)
 *
 * ### Phase 12 kept it too, and had the strongest case yet not to
 *
 * The sentence above — "a new event in an existing module routes correctly with no change here at
 * all" — turned out to be **false**, and Phase 12 is the phase that could see it. Phase 11's four
 * events are named `delegation.*`; their aggregate is `identity`; no prefix matched them; and
 * every one of them was silently discarded as unroutable from the day it shipped. That is exactly
 * the failure this comment predicted for a registry, occurring in the prefix table instead —
 * because the premise is wrong. A prefix is not derived from the aggregate name. It is derived
 * from whatever the module chose to call its event type, which is a *different string* that
 * nothing checks.
 *
 * The registry was reconsidered on that evidence and still rejected, for a reason this phase
 * discovered rather than inherited. A route is not the only thing the notification consumer needs
 * to know about an event: it has to switch on the event type anyway, to decide who the recipients
 * are and what the template's values mean. A registry would move the *routing* half of that
 * decision into the module that publishes the event and leave the *recipient* half in the
 * consumer — one question, answered in two files, in two modules, that must agree. The prefix
 * table keeps both halves within one switch, and pays for it with a table somebody has to
 * remember to extend.
 *
 * What makes forgetting detectable rather than silent is `prisma-outbox.dispatcher.spec.ts`: it
 * asserts that **every event type in every module's `*_EVENT_TYPES` list routes somewhere**, and
 * that every type 18 §4 names reaches the notification lane. That is the property a registry
 * would have bought, obtained by a test instead of by a cross-module registration — and it is the
 * test that would have caught `delegation.*` in Phase 11.
 *
 * A list, because one fact legitimately interests two lanes at two costs: a revision event is
 * what the preview pipeline renders from *and* what the search projection will index, and the
 * lanes are separated by cost precisely so the two reactions cannot starve each other.
 *
 * An unrouted event is not an error: most events exist so that a later phase can consume them, and
 * the outbox row is the durable record either way.
 */
export function routesFor(eventType: string): readonly QueueNameKey[] {
  // **Every event goes to the webhook lane** — Phase 17, and the reason this line is at the top
  // rather than being a branch among the others.
  //
  // A webhook subscriber is the first consumer in the product that wants *every* family, and it is
  // therefore the first for which this table's failure mode is total rather than partial. When
  // `delegation.*` routed nowhere from Phase 11 to Phase 12, the search index missed some
  // re-projections and the notification lane missed some messages — bad, and observable, because
  // somebody eventually noticed a document was not findable. An integration built on "tell me when
  // anything happens" that silently receives nothing from one family has no such signal: absence
  // is indistinguishable from quiet, and the author has no way to discover the gap at all.
  //
  // So the webhook lane is not a line somebody has to remember to add. It is unconditional, and
  // the **default** below changed from `[]` to this same lane — an event matching no branch now
  // reaches webhooks instead of nowhere. The next phase that adds an event family gets webhooks
  // without touching this function, which is the property the original comment claimed for the
  // whole table and which was false twice.
  //
  // The fan-out then filters per endpoint (`webhookSubscribes`), so a tenant subscribing to
  // `document` receives no `search.*` traffic — the narrowing is the subscriber's, where it can be
  // changed without a release, rather than this table's.
  const webhook: readonly QueueNameKey[] = [QueueName.WEBHOOKS_DELIVER];

  if (eventType.startsWith('workflow.')) {
    return [QueueName.NOTIFICATIONS_DELIVER, ...webhook];
  }
  if (eventType.startsWith('revision.')) {
    // Not the notification lane. A revision event and the `document.*` event beside it describe
    // one act — publishing a revision publishes the document — and routing both would notify
    // twice about one thing. `document.published` is the one 18 §4 names, so it is the one that
    // carries the notification.
    return [QueueName.SEARCH_INDEX, QueueName.DOCUMENTS_PREVIEW, ...webhook];
  }
  if (eventType === 'document.created') {
    // The one document event that announces content: ordinal zero publishes no revision event
    // (`createInitial` predates the revision cycle), so the preview pipeline hears about a new
    // document's file from here.
    return [
      QueueName.SEARCH_INDEX,
      QueueName.DOCUMENTS_PREVIEW,
      QueueName.NOTIFICATIONS_DELIVER,
      ...webhook,
    ];
  }
  if (eventType.startsWith('document.')) {
    return [QueueName.SEARCH_INDEX, QueueName.NOTIFICATIONS_DELIVER, ...webhook];
  }
  if (eventType.startsWith('library.')) {
    // **Phase 14's addition, and the third time this table needed extending rather than deriving.**
    //
    // `library.acl-changed` and `library.folder-moved` both change the answer the search index has
    // materialised for every document beneath a node — the first because the entries changed, the
    // second because the chain did. Neither routed anywhere before this phase: `library.*` matched
    // no prefix, exactly as `delegation.*` did not in Phase 11, and for the same reason — the
    // aggregate is `library` and so is the event type, but nothing here had a line for it.
    //
    // `library.created` rides along and resolves to no document, which the consumer drops with a
    // log. That is the same trade the `audit.` and `retention.` branches already make: a per-event
    // table would be more precise and one more thing to forget.
    //
    // Not the notification lane. Nobody is told that permissions changed — 18 §4 names no such
    // message, and a notification saying "you can now see forty documents" would be a disclosure
    // decided by a template rather than by the resolver.
    return [QueueName.SEARCH_INDEX, ...webhook];
  }
  if (eventType.startsWith('preview.')) {
    // The search projection consumes `preview.ocr-completed` in Phase 8; the lane is where it
    // will look.
    return [QueueName.SEARCH_INDEX, ...webhook];
  }
  if (eventType.startsWith('notification.')) {
    return [QueueName.NOTIFICATIONS_DELIVER, ...webhook];
  }
  if (eventType.startsWith('bulk.')) {
    // Phase 16, and the fourth time this table needed a line rather than a derivation. The
    // lesson Phase 11 and Phase 14 both learned the hard way — an event family whose prefix no
    // branch matched, accumulating unrouted — is why this line ships in the same commit as the
    // event rather than being discovered by its absence later. The integration suite asserts the
    // routing rather than the comment.
    //
    // The notification lane only. A bulk operation's *effects* — the documents it restored, the
    // tasks it decided — already publish their own events from inside each object's transaction,
    // and those route to the search index exactly as they always have. Routing this one there
    // too would re-project nothing, because the operation resolves to no document.
    return [QueueName.NOTIFICATIONS_DELIVER, ...webhook];
  }
  if (eventType.startsWith('retention.')) {
    // The search projection removes a purged document's entry (`retention.document-purged`
    // resolves to its document like any other event); the rest of the family rides along to the
    // same lane and resolves to the same projection, which re-reads current truth and is
    // harmless. The notification lane is Phase 12's: `retention.due` is the disposition-review
    // reminder Phase 10 left owing, and the two hold events are 18 §4's `LegalHoldPlaced` row.
    return [QueueName.SEARCH_INDEX, QueueName.NOTIFICATIONS_DELIVER, ...webhook];
  }
  if (
    eventType.startsWith('delegation.') ||
    eventType.startsWith('audit.') ||
    eventType.startsWith('storage.')
  ) {
    // Phase 12's additions, and the reason the table needed re-reading rather than extending.
    //
    // **`delegation.*` routed nowhere at all.** Phase 11's four events begin `delegation.`, and
    // no prefix here matched them: `identity.` would have, and the aggregate is `identity` while
    // the event type is not. The rows have been accumulating unrouted since Phase 11, exactly as
    // its report said — "delivered nowhere" — but for a reason nobody had noticed, which is the
    // failure mode the comment below predicted for a registry and which a prefix table turns out
    // to share.
    //
    // **`audit.chain-broken`** is Phase 9's undelivered alert. `audit.chain-verified` and
    // `audit.export-ready` ride the same prefix and are dropped by the consumer, which is
    // cheaper than a per-event table and is the same trade this function has always made.
    //
    // **`storage.file-quarantined`** is 18 §4's "infected upload".
    return [QueueName.NOTIFICATIONS_DELIVER, ...webhook];
  }
  // The default, and the line this phase changed. It was `[]`, which is what made forgetting a
  // family silent; it is now the lane whose consumer wants everything, so a family nobody has
  // written a branch for still reaches an integration that asked for it.
  return webhook;
}

/** Exponential, capped at five minutes, from the attempt count the row already carries. */
function backoffMs(rows: readonly ClaimedRow[], id: string): number {
  const attempts = rows.find((row) => row.id === id)?.attempts ?? 0;
  return Math.min(300_000, 1_000 * 2 ** Math.min(attempts, 8));
}
