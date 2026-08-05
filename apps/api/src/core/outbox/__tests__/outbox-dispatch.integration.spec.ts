import 'reflect-metadata';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { QueueName, type TenantId, asId } from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import type { AppConfig } from '../../config/configuration';
import type { Logger } from '../../observability/logger';
import { TenantDatabase } from '../../prisma/tenant-database';
import type { TenantPlacement } from '../../tenancy/tenant-placement';
import type { TenantRegistry } from '../../tenancy/tenant-registry.port';
import type { EnqueuedJob, JobOptions, QueuePort } from '../../../ports/queue.port';
import { PrismaOutboxDispatcher } from '../prisma-outbox.dispatcher';

/**
 * The outbox dispatcher, against a real PostgreSQL.
 *
 * Recorded as **R5** in the Phase 0.5 debt report and unbound until Phase 4. It is asserted here
 * rather than over a repository double because every property that matters about it is a property
 * of the database:
 *
 *  - **`FOR UPDATE SKIP LOCKED` really skips.** Two dispatchers running at once claim *different*
 *    rows rather than one blocking behind the other or both claiming the same. There is no way to
 *    observe that except by holding a lock in one transaction and dispatching in another.
 *  - **A row is marked processed only after its job is enqueued.** A queue that refuses leaves the
 *    row unprocessed with the failure recorded and its next attempt backed off — because losing an
 *    event is the unrecoverable failure and delivering one twice is a handler's ordinary case.
 *  - **The job identifier is derived from the row.** That is what makes at-least-once delivery
 *    harmless, and it is only checkable by looking at what was handed to the queue.
 */

const OWNER_URL = process.env['DATABASE_MIGRATION_URL'] ?? '';
const APP_URL = process.env['DATABASE_URL'] ?? '';

const TENANT = asId<TenantId>(uuidv7());
const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

let owner: PrismaClient;
let databases: TenantDatabase;
let dispatcher: PrismaOutboxDispatcher;

/** Everything handed to the queue, and a switch to make it refuse. */
const handed: { queue: string; jobId: string; payload: unknown }[] = [];
let refuse = false;

const queue: QueuePort = {
  enqueue: (queueName, payload, options: JobOptions): Promise<EnqueuedJob> => {
    if (refuse) {
      return Promise.reject(new Error('The queue is unreachable.'));
    }
    handed.push({ queue: queueName, jobId: options.jobId, payload });
    return Promise.resolve({ queue: queueName, jobId: options.jobId, availableAt: new Date() });
  },
  cancel: () => Promise.resolve(true),
  depth: (queueName) =>
    Promise.resolve({ queue: queueName, waiting: 0, active: 0, delayed: 0, failed: 0 }),
  // The dispatcher never declares a schedule; these exist so the double still satisfies the port.
  schedule: () => Promise.resolve(),
  unschedule: () => Promise.resolve(),
};

function placement(): TenantPlacement {
  return {
    id: TENANT,
    slug: 'outbox',
    status: 'ACTIVE',
    database: { url: APP_URL },
    storage: { driver: 'NONE', container: 'test', prefix: 'outbox' },
    search: { index: 'outbox' },
  } as unknown as TenantPlacement;
}

const registry: TenantRegistry = {
  bySlug: () => Promise.resolve(placement()),
  byId: () => Promise.resolve(placement()),
  all: () => Promise.resolve([placement()]),
};

async function writeEvent(eventType: string, availableAt = new Date()): Promise<string> {
  const id = uuidv7();
  await owner.outboxMessage.create({
    data: {
      id,
      tenantId: TENANT,
      aggregateType: 'workflow',
      aggregateId: uuidv7(),
      eventType,
      payload: { marker: id },
      correlationId: 'outbox-dispatch',
      availableAt,
    },
  });
  return id;
}

beforeAll(async () => {
  if (!OWNER_URL || !APP_URL) {
    throw new Error('DATABASE_URL and DATABASE_MIGRATION_URL must both be set.');
  }
  const config = {
    env: 'test',
    database: { url: APP_URL, poolSize: 10, maxTenantClients: 5 },
  } as unknown as AppConfig;

  databases = new TenantDatabase(config, logger, registry);
  dispatcher = new PrismaOutboxDispatcher(databases, queue, logger);

  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  await owner.tenant.create({
    data: {
      id: TENANT,
      slug: `outbox-${String(Date.now())}-${TENANT.slice(0, 8)}`,
      name: 'Outbox Dispatch Test',
      status: 'ACTIVE',
    },
  });
}, 60_000);

afterAll(async () => {
  await databases?.disconnectAll();
  await owner?.$disconnect();
});

beforeEach(async () => {
  handed.length = 0;
  refuse = false;
  // Each assertion owns the whole table, because the dispatcher's job is to claim everything due.
  await owner.outboxMessage.deleteMany({ where: { tenantId: TENANT } });
});

describe('the outbox dispatcher', () => {
  it('claims due rows, routes them, and marks them processed', async () => {
    const eventId = await writeEvent('workflow.started');

    const result = await dispatcher.dispatchBatch(10);

    expect(result).toEqual({ claimed: 1, enqueued: 1, failed: 0 });
    // **Two lanes since Phase 17**: the notification lane this event has always gone to, and the
    // webhook lane every event now goes to. One row, two jobs — which is what `enqueued: 1`
    // counts, because the row is what was dispatched.
    expect(handed.map((job) => job.queue)).toEqual([
      QueueName.NOTIFICATIONS_DELIVER,
      QueueName.WEBHOOKS_DELIVER,
    ]);
    // Derived from the row and the lane, so a re-dispatch after a crash is the same job rather
    // than a second one — and an event fanned to two lanes is two distinct jobs, not a
    // collision. This is what makes at-least-once delivery safe rather than merely tolerable.
    expect(handed[0]?.jobId).toBe(`outbox:${eventId}:${QueueName.NOTIFICATIONS_DELIVER}`);
    expect(handed[1]?.jobId).toBe(`outbox:${eventId}:${QueueName.WEBHOOKS_DELIVER}`);

    const row = await owner.outboxMessage.findUniqueOrThrow({ where: { id: eventId } });
    expect(row.processedAt).not.toBeNull();
  });

  it('leaves a row that is not yet due', async () => {
    const later = new Date(Date.now() + 3_600_000);
    const eventId = await writeEvent('workflow.started', later);

    expect(await dispatcher.dispatchBatch(10)).toEqual({ claimed: 0, enqueued: 0, failed: 0 });
    const row = await owner.outboxMessage.findUniqueOrThrow({ where: { id: eventId } });
    expect(row.processedAt).toBeNull();
  });

  /**
   * **Phase 17 reversed the premise of this test, and that is the point of it.**
   *
   * Until this phase an event matching no branch of `routesFor` routed *nowhere*, which is what
   * made forgetting a family silent — `delegation.*` from Phase 11 to Phase 12, `library.*` to
   * Phase 14. A webhook subscriber is the first consumer for which that failure is total rather
   * than partial: an integration told "you will hear about everything" that silently receives
   * nothing from one family cannot tell quiet from absent.
   *
   * So the default is now the webhook lane, and an event nobody wrote a branch for still reaches
   * an integration that asked for it. What the row below still asserts is the other half, which
   * has not changed: the row is marked processed rather than retried for ever.
   */
  it('routes an event with no branch of its own to the webhook lane, and marks it processed', async () => {
    const eventId = await writeEvent('administration.document-type-changed');

    const result = await dispatcher.dispatchBatch(10);

    expect(handed.map((job) => job.queue)).toEqual([QueueName.WEBHOOKS_DELIVER]);
    expect(result.claimed).toBe(1);
    // Marked processed rather than retried forever: the row is the durable record that it happened,
    // and leaving it pending would make the backlog grow without bound and hide the events that
    // genuinely could not be delivered.
    const row = await owner.outboxMessage.findUniqueOrThrow({ where: { id: eventId } });
    expect(row.processedAt).not.toBeNull();
  });

  it('leaves a row unprocessed when the queue refuses, and backs its next attempt off', async () => {
    const eventId = await writeEvent('workflow.completed');
    refuse = true;

    const result = await dispatcher.dispatchBatch(10);

    expect(result).toEqual({ claimed: 1, enqueued: 0, failed: 1 });
    const row = await owner.outboxMessage.findUniqueOrThrow({ where: { id: eventId } });
    // The event survives the queue being down. That asymmetry is the whole point of the outbox:
    // losing an event is unrecoverable, delivering one twice is ordinary.
    expect(row.processedAt).toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain('unreachable');
    expect(row.availableAt.getTime()).toBeGreaterThan(Date.now());

    // And it is delivered on the next pass once the queue is back — with the same job identifier,
    // so a consumer that had somehow already seen it does the work once.
    refuse = false;
    await owner.outboxMessage.update({
      where: { id: eventId },
      data: { availableAt: new Date(Date.now() - 1_000) },
    });
    expect(await dispatcher.dispatchBatch(10)).toEqual({ claimed: 1, enqueued: 1, failed: 0 });
    expect(handed[0]?.jobId).toBe(`outbox:${eventId}:${QueueName.NOTIFICATIONS_DELIVER}`);
  });

  it('skips rows another dispatcher is holding rather than blocking behind them', async () => {
    const held = await writeEvent('workflow.started');
    const free = await writeEvent('workflow.completed');

    // A second connection holds a lock on one row inside an open transaction, which is exactly what
    // a second dispatcher instance looks like mid-pass. Without `SKIP LOCKED` this pass would block
    // on it until the timeout; with it, the pass picks up the other row and moves on.
    const other = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
    let release: () => void = () => {};
    const holding = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locked = other.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        'SELECT id FROM outbox_message WHERE id = $1::uuid FOR UPDATE',
        held,
      );
      await holding;
    });

    // Give the lock a moment to be taken before dispatching against it.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const result = await dispatcher.dispatchBatch(10);
    release();
    await locked;
    await other.$disconnect();

    expect(result.claimed).toBe(1);
    // Only the free row's jobs — both of its lanes — and nothing for the held one.
    expect(handed.map((job) => job.jobId)).toEqual([
      `outbox:${free}:${QueueName.NOTIFICATIONS_DELIVER}`,
      `outbox:${free}:${QueueName.WEBHOOKS_DELIVER}`,
    ]);
    // The held row is untouched and the next pass finds it — no double send, no starvation.
    expect(
      (await owner.outboxMessage.findUniqueOrThrow({ where: { id: held } })).processedAt,
    ).toBeNull();
  });

  it('carries the tenant with the job, because a job has no request behind it', async () => {
    await writeEvent('workflow.started');
    await dispatcher.dispatchBatch(10);

    const payload = handed[0]?.payload as Record<string, unknown>;
    // Without this a consumer has no way to decide which database to open, which is the whole of
    // ADR-0015 as far as a background job is concerned.
    expect(payload['tenantId']).toBe(TENANT);
    expect(payload['correlationId']).toBe('outbox-dispatch');
  });

  it('respects the batch size, so a burst is drained rather than claimed all at once', async () => {
    for (let index = 0; index < 5; index += 1) {
      await writeEvent('workflow.started');
    }

    expect((await dispatcher.dispatchBatch(2)).claimed).toBe(2);
    expect((await dispatcher.dispatchBatch(2)).claimed).toBe(2);
    expect((await dispatcher.dispatchBatch(2)).claimed).toBe(1);
    expect((await dispatcher.dispatchBatch(2)).claimed).toBe(0);
  });
});
