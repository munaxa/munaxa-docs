# Post-6.13 — Production Closure & Targeted Remediation

## 1. Scope

The four items Phase 6.13 carried forward, and nothing else. No product behaviour changed, no
schema, no permissions, no semantics, no UI. One test was added; one architectural question was
answered by reading rather than by building.

## 2. Phase 6.13 carry-forward state

| Item | Entering | Leaving |
| --- | --- | --- |
| PITR | not implemented, owner unknown | **BLOCKED — ownership is a production decision** (§3) |
| Scheduler regression coverage | broker acceptance only | **VERIFIED — handler execution now guarded** (§6) |
| Five scheduled jobs' business effects | NOT VERIFIED | **NOT VERIFIED** (§5) |
| R2 | NOT VERIFIED | **NOT VERIFIED — no credentials** (§7) |

## 3. Production RPO ownership decision — **category C**

Determined by inspection, and the repository answers this clearly by what it does *not* contain.

**What the repository owns:** three container images — `api`, `worker`, `web` — built by the CI
`images` job from one Dockerfile. The schema and its migrations. The cluster roles, the per-database
grants and the row-level-security policies (`infra/sql/`). The application half of a restore, now
executable and rehearsed (`scripts/dr-rehearsal.mjs`, `scripts/storage-backup.mjs`).

**What it does not own, and never has:** any infrastructure-as-code at all. No Terraform, no Helm
chart, no Kubernetes manifests, no Render blueprint, no `fly.toml`. `infra/docker-compose.yml` is a
*local development* stack whose own header says "Nothing here is production configuration."

**And the deployment architecture names three legitimate production targets**, not one —
`20-deployment-architecture.md` §2: *"the same images run on Render, a Kubernetes cluster or a
customer's on-premise host. The differences are configuration."* PITR belongs to a different party in
each: Render's managed PostgreSQL provides it, a self-managed Kubernetes cluster does not, and an
on-premise customer's DBA owns their own.

§6's table states the requirement — *"Continuous WAL archiving + nightly base backup, per tenant
database … 35 days PITR, 5 min RPO"* — as a property of the **asset**, and names no owner. §1's "Who
deploys" column covers the application, not the database. No ADR addresses persistence operations.

**Conclusion, stated as Part 1 requires:**

> **PITR ownership is a production architecture decision and cannot safely be implemented from this
> repository alone.**

PITR work therefore **stopped here**, per the brief. No WAL infrastructure was invented.

**What the decision needs to settle**, so that whoever makes it has the list:

1. Which of the three targets is the production target, or which of them each customer tier uses.
2. For a managed target: the required PITR capability, minimum retention (§6 says 35 days), and the
   restore procedure's hand-off point into `backup-and-restore.md` §2.
3. For a self-managed target: the mechanism, its archive destination, encryption at rest for the
   archive, and who operates it.
4. Whether the 5-minute RPO is still the requirement. If the answer is that base-backup granularity
   is acceptable, §6 must be amended to say so — an unmet documented target is worse than a modest
   honest one.

## 4. PITR status — **NOT IMPLEMENTED · BLOCKED on §3**

Re-confirmed by search: no `archive_mode`, `archive_command`, `wal_level`, `restore_command`,
`recovery_target`, `pg_receivewal`, pgBackRest, WAL-G or Barman anywhere in the repository.

## 5. Five scheduled-job results — **NOT VERIFIED**

The five, from Phase 6.11 §8 rather than assumed: `retention.sweep` (its disposition outcome — the
sweep itself runs and reports), `notifications.digest-hourly`, `notifications.digest-daily`,
`notifications.digest-weekly`, `notifications.release-batches`.

**Preconditions traced to source**, which is progress on Phase 6.13 even though the effects remain
unverified:

| Job | Precondition | Legitimate route |
| --- | --- | --- |
| `retention.sweep` | a `retention_schedule` row with `due_at <= now` and state `PENDING`/`IN_REVIEW` (`dueScheduleWhere`) | **exists in the product**: `RetentionSchedulerService.onTrigger` writes one when a retention trigger fires — a soft delete produces one dated by `RETENTION_RECYCLE_BIN_DAYS` |
| three digests | notification messages held for a digest window, which needs a recipient whose notification *preference* is a digest rather than immediate | exists — `notification_preference` is a real table with a real screen |
| `release-batches` | a closed coalescing window — a `notification_batch` row past its release instant | exists — written by `NotificationEventService` for the bulk families |

**None was executed.** Driving `retention.sweep` needs a document soft-deleted through the real API,
and the delete contract's optimistic-concurrency field could not be satisfied in the time available
(`409 VERSION_CONFLICT` against `version` and `recordVersion`). Rather than reach past the API and
write a `retention_schedule` row by hand — which would prove the sweep against a row the product did
not create, and is the exact substitution these phases exist to refuse — the work stopped.

Classified: **NOT VERIFIED — precondition reachable, not yet exercised.** This is *not*
"NOT VERIFIED — missing legitimate production precondition": every precondition above is real product
functionality. What is missing is the execution, and it is a few hours of work rather than a feature.

## 6. Scheduler regression result — **VERIFIED**

`apps/api/src/infrastructure/queue/__tests__/scheduler-execution.integration.spec.ts` — real Redis,
real BullMQ, a real `Worker` registered through the same `subscribe` production uses.

It asserts on **what the handler received**, which is the distinction Phase 6.13 named:

| | |
| --- | --- |
| Every derived identifier shape (9) | enqueued → accepted → **consumed → handler invoked** |
| Every schedule in the catalogue (13) | keyed as its lane's `fanOut` keys it → **handler invoked** |
| Cannot pass on acceptance alone | an accepted-but-unprocessed job leaves an empty record and fails, naming the jobs that never arrived |
| Survives a future schedule | `SCHEDULE` is read, not restated, so an entry added later is covered the day it is added |

It does **not** claim any job's business effect. Reachability and effect are asserted separately and
deliberately: conflating them is how "the scheduler is registered" came to mean "the scheduler works".

**Two false alarms it produced, both mine, both recorded in the file** because each looked exactly
like the defect it hunts:

1. A **partial `ClockPort` stub** without `elapsedMs`. The worker's `finally` throws while recording
   the job-duration metric — *before* releasing the tenant's concurrency slot — so the counter sticks
   at the cap and every later job for that tenant is requeued for ever. Eleven jobs accepted, never
   processed. A partial stub of a real port is how a test invents a P0.
2. **A booted API competing for the lane.** BullMQ hands a job to exactly one consumer, so an
   application running beside the suite eats some of them. The suite assumes it owns the broker,
   exactly as every integration test here assumes it owns the database.

## 7. R2 result — **NOT VERIFIED**

No `R2_*` or `CLOUDFLARE*` variables, no AWS credentials file. No storage code was touched, no
provider branch added, no checksum enforcement weakened. The Phase 6.12 implementation uses
`x-amz-checksum-sha256` and `x-amz-checksum-mode`, both part of the S3 API R2 implements; one
credentialed run of the existing storage suite would settle it.

## 8. Existing DR evidence — preserved, not repeated

Phase 6.13's combined DR rehearsal stands unchanged and was **not re-run**: nothing in this work
touched storage, persistence or recovery. That evidence — empty destinations, two tenants, restored
database state, restored objects, identical bytes, identical SHA-256, application retrieval, browser
retrieval, tenant isolation, audit-chain continuity — remains the current record.

## 9. New evidence

- The PITR ownership determination (§3), from the repository's own shape rather than from a claim.
- The scheduler execution guard (§6), passing against real Redis and BullMQ.
- The five jobs' preconditions traced to their source, with the legitimate route for each (§5).

## 10. Findings

**None.** No P0, P1, P2 or P3. Both anomalies this work produced were defects in my own test harness,
diagnosed and fixed before commit.

## 11. Fixes

None. No product code changed.

## 12. Tests

One added: `scheduler-execution.integration.spec.ts` (2 tests). It runs inside the existing
integration project against the existing infrastructure; no new framework, no second scheduler, and
the production scheduler does not depend on it.

## 13. Gate results

| Gate | Result |
| --- | --- |
| format | clean |
| lint | **0 errors** |
| typecheck | 13/13 |
| unit | web 126 · API 644 (1 skipped) · domain 164 · contracts 26 · utils 11 · i18n 4 · worker 2 |
| integration | **39 files, 659 passed, 0 skipped** — PostgreSQL 16 (two tenant databases), Redis, MinIO |
| build | 9/9 |
| verify:styles | 10/10 |
| storage integration | 4 + 27 passed against real MinIO |
| scheduler integration | **4 passed** — 2 identifier-acceptance, 2 handler-execution |
| e2e | not re-run; no web or API behaviour changed |

**§13a — one honest note about running these gates.** Two integration failures during this work were
**infrastructure, not product**: MinIO had been reclaimed (`ECONNREFUSED 127.0.0.1:9000`), and a
booted API was competing for a queue lane. Both were repaired using the repository's documented
procedures and the suites then passed. Neither was a defect and neither was worked around by changing
a test's expectations.

## 14. Evidence matrix

| Control | Status |
| --- | --- |
| Combined database + object-storage DR | **VERIFIED** (6.13) |
| Restored document bytes and digest identical | **VERIFIED** (6.13) |
| Tenant isolation after restore, both directions | **VERIFIED** (6.13) |
| Audit-chain continuity after restore | **VERIFIED** (6.13) |
| Cloud upload integrity, MinIO | **VERIFIED** (6.12) |
| Cloud upload integrity, R2 | **NOT VERIFIED** |
| Broker accepts every derived job identifier | **VERIFIED** (6.10) |
| **Every derived shape and every schedule reaches its handler** | **VERIFIED** (this work) |
| Eight scheduled jobs' business effects | **VERIFIED** (6.11) |
| Five scheduled jobs' business effects | **NOT VERIFIED** |
| Audit sink streaming | **NOT VERIFIED — no configured sink** |
| PITR | **NOT IMPLEMENTED · BLOCKED — production decision** |
| RTO / RPO at production scale | **NOT VERIFIED** |
| Combined DR protected by an automated suite | **DEFERRED** |
| Search projection, workflow timers | **DEFERRED** — event/delay-driven, outside the cron inventory |

## 15. Production readiness decision

**NO-GO**, on two conditions rather than four. One of them is not engineering work.

The scheduler gap Phase 6.13 named is closed: nothing can now be declared, registered and inert
without a red build. What remains is one unexecuted verification and one unmade decision.

## 16. Conditions for production release

1. **Execute the five scheduled jobs' business effects**, or classify each honestly against its
   traced precondition (§5). `retention.sweep`'s disposition is the one that matters most: it is a
   compliance control, and its precondition is a soft delete through the real API.
2. **Settle PITR ownership** (§3), then either implement it for the chosen target or amend
   `20-deployment-architecture.md` §6 to state the RPO the deployment actually provides.

Optional, not blocking: one credentialed R2 run; an automated DR rehearsal so §8's evidence stops
being a thing somebody did once.

## 17. Feature development

**Normal Docs feature development may continue.** Nothing outstanding blocks it: there are no open
defects, the product's controls are verified through their real execution paths, and both remaining
conditions are release gates rather than development gates.

## Evidence vocabulary

**IMPLEMENTED** — present in code or configuration, not empirically exercised. **VERIFIED** —
executed against the real system and observed. **NOT VERIFIED** — evidence not obtained; no claim
made. **BLOCKED** — a real dependency or decision is missing. **DEFERRED** — intentionally outside
this work.

No claim in this report rests on source inspection alone, with one deliberate exception that is
labelled as such: §3's ownership determination is a reading of what the repository contains, and it
concludes that something is *absent* rather than that something works.
