# Post-6.13 — Production Closure & Targeted Remediation

> **Second pass — production gate closure.** §§18–24 close the two gates this report left open.
> Gate 1 (the five scheduled jobs' business effects) is **now VERIFIED**; Gate 2 (PITR ownership)
> is **still BLOCKED on a human decision**. Two product defects were found on the way, one fixed
> and one reported. §§1–17 are the first pass and are left as written; where the second pass
> supersedes them it says so.

## 1. Scope

The four items Phase 6.13 carried forward, and nothing else. No product behaviour changed, no
schema, no permissions, no semantics, no UI. One test was added; one architectural question was
answered by reading rather than by building.

*Second pass:* one product defect fixed (§21), one regression test added, one defect reported and
not fixed (§22). No schema, no permissions, no semantics, no UI.

## 2. Phase 6.13 carry-forward state

| Item | Entering | Leaving |
| --- | --- | --- |
| PITR | not implemented, owner unknown | **BLOCKED — ownership is a production decision** (§3, §23) |
| Scheduler regression coverage | broker acceptance only | **VERIFIED — handler execution now guarded** (§6) |
| Five scheduled jobs' business effects | NOT VERIFIED | **VERIFIED** — superseded by §19 |
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

## 5. Five scheduled-job results — **NOT VERIFIED** *(superseded by §19: all five are now VERIFIED)*

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
| Five scheduled jobs' business effects | **VERIFIED** (second pass, §19) |
| Retention disposition observed refusing, then destroying after approval | **VERIFIED** (§20) |
| Bulk-operations API reachable | **VERIFIED after a P1 fix** (§21) |
| Revoked-delegation notification | **NOT PRODUCED — P2, reported** (§22) |
| Audit sink streaming | **NOT VERIFIED — no configured sink** |
| PITR | **NOT IMPLEMENTED · BLOCKED — production decision** |
| RTO / RPO at production scale | **NOT VERIFIED** |
| Combined DR protected by an automated suite | **DEFERRED** |
| Search projection, workflow timers | **DEFERRED** — event/delay-driven, outside the cron inventory |

## 15. Production readiness decision *(first pass — superseded by §25)*

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

---

# Second pass — production gate closure

## 18. What this pass did

Two gates were open. Both were driven to an answer against a running deployment — the API built
from this commit, real PostgreSQL, real Redis, the real broker, the real schedules — with every
precondition created through the product's own API.

Nothing was inserted into PostgreSQL to make a job run. No scheduler state was fabricated, no
business handler was called directly, no event was constructed, no test-only route was added, no
authorization or validation was weakened, no optimistic-concurrency check was bypassed, and the
scheduler was not modified to make any of this easier. Where something could not be reached the
answer was to find the product's real route to it, and twice that search found a defect instead.

**The one substitution, stated plainly: the clock.** For `retention.sweep` and the three digests the
API process was run under `faketime` at a later instant. It is a substitution because the product
has no route to it — and deliberately so. A retention policy's period is a whole number of months
and the contract refuses zero ("state how long the record is kept before this disposition runs");
the recycle-bin window's minimum is one day; a digest window closes on the hour, the tenant's
morning, or Monday. Every one of those is the product declining to dispose of a record or send a
digest sooner than a person configured, which is the behaviour a records system should have. So the
alternative to moving the clock was to wait a month. Nothing else was moved: the schedule rows, the
documents, the delegations, the batches, the messages and the audit rows are all the product's own,
written by the product, at the product's own instants.

## 19. Gate 1 — the five scheduled jobs' business effects

| Job | Result | The business effect that was observed |
| --- | --- | --- |
| `retention.sweep` | **VERIFIED** | A real soft delete created a schedule; the sweep refused to destroy and demanded review; a records manager approved through the real API; the next sweep purged the document, wrote a tombstone and left the trail (§20) |
| `notifications.release-batches` | **VERIFIED** | Three real bulk operations coalesced into one window; the schedule fired **on its own cron**, closed the window, and produced one summary — "Your bulk operation over 3 item(s) has finished" |
| `notifications.digest-hourly` | **VERIFIED** | One held message, window `HOURLY`, collected into `Munaxa Docs: 1 update(s) in the last hour`; the member moved `HELD → DIGESTED` with a foreign key to the summary |
| `notifications.digest-daily` | **VERIFIED** | The same, window `DAILY` → `1 update(s) since yesterday` |
| `notifications.digest-weekly` | **VERIFIED** | The same, window `WEEKLY` → `1 update(s) in the last week` |

**Idempotency.** Every one of the four schedules was fired again after it had done its work. The
sweep reported `purged: 0, archived: 0, reviewed: 0`; the digests collected nothing and produced no
second summary; `release-batches` found no window. Message count, summary count and batch count were
unchanged: 8, 3, 0.

**Tenant isolation.** Both tenants are in the fan-out and each pass ran for both. The neighbouring
tenant's database ended the pass exactly as it began — 1 document, 0 schedules, 0 batches, 0
notification messages, 29 audit events — while the first tenant's document was purged. Isolation
here is ADR-0015's, one database each, and the sweep observed it.

**Email delivery is not claimed.** `MAIL_DRIVER=NONE` in this environment, so a queued email fails
at the transport, visibly, and one row records that. What the digest jobs are *for* — collecting a
closed window into one summary per recipient and marking the members as carried by it — is what was
verified. The transport is a separate control and is not claimed here.

## 20. `retention.sweep` in full, because it is the compliance control

Six steps, in order, each through the product:

1. **A retention policy**, created through `POST /admin/retention-policies` — `ON_DELETE`, one
   month, `PURGE`. A second, `ARCHIVE`, beside it.
2. **Two document types** naming them, through `POST /admin/document-types`. A document's policy is
   frozen from its type when it is created, which is ADR-0010's accepted alternative 3.
3. **Two documents**, created through `POST /documents`. The first attempt used a freshly uploaded
   blob and was **refused** — `409 CONTENT_NOT_SCANNED` — because `AV_DRIVER=NONE` means the scanner
   cannot be reached and `StorageService.scan` answers `SKIPPED` rather than `CLEAN`. That is the
   malware gate failing closed, observed rather than assumed, and it was not worked around: the
   fixture's existing scanned blob was used instead.
4. **A real soft delete** — `DELETE /documents/:id` with `If-Match`, the optimistic-concurrency
   header the contract actually specifies. `204`. The product then wrote both `retention_schedule`
   rows itself: `PURGE`, due in a month, `review_required = true` — **forced true even though the
   policy said false**, because `proposeSchedule` requires review for an irreversible disposition.
5. **The sweep, through the real schedule.** `scripts/run-schedule.mjs retention.sweep` puts the
   lane's own registered payload on the lane; the consumer fans out per tenant; each tenant job runs
   the real service in the real tenant context. It reported `reviewed: 1, archived: 1, purged: 0` —
   it archived the one whose policy said archive, and **refused to destroy** the one awaiting
   review. The archived document's status became `ARCHIVED`, its schedule `EXECUTED`.
6. **Approval, then destruction.** `POST /retention/dispositions/:id/approve` moved the schedule to
   `IN_REVIEW`; the next sweep reported `purged: 1`. The document row is gone. A
   `document_tombstone` records the title, the type, the folder, the schedule, the policy, the
   approver and that one revision was removed. The trail reads
   `SCHEDULE_SET → ARCHIVED → PURGE_EXECUTED → DISPOSITION_APPROVED → PURGED → PURGE_EXECUTED`,
   hash-chained, and `audit.verify-chain` verified all 38 events afterwards.

An earlier attempt is worth recording because it looked like a defect and was not: deleting a
*numbered* document with no retention policy produced **no schedule at all**. That is
`proposeSchedule` returning null exactly as documented — the recycle-bin window is only for a
document that was never numbered, and a numbered record with no policy has nothing to compute a
date from. The product was right and the first hypothesis was wrong.

## 21. Defect found and fixed — **P1: the bulk-operations API was unreachable**

`POST /documents/bulk/restore` answered `500`. So did `GET /documents/bulk`.

**Cause.** Nest matches routes in the order controllers are registered, and `DocumentsController`
was registered before `BulkDocumentsController`. `POST /documents/:id/restore` and
`GET /documents/:id` therefore matched first: `bulk` bound to `:id`, `AclGuard` asked the resolver
to resolve a `DOCUMENT` scope whose identifier was the literal string `bulk`, and Prisma rejected it
as an invalid UUID. Two shipped routes had been reachable only as errors since Phase 16 — the same
class this sequence has now met three times: declared, wired, tested in isolation, and never
actually exercised end to end.

**Not a security hole.** The nonsense scope failed *closed*, in the guard, before any handler ran.
Nothing was authorised that should not have been; the routes simply did not work.

**Fix.** One line of ordering in `document.module.ts`: the controller whose paths begin with a
literal segment is registered before the controller whose paths begin with a parameter. No route was
renamed, no contract changed, no guard weakened.

**Regression test.** `document-route-order.spec.ts` asserts the ordering — the property that *is*
the defect — rather than asserting a response that would need a database, a tenant and a deleted
document to reach.

**The affected workflow was re-run in full**, not just the failing call: `GET /documents/bulk`
returns the operation list; `POST /documents/bulk/restore` restores the document and reports
`applied: 1`; an identifier that does not exist is `REFUSED` with `FORBIDDEN` rather than a `404`,
which is the product refusing to let a bulk request be used to probe for identifiers.

## 22. Defect found and **not** fixed — **P2: a revoked delegation tells nobody**

`18 §4` names the message; `NotificationEventService.delegationEvent` builds it for the delegator
and the delegate; nothing arrives.

**Cause.** `DelegationRevokedPayload` is `{delegationId, revokedBy, reason}`. The consumer reads
`delegatorId` and `delegateId` and returns zero when either is absent. Three real revocations were
published, dispatched and consumed, and produced no notification message.

**Why it is reported rather than fixed.** The obvious fix is to put the two identifiers on the
event — and `domain/events.ts` states, and the retention code repeats, that **an event's shape never
changes once shipped**; that is what `event_version` exists for. The other fix is for the consumer to
read the delegation row, which gives the notification module a new cross-module read. Both are
product decisions rather than the minimal fix this pass was permitted to make, so the finding is
recorded with its two options and left for a decision.

`delegation.approved` and `delegation.expired` carry both identifiers and are unaffected.
`delegation.requested` correctly produced nothing here: its recipients are whoever must agree, and
this tenant's delegator has no approver — an empty list rather than a defect.

## 23. Gate 2 — PITR ownership and RPO — **BLOCKED, unchanged**

Re-checked from scratch rather than restated. There is still **no infrastructure-as-code of any
kind** in this repository: no Terraform, no Helm chart, no Kubernetes manifests, no `render.yaml`, no
`fly.toml`. There is still no `archive_mode`, `archive_command`, `wal_level`, `restore_command`,
`recovery_target`, `pg_receivewal`, pgBackRest, WAL-G or Barman. And no document names a production
target: `20-deployment-architecture.md` §2 still names three, and PITR belongs to a different party
in each.

> **PITR ownership is a production architecture decision and cannot safely be implemented from this
> repository alone.**

| Gate 2 item | Status |
| --- | --- |
| A named production target | **ABSENT** — three are named, none chosen |
| Infrastructure-as-code for any of them | **ABSENT** |
| WAL archiving / continuous backup | **NOT IMPLEMENTED** |
| Documented RPO (`20-deployment-architecture.md` §6: 5 minutes) | **UNMET** |
| Documented "restore that tenant's database alone, **to the minute**" (§10 of the same file) | **UNSUPPORTED** — a second place the documentation promises PITR |
| Ownership decision | **BLOCKED — a person's decision, not an engineering task** |

The second row of that table is new to this pass and worth naming: the deployment architecture
promises point-in-time restore in two separate places. Whatever is decided, both have to end up
saying the same thing as the deployment actually does.

## 24. Second-pass gate results

| Gate | Result |
| --- | --- |
| format | clean |
| lint | **13/13, 0 errors** |
| typecheck | **13/13** |
| unit | API **645 passed** (1 skipped) — one more than the first pass, the new route-order guard · domain 164 · web 126 · contracts 26 · utils 11 · i18n 4 · worker 2 |
| build | **9/9** |
| retention.sweep, live | `reviewed 1 · archived 1` then `purged 1` then `0 0 0` |
| release-batches, live | one summary over 3 items, on its own cron |
| three digests, live | `produced: 1` each; three `digest.summary` messages |
| tenant isolation | neighbouring tenant unchanged across every pass |

## 25. Two decisions, taken separately

**Product development: GO.** There is nothing outstanding that blocks feature work. The one open
defect (§22) is a missing notification in one delegation path, not a broken foundation; the P1 in
§21 is fixed and guarded; every control this pass touched was exercised through its real execution
path and behaved as its documentation says.

**Production release: NO-GO**, on **one** condition rather than two. Gate 1 is closed: the five
remaining scheduled jobs have been observed producing their business effects, idempotently, with
tenant isolation intact, and the compliance control among them — retention disposition — has now
been watched refusing to destroy a record until a person approved it, and then destroying it and
leaving the trail.

What remains is Gate 2, and it is not engineering work:

1. **Settle PITR ownership** (§3, §23) — choose the production target, then either implement PITR
   for it or amend `20-deployment-architecture.md` §6 and §10 to state the RPO the deployment
   actually provides. An unmet documented target is worse than a modest honest one.

Optional and non-blocking, as before: one credentialed R2 run; an automated DR rehearsal; and a
decision on §22.

## Evidence vocabulary

**IMPLEMENTED** — present in code or configuration, not empirically exercised. **VERIFIED** —
executed against the real system and observed. **NOT VERIFIED** — evidence not obtained; no claim
made. **BLOCKED** — a real dependency or decision is missing. **DEFERRED** — intentionally outside
this work.

No claim in this report rests on source inspection alone, with one deliberate exception that is
labelled as such: §3's ownership determination is a reading of what the repository contains, and it
concludes that something is *absent* rather than that something works.
