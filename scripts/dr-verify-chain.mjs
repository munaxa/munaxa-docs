#!/usr/bin/env node
// Fires the audit chain verification **now**, on a deployment that is already running — Phase 6.10.
//
// `backup-and-restore.md` §3 makes chain verification the condition that decides whether a restore
// passed: *"Every other check on a restored database — row counts, a document opening, a search
// returning — passes just as well on a database that has been silently altered."* The verifier that
// settles it is a **schedule** (`audit.verify-chain`, `30 1 * * *`) with no route in front of it, so
// a rehearsal has two choices: wait until half past one, or put the schedule's own job on the
// schedule's own lane.
//
// This does the second, and it changes nothing about the control. The payload is the one
// `AuditLaneConsumer.onApplicationBootstrap` registers, the lane is the one it subscribes to, and
// the code that runs is `AuditVerificationService.verify()` in the API process against the database
// that process is connected to. The clock is what is replaced, and only the clock.
//
//   REDIS_URL=… node scripts/dr-verify-chain.mjs
//
// Enqueues and exits. What the verification concluded is on the deployment's own log stream, which
// is where the caller reads it.

import { createRequire } from 'node:module';

// Resolved from `apps/api`, which is the workspace that depends on the broker client. This script
// lives beside the other operator tooling rather than inside the API for the same reason
// `migrate-tenants.mjs` does — it has to run without the application being built — but the client
// it needs is the application's.
const fromApi = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { Queue } = fromApi('bullmq');
const IORedis = fromApi('ioredis');

const connection = new IORedis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', {
  maxRetriesPerRequest: null,
});

// The lane by its catalogue name. `audit.verify-chain` is scheduled onto `audit.export`, which is
// the queue `AuditLaneConsumer` subscribes to — a literal here rather than an import because this
// script runs outside the API's module graph, and the name is asserted by the enqueue arriving.
const queue = new Queue('audit.export', { connection });

await queue.add('audit.export', { kind: 'audit.verify-fanout' });

await queue.close();
await connection.quit();
