#!/usr/bin/env node
// Fires a declared schedule **now**, on a deployment that is already running — Phase 6.11.
//
// Generalises `scripts/dr-verify-chain.mjs`, which did this for `audit.verify-chain` alone. Phase
// 6.10 found that every scheduled job in this product had been refused by the broker since the
// first one was written, fixed it, and left the honest statement that the schedules were now
// *reachable* rather than *proven*. Proving them means running each one and looking at what it did
// — and none of them can be run, because a schedule is a cron expression with no route in front of
// it. Waiting for 02:00 is not a verification strategy.
//
// ## What is substituted, and what is not
//
// **Only the clock.** The payload is the one the lane's own `onApplicationBootstrap` registers —
// `{ kind: '<name>-fanout' }` — put on the queue the catalogue names for that schedule. From there
// everything is the product: BullMQ delivers it, the lane's consumer fans it out per tenant through
// `TENANT_REGISTRY.all()`, and each tenant job runs the real service inside the real tenant context.
//
// That distinction matters for what the evidence is worth. A test that called
// `RetentionService.executeDue()` directly would prove the service; this proves the *schedule* —
// the registration, the payload shape, the fan-out, the job id the broker has to accept, the
// per-tenant context, and the service, in the order production runs them.
//
//   node scripts/run-schedule.mjs retention.sweep
//   node scripts/run-schedule.mjs --all
//   node scripts/run-schedule.mjs --list
//
// Exits as soon as the job is enqueued. What the schedule concluded is on the deployment's own log
// stream, and in the rows it changed, which is where the caller looks.

import { createRequire } from 'node:module';

// Resolved from `apps/api`, which is the workspace that depends on the broker client — the same
// arrangement `dr-verify-chain.mjs` uses, and for the same reason: this is operator tooling that
// must run without the application being built.
const fromApi = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { Queue } = fromApi('bullmq');
const IORedis = fromApi('ioredis');

/**
 * The catalogue, read from the built domain package.
 *
 * Read rather than restated. A schedule this script did not know about is exactly the schedule that
 * would stay unverified, and Phase 6.10's whole finding was a control nobody had run.
 */
const { SCHEDULE } = fromApi('@edms/domain');

const argument = process.argv[2];

if (argument === '--list' || argument === undefined) {
  for (const entry of SCHEDULE) {
    process.stdout.write(`${entry.name.padEnd(34)} ${entry.queue.padEnd(24)} ${entry.cron}\n`);
  }
  process.exit(argument === undefined ? 1 : 0);
}

const wanted =
  argument === '--all' ? SCHEDULE : SCHEDULE.filter((entry) => entry.name === argument);

if (wanted.length === 0) {
  console.error(`No schedule named '${argument}'. Run with --list.`);
  process.exit(1);
}

const connection = new IORedis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', {
  maxRetriesPerRequest: null,
});

/**
 * The payload the **broker itself is holding** for this schedule — not one this script composed.
 *
 * The first version derived it as `{ kind: '<name>-fanout' }`, which is what four of the five lanes
 * register, and `audit.verify-chain` registers `{ kind: 'audit.verify-fanout' }` — a literal that
 * does not contain its own schedule's name. So the derived payload was dropped as unrecognised, and
 * for a moment that looked like a defect in the product rather than in the tool.
 *
 * Reading it instead removes the guess entirely. Each lane's `onApplicationBootstrap` upserts a
 * repeatable job whose next occurrence sits in the queue as a delayed job keyed
 * `repeat:<name>:<epoch>`, carrying the exact `data` the cron will deliver. Copying that is
 * replaying the firing rather than imitating it — and it additionally proves the registration
 * exists, because a schedule no lane registered has nothing here to copy.
 */
async function registeredPayload(queue, name) {
  const pending = await queue.getJobs(['delayed', 'waiting', 'paused']);
  const occurrence = pending.find((job) => (job.id ?? '').startsWith(`repeat:${name}:`));
  return occurrence?.data ?? null;
}

const fired = [];
const missing = [];
for (const entry of wanted) {
  const queue = new Queue(entry.queue, { connection });
  const payload = await registeredPayload(queue, entry.name);
  if (payload === null) {
    // Not fired, and named. A schedule with no registered occurrence is one no consumer declared,
    // which is a finding rather than something to paper over with an invented payload.
    missing.push({ name: entry.name, queue: entry.queue });
  } else {
    await queue.add(entry.queue, payload);
    fired.push({ name: entry.name, queue: entry.queue, payload });
  }
  await queue.close();
}

await connection.quit();
process.stdout.write(`${JSON.stringify({ fired, missing })}\n`);
process.exit(missing.length > 0 ? 1 : 0);
