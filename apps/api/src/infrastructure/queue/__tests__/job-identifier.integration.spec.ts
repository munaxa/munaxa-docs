import { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { QueueName } from '@edms/domain';

import type { AppConfig } from '../../../core/config';
import type { Logger } from '../../../core/observability/logger';
import type { Metrics } from '../../../core/observability/metrics';
import type { ClockPort } from '../../../ports/clock.port';
import { BullMqQueueAdapter } from '../bullmq.adapter';

/**
 * The guard on Phase 6.10's P0 — **the broker refusing this product's job identifiers**.
 *
 * Every scheduled fan-out in this product derives a job id that embeds the firing's own
 * `repeat:<name>:<epoch>` identifier, and BullMQ refuses a custom id containing `:` unless it
 * happens to split into exactly three parts (a compatibility carve-out for its own older
 * repeatable ids: *"TODO: replace this check in next breaking check with include(':')"*). The
 * consequence was that **no scheduled job in this product had ever fanned out** — no email was ever
 * sent, no retention swept, no expiry fired, no chain verified — while the outbox dispatcher worked
 * perfectly, because `outbox:<row>:<lane>` is three parts by coincidence.
 *
 * It has to be an integration test against a real broker, and that is the whole point. The refusal
 * is a rule inside `bullmq`, enforced when a job is added; a unit test with a fake queue would
 * assert that our own sanitiser did what we wrote it to do, which is precisely the assurance that
 * was missing. What is asserted here is that the **broker accepts** what this product derives.
 */

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const LANE = QueueName.NOTIFICATIONS_DELIVER;

/** The shapes this product actually derives, one per site that composes an identifier. */
const DERIVED_IDS = [
  // The scheduled fan-outs — notification, retention, delegation, webhook. Each embeds the
  // firing's own repeatable job id, which is where the colons come from.
  'notifications.deliver-tenant:all:019489f0-0000-7000-8000-0000000000a1:repeat:notifications.deliver:1786261920000',
  'retention.sweep-tenant:019489f0-0000-7000-8000-0000000000a1:repeat:retention.sweep:1786261920000',
  // Audit chain verification.
  'audit:verify:019489f0-0000-7000-8000-0000000000a1:repeat:audit.verify-chain:1786261920000',
  // Search projection and reprojection, which carry a cursor rather than a firing.
  'search:project:019489f0-0000-7000-8000-0000000000a1:3',
  'search:reproject:019489f0-0000-7000-8000-0000000000a1:0',
  // Too *few* colons rather than too many — the other half of the same rule.
  'ocr:019489f0-0000-7000-8000-0000000000a1',
  'wf-timer:019489f0-0000-7000-8000-0000000000a1',
  // The at-cap requeue, whose input is a job id that may itself contain colons.
  'repeat:notifications.deliver:1786261920000:requeued:1',
  // And the one shape that was always accepted, so the fix is shown not to have broken it.
  'outbox:019489f0-0000-7000-8000-0000000000a1:notifications.deliver',
];

let adapter: BullMqQueueAdapter;
let inspector: Queue;

beforeAll(async () => {
  const config = {
    redis: { url: REDIS_URL },
    queue: { consumersEnabled: false },
  } as unknown as AppConfig;
  const logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
  } as unknown as Logger;
  const metrics = {
    increment: () => undefined,
    observe: () => undefined,
    gauge: () => undefined,
  } as unknown as Metrics;
  const clock = { now: () => new Date(), timestamp: () => Date.now() } as unknown as ClockPort;

  adapter = new BullMqQueueAdapter(config, logger, metrics, clock);
  inspector = new Queue(LANE, { connection: { url: REDIS_URL } as never });
  await inspector.obliterate({ force: true }).catch(() => undefined);
});

afterAll(async () => {
  await inspector.obliterate({ force: true }).catch(() => undefined);
  await inspector.close();
  await adapter.onModuleDestroy();
});

describe('the identifiers this product derives for its jobs', () => {
  it('are all accepted by the real broker', async () => {
    const refused: { id: string; reason: string }[] = [];
    for (const jobId of DERIVED_IDS) {
      try {
        await adapter.enqueue(LANE, { tenantId: null, probe: jobId }, { jobId });
      } catch (error) {
        refused.push({ id: jobId, reason: error instanceof Error ? error.message : 'unknown' });
      }
    }

    // Named rather than counted, so a regression says *which* shape stopped working.
    expect(refused).toEqual([]);
  }, 30_000);

  /**
   * And the derivation stays a derivation.
   *
   * The sanitiser is a substitution rather than a hash or a truncation, which is what keeps every
   * caller's deduplication meaning what it meant: the same inputs still produce the same
   * identifier, so a redelivered fan-out still coalesces and a re-dispatched outbox row still
   * replaces rather than duplicating. Ten distinct derivations must still be ten distinct jobs.
   */
  it('stay distinct from one another, so deduplication still means what it meant', async () => {
    const waiting = await inspector.getJobs(['waiting', 'delayed', 'active', 'completed']);
    expect(new Set(waiting.map((job) => job.id)).size).toBe(DERIVED_IDS.length);
  }, 30_000);
});
