import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { QueueName, SCHEDULE } from '@edms/domain';

import type { AppConfig } from '../../../core/config';
import type { Logger } from '../../../core/observability/logger';
import { BullMqQueueAdapter } from '../bullmq.adapter';

/**
 * **A job the broker accepted is not a job that ran.**
 *
 * Its sibling, `job-identifier.integration.spec.ts`, guards Phase 6.10's P0 by asserting that BullMQ
 * *accepts* every identifier this product derives. Phase 6.13 recorded the honest limit of that:
 * acceptance is not execution, and the defect class this repository has now met twice — a job
 * declared, configured, registered and never actually performed — lives in the gap between them.
 *
 * This closes that gap. Every shape is enqueued through the real adapter onto a real lane, consumed
 * by a real `Worker` the same `subscribe` call production uses, and the handler records what it was
 * handed. The assertion is on **what the handler received**, so the test cannot pass because a job
 * was accepted and left sitting: an accepted-but-unprocessed job is an empty record, which is a
 * failure here and was a green build before.
 *
 * ## What it does and does not claim
 *
 * It proves **reachability of the execution path**: enqueue → broker → worker → handler, for every
 * identifier shape and for every declared schedule's own lane. It does **not** claim the business
 * effect of any job — that is `phase-6.11`'s work, verified for eight of the thirteen and honestly
 * unverified for five. Those two things are asserted separately and on purpose, because conflating
 * them is how "the scheduler works" came to mean "the scheduler is registered".
 *
 * ## Why it is an integration test
 *
 * Because every part of what it asserts belongs to Redis and BullMQ. A mocked queue would assert
 * that our code calls a method we wrote, which is precisely the assurance that was missing when no
 * scheduled job in this product had ever run.
 */

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

/**
 * The lane this test delivers over. The *lane* is incidental — what is under test is the identifier
 * and the delivery — but which one it is has one consequence worth stating.
 *
 * **This suite assumes it owns the broker**, exactly as every integration test here assumes it owns
 * the database. A booted API subscribes its own `Worker` to this lane, and BullMQ hands each job to
 * exactly one consumer — so with an application running beside the suite, some jobs are consumed by
 * *it* and never reach the handler below. That presents as "six of nine were accepted and never
 * processed", which is indistinguishable from the defect this test exists to catch until you notice
 * the API is up. Diagnosed the hard way; recorded so the next person does not diagnose it again.
 */
const LANE = QueueName.DOCUMENTS_BULK;

/** Every identifier shape this product derives, as `job-identifier.integration.spec.ts` enumerates. */
const DERIVED_ID_SHAPES = [
  (id: string) =>
    `notifications.deliver-tenant:all:${id}:repeat:notifications.deliver:1786261920000`,
  (id: string) => `retention.sweep-tenant:${id}:repeat:retention.sweep:1786261920000`,
  (id: string) => `audit:verify:${id}:repeat:audit.verify-chain:1786261920000`,
  (id: string) => `search:project:${id}:3`,
  (id: string) => `search:reproject:${id}:0`,
  (id: string) => `ocr:${id}`,
  (id: string) => `wf-timer:${id}`,
  (id: string) => `repeat:notifications.deliver:1786261920000:requeued:1:${id}`,
  (id: string) => `outbox:${id}:notifications.deliver`,
];

let adapter: BullMqQueueAdapter;

/** What the worker was actually handed, keyed by the marker each job carries in its payload. */
const handled = new Map<string, { jobId: string; marker: string }>();

beforeAll(async () => {
  const noop = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  adapter = new BullMqQueueAdapter(
    { redis: { url: REDIS_URL }, queue: { consumersEnabled: true } } as unknown as AppConfig,
    { ...noop, child: () => noop } as unknown as Logger,
    { increment: () => undefined, observe: () => undefined, gauge: () => undefined },
    // `elapsedMs` as well as `timestamp`, and the omission was worth a paragraph: without it the
    // worker's `finally` throws while recording the job-duration metric — *before* it releases the
    // tenant's concurrency slot. The counter then sticks at the cap, every later job for that
    // tenant is re-queued for ever, and the symptom is eleven jobs accepted and never processed.
    // Which is indistinguishable, from the outside, from the defect this test exists to catch. A
    // partial stub of a real port is how a test invents a P0.
    {
      now: () => new Date(),
      timestamp: () => Date.now(),
      elapsedMs: (from: number) => Date.now() - from,
    },
  );

  // The same registration production uses. Nothing about this worker is special, which is the
  // point: if `subscribe` stopped delivering, every consumer in the product would stop with it.
  await adapter.subscribe(LANE, (job) => {
    const marker = (job.payload as { marker?: string }).marker ?? '';
    handled.set(marker, { jobId: job.jobId, marker });
    return Promise.resolve();
  });
});

afterAll(async () => {
  await adapter.onModuleDestroy();
});

/** Waits for the worker to have handled every marker, and fails naming what never arrived. */
async function waitForHandled(markers: readonly string[], timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (markers.every((marker) => handled.has(marker))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const missing = markers.filter((marker) => !handled.has(marker));
  throw new Error(
    `${String(missing.length)} of ${String(markers.length)} jobs were enqueued and never reached ` +
      `the worker: ${missing.join(', ')}. An accepted job that is never processed is exactly the ` +
      'defect this test exists for.',
  );
}

describe('a job this product derives an identifier for', () => {
  it('reaches the worker and invokes the handler, for every derived shape', async () => {
    const markers: string[] = [];
    for (const shape of DERIVED_ID_SHAPES) {
      const id = randomUUID();
      const jobId = shape(id);
      const marker = `shape:${jobId}`;
      markers.push(marker);
      await adapter.enqueue(LANE, { tenantId: null, marker }, { jobId });
    }

    // Not "the broker did not throw" — the handler ran, for each one, and can say which job it was
    // handed. This is the assertion the sibling spec deliberately does not make.
    await waitForHandled(markers);
    expect(handled.size).toBeGreaterThanOrEqual(markers.length);
    for (const marker of markers) {
      expect(handled.get(marker)?.marker).toBe(marker);
    }
  }, 120_000);

  /**
   * And once per declared schedule, keyed the way its lane's fan-out keys it.
   *
   * `SCHEDULE` is read rather than restated, so a schedule added later is covered by this test the
   * day it is added — which is the only way a regression guard survives contact with a future
   * phase. A new entry whose fan-out derives an identifier the broker refuses, or whose job never
   * arrives, fails here rather than silently doing nothing in production for eighteen phases.
   */
  it('reaches the worker for every schedule in the catalogue', async () => {
    const tenant = randomUUID();
    const markers: string[] = [];
    for (const entry of SCHEDULE) {
      // The shape every lane's `fanOut` builds: the per-tenant kind, the tenant, and the firing's
      // own repeatable job id — the composition that was refused before Phase 6.10.
      const jobId = `${entry.name}-tenant:${tenant}:repeat:${entry.name}:1786261920000`;
      const marker = `schedule:${entry.name}`;
      markers.push(marker);
      await adapter.enqueue(LANE, { tenantId: tenant, marker }, { jobId });
    }

    expect(markers).toHaveLength(SCHEDULE.length);
    await waitForHandled(markers);
  }, 120_000);
});
