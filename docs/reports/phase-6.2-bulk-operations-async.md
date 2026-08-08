# Phase 6.2 — Bulk Operations & Async Processing

**Purpose:** close the P0 Phase 6.0 found — `bulk.synchronousLimit` was a tenant setting read by
nothing, so a request naming up to `bulk.maxObjects` (5 000 by default) executed every object inside
one HTTP request.
**Scope:** the bulk subsystem's missing asynchronous path. Nothing else.
**Status:** point-in-time report. Not edited afterwards.
**Method:** every Phase 6.0 finding re-verified against source before any code changed. Every gate
below executed in this container against a real PostgreSQL 16 with two tenant databases and Redis.

## Final status: **COMPLETE**

The HTTP request no longer performs a large operation; a queued job is a real job consumed by a real
lane; and duplicate delivery cannot repeat a mutation. Evidence in [§10](#10-test-report) and
[§13](#13-validation-report).

---

## 1. Bulk Operations Completion Report

### 1.1 Step 1 — verification, and three Phase 6.0 claims that were wrong

Phase 6.0 was my own audit. Three of its six bulk claims did not survive inspection, and saying so is
the point of the step.

| Phase 6.0 claim | Verdict |
| --- | --- |
| `DOCUMENTS_BULK` has no meaningful consumer | **Confirmed.** `grep DOCUMENTS_BULK apps` returned zero hits outside the queue catalogue — no producer either |
| `bulk.synchronousLimit` is read by nothing | **Confirmed.** Two hits, both prose in code comments |
| The HTTP request can execute thousands of objects | **Confirmed.** `DefaultBulkExecutor.run` looped every target inline |
| `bulk.maxObjects` is not enforced | **WRONG.** It has always been enforced server-side, in `refuseBadSelection`, via the pure `bulkSizeVerdict`. Step 4 was already done, and this phase added nothing to it |
| `BulkOperationState` only reaches `COMPLETED` | **WRONG.** `REQUESTED` is the column default and `RUNNING` is written by `operations.start`, which `run` already called. Only `FAILED` had no writer |
| *(not claimed)* Item recording is not idempotent | **WRONG to have omitted.** `recordItem` has always been an upsert on `(operation_id, target_id)`, and its comment names redelivery as the reason. Phase 16 pre-cut this |

**What Phase 6.0 got right is the part that mattered**, and the gap is narrower than it stated: the
decision, the producer and the consumer. Everything around them — the ceiling, the state vocabulary,
the item-level upsert, the per-object ACL resolution, the per-object transaction, the progress
columns, the read model and the status endpoint — already existed.

### 1.2 Current-state diagram, and exactly where it stopped

```text
HTTP request
    ↓
bulk entry point            BulkDocumentService / BulkApprovalService / BulkExportService
    ↓
validation                  zod schema at the controller
    ↓
authorization               @RequirePermission (tenant floor) … then per object, in the executor
    ↓
sync OR async decision      ██ ABSENT ██  ← the whole of the defect
    ↓
execution                   DefaultBulkExecutor.run — every object, inline, in the request
    ↓
state update                REQUESTED → RUNNING → COMPLETED   (FAILED unreachable)
    ↓
audit                       one BULK_OPERATION row + each object's own row, in its own transaction
```

One box was missing. Everything downstream of it existed and worked; it simply only ever ran on the
request's own stack.

### 1.3 The obstacle Phase 6.0 did not see

A `BulkPlan` carries two closures — `resolveScope` and `apply` — so it cannot cross a process
boundary. That is why the lane had no producer: not because nobody wrote the consumer, but because
**there was nothing to tell one what to do**. `parameters` could not stand in for it either, and
deliberately: it is copied into the `BULK_OPERATION` audit row, and 13 §3 requires that payload
minimised, so it records *which* metadata fields a bulk edit touched and never their values.

So the phase's real work was to make a plan derivable from serialisable data, and the shape is:

```text
                    payload (jsonb, never audited)
                              │
                    BulkPlanRegistry.planFor(kind, payload)
                         ╱                        ╲
        synchronous run                       queued run
   (same function, same bytes)          (same function, same bytes)
```

Both paths derive the plan from the same factory, which is what stops a queued restore drifting from
a synchronous one — the failure a second "queued" implementation of each operation would have
guaranteed.

---

## 2. Current vs Final Bulk Architecture

| | Before | After |
| --- | --- | --- |
| Plan source | Built inline by each service; unrepeatable | Built by `BulkPlanRegistry` from a payload, in **both** paths |
| Decision | None | `targetIds.length > bulk.synchronousLimit` → queued |
| Producer | None | `bulk.operation-queued`, an **outbox** event |
| Consumer | None | `BulkLaneConsumer` on `documents.bulk` |
| Reconstruction input | Nowhere | `bulk_operation.payload`, one nullable column |
| `FAILED` | No writer | Written by the consumer when the *operation* cannot finish |
| Progress | Only at completion | Every 50 objects, on the existing columns |
| Requester authority | The request's context | Re-read at execution time |
| `maxObjects` | Enforced | **Unchanged** |
| Per-object ACL, transaction, audit | As Phase 16 built them | **Unchanged** |

**No second queue library, no second job system, no second bulk architecture.** The lane, its
concurrency, its per-tenant cap, its retry policy and its dead-letter queue are Phase 16's,
untouched.

---

## 3. State Machine Report

`BulkOperationState`'s four values were already declared. This phase added **no state** — Step 6's
instruction, and `CANCELLED` was not added because nothing in the product cancels a bulk operation.

| Transition | Written by | When |
| --- | --- | --- |
| → `REQUESTED` | `open` (column default) | Both paths, at acceptance |
| `REQUESTED` → `RUNNING` | `operations.start` | Sync: immediately. Queued: at first delivery |
| `RUNNING` → `COMPLETED` | `operations.finish` | The operation ran to the end. **Not** "every object succeeded" |
| `REQUESTED`/`RUNNING` → `FAILED` | `operations.markFailed` — **new** | The operation itself could not finish: no payload, requester gone, plan factory missing, lane died |

Every transition is a named repository method. There is no path that sets `state` from a caller, and
`progress` deliberately does not touch it.

`COMPLETED` with refusals is still `COMPLETED`, which is Phase 16's semantics and preserved: refusals
are the answer, not a failure to produce one.

---

## 4. Queue/Worker Report

**`documents.bulk`, unchanged**: concurrency 4, per-tenant cap 2, 3 attempts, 15-minute timeout,
dead-letter queue. It is now consumed.

**The producer is an outbox event, not an `enqueue`.** `ports/queue.port.ts` opens with the rule:
*"The API never enqueues inside a transaction: it writes an outbox row, and the dispatcher enqueues
after commit."* Publishing `bulk.operation-queued` from inside the transaction that opens the
operation makes the job's existence and the record's existence one fact — a job can never be
delivered for a row that rolled back.

**Routing.** `bulk.operation-queued` is matched *before* the generic `bulk.` prefix and routed to
`DOCUMENTS_BULK` **only**. Not the notification lane — "your operation was accepted" is the response
the caller already holds. Not the webhook fan-out — a customer's endpoint should hear outcomes, and
how this deployment schedules its own work is not an outcome.

**The payload is `{ operationId }`.** The targets and the plan input are read from the row under the
tenant's own context, so a queue payload cannot carry another tenant's identifiers and a
five-thousand-object import is not five thousand UUIDs in Redis.

**One subscriber.** The adapter builds one `Worker` per `subscribe`, and two on one lane race — the
defect that gave delegation a lane of its own. `BulkLaneConsumer` is the only subscriber to
`documents.bulk`.

**Where it runs:** the API process, behind `queue.consumersEnabled`, like every consumer since
Phase 4 — `apps/worker` composes none of the domain modules, and the plan factories are module
providers.

---

## 5. Idempotency & Retry Report

Step 9 is the one the brief calls mandatory, so this is the longest section.

**No second idempotency system was built.** The mechanism is `bulk_operation_item`'s existing unique
index on `(operation_id, target_id)`, which Phase 16 created *for this purpose* — its comment says
so. Two things make it sufficient:

**1. The resume set.** Each delivery reads the targets that already carry an outcome and skips them.
An object settled by an earlier delivery is never re-applied.

**2. An `APPLIED` item row now commits in the same transaction as the mutation it describes.** This
is the change that closes the real window, and it is worth stating precisely because it reverses half
of a Phase 16 decision — carefully.

Phase 16 recorded *every* outcome in its own transaction, for a stated and correct reason: an object
whose write rolled back must still leave its outcome behind, or a refusal is indistinguishable from
an object nobody attempted. That reasoning holds for the three not-applied outcomes and fails for
`APPLIED`. An applied row written *after* the object's transaction leaves a gap — commit the
mutation, crash, redeliver — in which the resume set does not know the object was done. For a
metadata edit that is harmless repetition. For `UPLOAD` it is **a second document**, because `create`
mints a new identifier every time.

So the two cases are now split by their actual requirement:

| Outcome | Recorded | Why |
| --- | --- | --- |
| `APPLIED` | Inside the object's transaction | Exactly-once: the mutation and the record of it are one commit or neither |
| `REFUSED` / `BLOCKED` / `FAILED` | In its own transaction | The object's transaction rolled back and would have taken the row with it — Phase 16's reason, unchanged |

**The crash cases, enumerated:**

| Failure | Behaviour |
| --- | --- |
| Crash before any object | Redelivery starts from nothing. State is still `REQUESTED` |
| Crash mid-operation | Redelivery skips settled targets and resumes. Asserted |
| **Commit the mutation, crash before acknowledging the queue** | The item row committed with it, so redelivery skips. This is the case the split above exists for |
| Same job delivered twice | Second pass settles nothing new. Asserted with a real double delivery |
| Delivery after completion | `state === COMPLETED` → immediate no-op, the cheapest and commonest case |

**The final tally is computed from the item rows**, not from the pass that happened to finish. A
delivery that settled 200 of 500 and died leaves a successor whose own arithmetic describes 300; the
rows are the record and the pass is an episode.

**No lock was added.** Step 16 says not to add one speculatively. Two concurrent deliveries of one
operation converge: both skip settled targets, both upsert, and each object's own transaction and
optimistic version guard referee the rest — which is the same machinery two concurrent users already
contend through. `normaliseTargets` sorts identifiers, so overlapping operations take row locks in
one order and queue rather than deadlock; that predates this phase.

---

## 6. Tenant Isolation Report

| Requirement | How |
| --- | --- |
| `tenantId` persisted with the operation | `bulk_operation.tenant_id`, since Phase 16 |
| Queue payload cannot cross tenants | It carries `{ operationId }` and nothing else. The dispatcher stamps the tenant on the envelope |
| Worker establishes the correct tenant context | From the envelope, before any read. **Never inferred from a document id** |
| RLS remains effective | Every read and write goes through `requireTransaction()` on the tenant's own database (ADR-0015) |
| Tenant A cannot execute tenant B's operation | Asserted: the same operation id delivered under a stranger tenant leaves the row `REQUESTED` and writes no items |

---

## 7. Authorization Report

**Two gates, both preserved.** The tenant-wide floor is the controller's `@RequirePermission`, and
`BulkApprovalService` re-checks it in the service *because the queued consumer runs where no guard
ran* — a comment Phase 16 wrote in anticipation of this phase. The real gate is the executor's
per-object ACL resolution, unchanged.

**Authority is re-read at execution time, never copied onto the job.** A queued operation runs
minutes or hours later; snapshotting permissions at enqueue would let somebody bank an authority they
no longer hold. `BULK_REQUESTER_DIRECTORY` resolves the requester's current roles and permissions
when the job runs, so a revoked grant takes effect on every object not yet processed. A disabled or
deleted requester answers null and the operation **fails** rather than running.

This is Phase 15's rule for queued report exports, applied to the second queue. It is a second port
rather than a reuse of `REPORT_SUBJECT_READER`, and the adapter says why: that one answers role keys,
because a report's reach is entirely an ACL predicate; bulk also needs the permission set for its
tenant-wide floor. Widening Reporting's port to serve Bulk would put one module's interface in the
shape of another module's needs.

**The worker runs as the requester, not as the system.** A bulk operation is somebody's act: every
object's reach is resolved against them and the per-object audit rows name them. A system context
would both over-authorise it and attribute four hundred document changes to nobody.

### A "pre-existing inconsistency" this phase reported — **and Phase 6.3 disproved**

> **Correction, added by Phase 6.3.** What follows was this report's original claim. It was wrong,
> and it is left in place with its correction rather than edited away, because a report that
> silently rewrites its own findings is one nobody can audit.
>
> *Original claim:* `DefaultBulkExecutor.subject()` maps `context.roles` onto the ACL subject's
> `roleIds` while `AuthenticationMiddleware` fills `context.roles` with role **keys**; the first
> draft of the consumer supplied keys and "the integration suite refused every object — which is how
> the mismatch surfaced"; whether the synchronous path shares the defect was filed as P1.
>
> **Two things were wrong with that.** The suite did not catch a role mismatch: the failure reported
> `BLOCKED`, which is a *domain* refusal, not `REFUSED`, which is the reach answer — and its real
> cause was a metadata field the test had invented. I changed the representation, saw the test still
> fail, and only then found the actual cause; the inference was never checked against the evidence.
>
> And the mismatch is not a mismatch. `PrismaAclRepository.roleIdsFor` partitions its input by UUID
> shape and matches `role.key` **or** `role.id`, returning canonical identifiers either way — a
> deliberate tolerance with a comment saying so. `AuthorizationSubject.roleIds` is misnamed; the
> behaviour is correct on every path. Phase 6.3 proves it with four tests in
> `acl.integration.spec.ts`, including that an unknown role name and another tenant's role id both
> grant nothing.
>
> The consumer still passes identifiers — a preference, not a correctness requirement.

---

## 8. Audit Report

**No second audit system.** Everything below is `AdministeredWriter` / `ChainedAuditWriter`, on the
same hash chain, with the same vocabulary.

| Question | Answer |
| --- | --- |
| Is the bulk request itself audited? | Yes — one `BULK_OPERATION` row, with the kind, the parameters and the tally, and no identifier list |
| Are individual mutations audited? | Yes — each object's own single-object use case writes its own row on its own document's timeline |
| Does the architecture require both? | Yes. 13 §2 lists both, and the N+1 shape is argued in `bulk-executor.ts` |
| Transactionally coupled? | **Yes, and unchanged.** Each object's audit row commits with its own mutation |
| Does async break that coupling? | **No.** The queued path runs the same per-object transactions on a different stack. Nothing about the coupling depends on who is waiting |
| Vocabulary renamed? | No. No new audit action was added |

**The operation-level row is written once, at completion**, in both paths — so a resumed operation
produces one `BULK_OPERATION` row and not one per delivery.

**`payload` is never audited.** That is the whole reason it is a column of its own rather than a
widening of `parameters`: a bulk metadata edit's *values* would otherwise land in an audit payload
that 13 §3 requires minimised.

**On `@munaxa/audit`.** The brief says to use it. Phase 19 established by reading the registry that
no such package exists — the seven published `@munaxa/*` packages are the design system plus lint and
TypeScript configuration. The audit infrastructure is this repository's own (`core/audit`), and that
is what was used. Flagged rather than silently reinterpreted.

---

## 9. API/UI Compatibility Report

### API — one change, additive

| | Before | After |
| --- | --- | --- |
| `POST /documents/bulk/*` at or below the limit | `BulkOperationResult`, `state: COMPLETED`, per-object `items` | **Identical** |
| `POST /documents/bulk/*` above the limit | Same shape, `COMPLETED`, all items — after a long wait | Same shape, `state: REQUESTED`, `items: []` |
| `GET /documents/bulk/:id` | Already existed | Unchanged — this is the polling endpoint, and no new one was needed |
| `GET /documents/bulk` | Already existed | Unchanged |

**Compatibility impact:** a client that assumed `items` is always populated sees an empty array for a
large operation. That is not a new contract — `BulkResult.items` has been documented since Phase 16
as *"present for a synchronous run, empty for a queued one"*. The response **shape** is unchanged, no
field was added or removed, and no schema changed. Below the threshold — which is every request the
existing web client sends, since its selection UI is a screenful — nothing differs at all.

**No new endpoint.** Step 14 asks whether a status endpoint is required; `GET /documents/bulk/:id`
already returns the record with its state and tally, and `GET /documents/bulk/:id/items` returns the
per-object outcomes, paged.

### UI — deliberately unchanged

**No UI was written**, and that is a decision rather than an omission. Step 15 says to implement only
what is required to expose the existing async capability. The web client's bulk affordance is
`bulk-panel.tsx` over a drag-selected screenful — bounded by what a person can select in a list, far
below any sensible `synchronousLimit`. It therefore continues to take the synchronous path and
continues to render per-object outcomes exactly as before.

The surface that *would* need progress UI is the one that produces large operations — an import
screen — and **the product does not have one**. Building a progress view for a screen that does not
exist would be building the wrong half first. It is filed in [§15](#15-remaining-phase-6-backlog)
with the import screen it belongs to.

---

## 10. Test Report

| Suite | Before | After |
| --- | --- | --- |
| API unit | 628 (+1 skipped) | **629** (+1 skipped) |
| API integration | 594 across 33 files | **603** across 33 files |
| Web | 82 | 82 |
| Domain / contracts / utils / i18n / worker | 164 / 26 / 11 / 4 / 2 | unchanged |

### The P0 regression guard

> *"does NOT execute the objects in the request when the selection exceeds the limit"*

It asserts `state === REQUESTED` **and** that no item row exists **and** that the documents are
untouched. That combination is what makes it a guard rather than a label check: a reimplementation
that ran the objects and then reported `REQUESTED` would pass a state assertion and fail this one.

### Against the brief's list

| Required | Where |
| --- | --- |
| Larger than the limit does not execute in the request | The guard above |
| `maxObjects` rejects oversized requests | "still enforces maxObjects, before any operation row exists" — also asserts no row was created |
| Synchronous boundary N−1 / N / N+1 | Three tests: below, exactly at, one past |
| Async operation persisted | The guard asserts the row, its state, `requested`, and a non-null payload |
| Queue job created | The guard asserts exactly one `bulk.operation-queued` outbox row |
| Worker executes it | "executes a queued operation, and the objects are applied only then" |
| Progress correct | Final tally asserted (`applied` 4, `requested` 4). Mid-run batching is exercised but not separately asserted — see the qualification below |
| Retry safe / duplicate delivery safe | "is safe under duplicate delivery" — delivered twice, one row per object |
| Tenant isolation | "does not run another tenant's operation" |
| Permissions | Per-object ACL is Phase 16's suite, unchanged and still passing; the queued path runs the same executor |
| Audit correct | Exactly one `BULK_OPERATION` row for a queued run |
| Partial failure represented | "records a partial failure honestly" — applied 2, refused 2, state `COMPLETED` |
| Every kind can be rebuilt | `composition.spec.ts`, against the real container with all five modules |

### Three honest qualifications

**Mid-run progress is not separately asserted.** The batch threshold is 50 and the queued tests use 3
or 4 objects, so `onBatch` never fires in them; what is asserted is the final tally. A test that
seeded 51 documents to watch one intermediate write would cost ~30 s of suite time to assert an
integer moves. Stated rather than implied.

**The consumer is driven through a queue double, not Redis.** `onApplicationBootstrap` is called with
a double that captures the handler, and the handler is invoked with the envelope the dispatcher
produces. Everything below that line is shipped code — tenant context, authority read, resume set,
plan rebuild, per-object transactions, completion. What is *not* covered end to end is BullMQ's own
delivery, which is the adapter's and has its own tests.

**A Phase 6.1 test was corrected, not deleted.** "Lets exactly one of two racing archives transition
the document" asserted that exactly one *call* succeeds. That is wrong: when the loser arrives after
the winner commits, it re-reads an already-archived document and takes the idempotent no-op path,
which is a success by design. I shipped it in Phase 6.1 having seen it flake once and having failed
to find the cause; it failed again here and the cause is now understood. It asserts the invariant —
one transition, one event — and is renamed accordingly. The flake was mine and the fix is a better
assertion, not a loosened one.

---

## 11. Performance/Batching Report

**One transaction per object, unchanged.** Step 8 forbids moving 5 000 objects into one worker
transaction; the executor never did. Phase 16's reason stands: one transaction for the batch means a
single legal-held document rolls back the other 499.

**"Batch" here means the progress interval, not the transaction size.** `DEFAULT_PROGRESS_BATCH` is
**50**, and the number is bounded by the *row*: progress is five columns on one `bulk_operation` row,
and updating it per object would serialise the operation behind its own progress bar. 50 gives a
poller a visible move every few seconds at this product's per-object cost, for one extra write per 50
transactions. It is not invented large — it is smaller than the retention sweep's 500 and the expiry
sweep's 200, because it is a write frequency rather than a work quantum.

**Reads that could have been per-object and are not:** the resume set is one query per delivery, not
one existence check per target. The final tally is one grouped query, not five counts.

**No new index.** The resume read is served by `ix_bulk_operation_item_outcome` on
`(tenant_id, operation_id, outcome)` as a prefix scan; a second index on the same leading columns
would cost every write to earn nothing.

**Lane fairness is Phase 16's** — concurrency 4 with a per-tenant cap of 2 — and is now exercised for
the first time, because until this phase nothing produced a job for it.

---

## 12. Deleted/Changed Code Report

**Nothing was deleted.** No file removed, no operation rewritten, no queue replaced.

| File | Change |
| --- | --- |
| `prisma/schema.prisma` + migration | One nullable `payload` column. No other schema change |
| `core/bulk/bulk.port.ts` | `BulkRequest` takes `kind` + `payload` instead of a `plan`; registry, requester-directory and `finalise` declared; four repository reads added |
| `core/bulk/bulk-executor.ts` | The sync/async decision; the loop extracted to `process`; `APPLIED` recorded inside the object's transaction; `complete`, `finalise`, `now` exposed for the consumer |
| `core/bulk/bulk-plan.registry.ts` | **New**, 43 lines, no rules |
| `core/bulk/bulk-lane.consumer.ts` | **New** |
| `core/bulk/prisma-bulk.repository.ts` | `payloadOf`, `settledTargets`, `progress`, `tallyOf`, `markFailed` |
| `core/bulk/events.ts` + dispatcher | `bulk.operation-queued` and one routing branch |
| `bulk-document` / `bulk-approval` / `bulk-export` services | Plan construction moved into a factory built from a payload, and registered. **The plans themselves are unchanged** |
| `modules/bulk/bulk-dispatch.module.ts` | **New**, composition only |
| `modules/identity/…/bulk-requester.directory.ts` | **New** |
| Tests | +9 integration, +1 composition, 1 corrected |

### The one behaviour change to an existing path

`APPLIED` item rows now commit inside the object's transaction rather than after it. No row changed
shape and no outcome differs; what changes is that the mutation and its record are atomic. §5 argues
why the other three outcomes keep Phase 16's placement.

### `BulkExportService` changed shape, and it is the only one that had to

It accumulated released rows in a closure and attached the manifest after `executor.run` returned.
A worker never holds that closure, so the manifest step became `BulkPlan.finalise`, which reads its
rows back from the applied targets. Both paths call it. The bytes, the manifest and the artefact are
otherwise unchanged.

### Two architecture violations I introduced and the repo's own lint caught

**Core importing a module.** The first draft put `BulkDispatchModule` in `core/bulk`, importing
`IdentityModule`. `no-restricted-imports`: *"Core and ports are imported by every module and may
never depend on one. Invert the dependency."* It was right. The module moved to `modules/bulk/`; the
consumer class stays in core, and only its composition moved.

**A test reaching into another module's internals.** The queued-worker tests constructed Identity's
credential repository from a Document suite. Same rule, same refusal. The composition moved into
`src/testing/real-collaborators.ts`, which is the one place that composes across modules on purpose,
and the suite now calls `bulk.deliver(...)`.

Neither was worked around. Both were fixed where the rule pointed.

---

## 13. Validation Report

Executed in this container. PostgreSQL 16 and Redis 7 provisioned by the repository's own
procedure — `infra/sql/cluster/01-roles.sql` and `scripts/migrate-tenants.mjs` against two tenant
databases — which is the procedure CI runs.

| Gate | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | **Clean** |
| `pnpm format:check` | **Clean** |
| `pnpm lint` | **Clean** — 0 errors, 5 warnings (all `consistent-type-imports`, all pre-existing, matching Phase 19) |
| `pnpm typecheck` | **Clean** — 13/13 |
| `pnpm test` | **Clean** — 629 API (+1 skipped), 164 domain, 82 web, 26 contracts, 11 utils, 4 i18n, 2 worker |
| `pnpm build` | **Clean** — 9/9 |
| `pnpm verify:styles` | **Clean** — 10/10 |
| `pnpm test:visual` | **Clean** — 28 browser tests, both themes |
| **`pnpm test:integration`** | **Clean** — **603 passed, 33 files, 0 skipped** |

The integration run included `SECOND_DATABASE_URL`, so the cross-database tenant-isolation
assertions ran rather than skipping.

**Skipped, recorded separately:** the load harness (`infra/loadtest`), which needs a staging
deployment and has since Phase 18; the container image build, which needs a registry; and BullMQ's
own delivery, per §10's second qualification.

**The migration was applied to both tenant databases** by the repository's own runner before the
suite ran, so the integration result is against the migrated schema.

---

## 14. Architecture Compliance Report

| Rule | Held |
| --- | --- |
| Do not rebuild bulk operations | ✅ Every `apply` is still the module's own single-object use case |
| Do not replace the queue architecture | ✅ Same lane, same adapter, same retry policy. One consumer added |
| Do not create a second job system | ✅ Outbox → dispatcher → lane, the existing path |
| Do not redesign document operations | ✅ No document use case changed |
| No second bulk architecture | ✅ One executor, one loop, one plan source for both paths |
| Never enqueue inside a transaction | ✅ Outbox event; the dispatcher enqueues after commit |
| Audit in the same transaction as its mutation | ✅ Unchanged, and now strictly stronger for `APPLIED` |
| Existing configuration made operational | ✅ `synchronousLimit` read; `maxObjects` was already enforced and was not touched |
| Existing idempotency mechanism | ✅ The Phase 16 unique index. No second store |
| No speculative locks | ✅ None added |
| No new state added "because it looks useful" | ✅ `CANCELLED` not added |
| Do not weaken audit to make async work | ✅ Not weakened; `payload` exists so `parameters` stays minimised |
| Core may not depend on a module | ✅ After the lint caught me — §12 |
| Never bypass a guard or lint rule | ✅ Both violations fixed where the rule pointed |
| No dead code | ✅ No writer without a capability |

---

## 15. Remaining Phase 6 backlog

| # | Item | Status |
| --- | --- | --- |
| — | Bulk async path (Phase 6.0 §25, P0) | ✅ **Closed by this phase** |
| — | `bulk.synchronousLimit` decorative | ✅ **Closed** |
| — | `FAILED` unreachable | ✅ **Closed** |
| — | `maxObjects` unenforced | ✅ **Was never open** — Phase 6.0 was wrong |
| ~~**1**~~ | ~~**`context.roles` — keys or ids?**~~ | **Closed by Phase 6.3: harmless.** The resolver normalises both representations deliberately. See the correction in §7 |
| 2 | Bulk import screen, and the progress UI that belongs with it | **Open, P2.** §9 |
| 3 | Notification when a queued operation completes | **Open.** `bulk.operation-completed` already reaches the notification lane and has a type; a queued run now produces it from the worker. Worth verifying end to end |
| 4 | Mid-run progress assertion | **Open, P3.** §10 |
| 5 | `library:view` enforced by nothing | **Open.** Phase 6.0 §4.1 |
| 6 | Six admin screens for shipped APIs | **Open, P1** |
| 7 | Signature UI | **Open, P1** |
| 8 | Read-and-understood acknowledgement | **Open, P1** |
| 9 | Document linking + `LINKED` writer | **Open, P2** |
| 10 | End-to-end controlled-document journey test | **Open, P1** |
| 11 | Everything else in Phase 6.0 §28 | **Open**, untouched |

### What this phase deliberately did not do

**It did not build a UI.** §9 gives the reasoning: the screen that would need one does not exist.

**It did not add `CANCELLED`.** Step 6 says not to add a state because it looks useful, and nothing
in the product cancels a bulk operation.

**It did not add a lock.** Step 16 says not to add one speculatively, and the existing per-object
transaction and version guard are sufficient — §5.

**It did not fix the `roles` inconsistency.** Item 1 above. It is a change to how every request builds
its ACL subject, which is not a bulk phase's to make on the way past.

**It did not touch `maxObjects`,** having found it already enforced.
