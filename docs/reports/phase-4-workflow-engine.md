# Phase 4 — Workflow Engine: what was built, what it costs, and what it deliberately does not do

**Status:** point-in-time record of the Workflow Engine phase. Historical — superseded, never revised.
**Audience:** whoever builds Phase 5 and after, and whoever audits what Phase 4 claimed.

Phase 2 built the workflow *definition* and said plainly that the engine did not exist: nothing
started an instance, resolved a participant or decided a task. Phase 3 built the document library and
said that every document was `DRAFT` and that `refuseWhenFrozen` was written and had never fired.

Phase 4 is where both of those stop being true. It is also where the **async half of the
architecture starts existing** — `QUEUE_PORT` had been declared since Phase 0.5 with nothing bound to
it, the outbox had been accumulating events transactionally since Phase 1 with nothing consuming one,
and `apps/worker` printed a line saying no consumers were registered.

The phase's risk was named before it started, and it was the right one to name.

## 1. Timers, which had no precedent

Everything else in Phase 4 had a shape to follow. Timers did not: nothing in this product had ever
run a background job, and the deadline half of `07-workflow-architecture.md` — §3's "BullMQ delayed
jobs, not polling", §5's escalation table, §6's pause-and-resume — depended entirely on work
happening outside a request.

Three pieces were built, in this order, and the order was the point.

### The outbox dispatcher, recorded as R5

`OUTBOX_DISPATCHER` was declared in Phase 0.5 and deliberately left unbound by Phase 2, whose module
comment said claiming rows "belongs with the worker that consumes them". That was defensible while
nothing needed to react to an event. It stopped being so the moment the engine needed to schedule a
reminder, because a reminder enqueued inside a transaction that then rolls back is precisely what
[ADR-0011](../architecture/adr/0011-transactional-outbox-for-async-work.md) exists to prevent.

The claim is one statement — `SELECT … FOR UPDATE SKIP LOCKED` — and it is raw SQL because Prisma has
no expression for it and both alternatives are wrong. Reading and then updating leaves a window in
which two instances claim the same row. Locking *without* skipping makes a second instance block
behind the first rather than pick up different work, which turns horizontal scaling into a queue of
dispatchers waiting on each other.

**A row is marked processed only after its job is enqueued.** A crash between the two leaves the row
unprocessed and the next pass re-enqueues it, which is at-least-once by design: the job identifier is
derived from the outbox row's own identifier, so a duplicate delivery is one job. Losing an event is
unrecoverable; delivering one twice is a handler's ordinary case.

Nothing written in Phases 1 through 3 needed revisiting. `available_at` was already set and the rows
were already durable and ordered, which is what "the writer is the whole of ADR-0011's guarantee"
bought.

### The queue adapter

One class provides both halves of the port — producing and consuming — because they share a
connection pool and a shutdown. Two Redis connections, not one: BullMQ needs `maxRetriesPerRequest:
null` on the connection a worker blocks on, and the cache's connection has the opposite requirement,
so this owns its own rather than sharing `RedisCacheAdapter`'s.

Attempts, backoff and concurrency come from `queueDefinition` in `@edms/domain` rather than from the
caller. A caller that could choose its own retry policy is a caller that can disagree with the lane's,
and the lane is where the reasoning about what the work costs lives. A job that exhausts its attempts
is copied to `<lane>.dead` with its reason, so a permanent failure is recoverable rather than a log
line.

The queue catalogue **moved** from `apps/worker` to `@edms/domain`, because it acquired a second
reader: the API enqueues and the worker consumes, a name known to only one of them is a message
nothing receives, and an import across two applications is the coupling the boundary rules exist to
prevent. `apps/worker/src/queues.ts` re-exports it, and a spec asserts the re-export is faithful —
a lane added to the catalogue and not re-exported would be a queue nobody can subscribe to, and that
failure has no compile error attached to it.

### `workflow_timer`: rows as well as jobs

The design decision worth carrying forward. **The queue holds the job; the database holds what the
job is for.** Three questions have no answer in BullMQ and all three are things the engine must do:

| Question | Why the queue cannot answer it |
| --- | --- |
| Which timers belong to this stage? | §3 says cancelling a stage cancels its timers; a queue has no index from a stage to jobs |
| What did this timer have left? | Pausing means storing the remainder, and a removed delayed job takes its delay with it |
| Has this reminder already fired? | Delivery is at least once, and "fired" is a fact about the timer rather than the delivery |

`fire_at` on resume is `now + remaining_ms`, **never** re-derived from the definition's duration. That
is the one implementation of "resume" that looks right and is wrong: a stage held for a week would
come back with its full three days rather than the two it had left. A check constraint pairs `PAUSED`
with a remainder, so a timer cannot be paused without recording what resume will use.

## 2. One primitive, not three code paths

`07-workflow-architecture.md` §2 asks for sequential, parallel and mixed routing from one mechanism.
The engine has four moves — start an instance, activate a stage, decide a task, end an instance — and
nothing in it knows which of the three shapes a definition happens to be.

- **Sequential approval** is one task per stage, or an `ordered` stage.
- **Parallel approval** is several tasks in one stage.
- **Mixed** is both, and the completion rule (`ALL` / `ANY` / `QUORUM(n)` / `PERCENT(p)`) decides how
  many must agree.

`domain/completion.ts` is the whole of it, and it is pure. The property that buys: a fourth routing
shape is a definition, not a release.

Two details in it are worth recording. `PERCENT` rounds **up**, because rounding down would let a
"50%" stage complete on nobody when there is one approver. And a stage where enough tasks have been
decided that the required count can no longer be reached reports `UNREACHABLE` rather than `REJECTED`
— a three-person quorum with two requests for changes has not been *refused* by anybody, and calling
it a rejection would attribute a decision to somebody who did not make one.

## 3. What was built

| Piece | What it does |
| --- | --- |
| `packages/domain/duration.ts`, `working-calendar.ts` | ISO-8601 durations and the working-day arithmetic. Pure, and shared because the engine and the authoring preview must agree |
| `packages/domain/queues.ts` | The lane catalogue, moved from `apps/worker` |
| `modules/workflow/domain/completion.ts` | Whether a stage is finished, and what finished it |
| `modules/workflow/domain/conditions.ts` | The closed expression language, over a flat pre-approved fact map |
| `modules/workflow/application/participant-resolver.ts` | Resolvers to people, at stage activation |
| `modules/workflow/application/workflow-engine.service.ts` | The engine |
| `modules/workflow/application/workflow-timers.service.ts` | Deadlines, reminders, cancel, pause, resume |
| `modules/document/domain/lifecycle.ts` | The transition table from `06-document-lifecycle.md` §5, as code |
| `core/outbox/prisma-outbox.dispatcher.ts` | R5 |
| `infrastructure/queue/bullmq.adapter.ts` | Both halves of `QUEUE_PORT` |
| `modules/administration/**/approval-routing.*` | Approval groups and working calendars |
| `apps/web/src/features/approvals` | The task inbox, the decision flow and the approval timeline |
| `infra/sql/post-migrate/04-workflow-integrity.sql` | Three invariants that span two tables |

Nine new tables, one migration, and no change to any existing table beyond `user_department.is_manager`
and back-references.

## 4. The two decisions the specification left open

The phase brief asked for both to be decided deliberately and written down. Both were **built** rather
than deferred, and the reasoning is the same in each case: a seam is the right answer when the missing
thing would be *absent*, and the wrong answer when it would make the product *wrong*.

### The working-day calendar: built

§6 says Administration owns it. Administration did not have one — and `WORKING_DAYS` is the *default*
`stageDeadlineSchema` applies to every deadline a workflow author writes. A seam would have meant
every deadline in the product silently counting Saturdays and Sundays, with nothing to say so. That
is not an absent feature; it is a wrong answer delivered confidently.

So `working_calendar` and `working_calendar_holiday` exist, per entity with exactly one tenant-wide
default, behind `workflow:manage`. The arithmetic lives in `@edms/domain` because it has two callers
that have to agree: the engine computes the deadline it will enforce, and Administration's preview
endpoint tells an author what that deadline will be. A second implementation of "three working days"
is a screen that promises Tuesday and an engine that escalates on Monday.

**What it does not model is working hours.** The calendar knows which *days* are worked, not which
hours of them. `PT8H` is eight real hours none of which elapse on a non-working day; it is not "one
working day". A 09:00–17:00 calendar with half-days is a genuinely bigger model, and it is owed.

### Approval groups: built

`GROUP` is one of the seven resolver kinds in §2 and had no administration surface — which the Phase 2
report already flagged. A resolver that cannot resolve fails a submission loudly, so shipping the
engine without the surface behind one of its resolver kinds would have shipped a definition kind
nobody could use.

A group is a **routing list, not a permission**, which is why it is its own table rather than a role
with no permissions: a role is resolved on every request and carries authority, and conflating them
would make "add Sam to the safety reviewers" an access change nobody reviewed.

### And one the specification did not name: department managers

`MANAGER_OF` is a resolver kind and nothing in the model said who managed anything. `user_department`
gained `is_manager` — a flag on the membership rather than a column on the department, because a
department can have two managers and a person can manage one department while belonging to three.
`managersOf` excludes the subject from their own result: "escalate to my manager" resolving to me is
an escalation that goes nowhere and hides that there is nobody above me.

## 5. Decisions worth carrying forward

**A task is decided once, and the `WHERE` clause is what makes that true.** `UPDATE … WHERE decision
IS NULL AND state = 'PENDING'`; zero rows affected is a `409`. A read followed by a write leaves a
window however short the transaction is, and a second decision on one task corrupts a quorum count —
which §8 names as something the engine must never do.

**A resolver that yields nobody fails the whole submission.** §8 forbids skipping such a stage and
calls it a silent loss of a control. The refusal names *which* resolver produced nothing, because the
whole point is that somebody can fix it. A stage whose *condition* does not hold is a different thing
entirely and is `SKIPPED` with a stated reason — the two look alike from outside, which is exactly why
the engine keeps them apart.

**Conditions never reach anything they were not handed.** §2 requires a pure evaluator, and the
security property behind that sentence is that a tenant authors the expression. So the facts are
gathered *before* evaluation, by code in the Document module that knows what it is fetching, into a
`Map` — not an object — of pre-approved keys. The evaluator does a lookup and a comparison; it has no
path resolution at all. `conditions.spec.ts` asserts that `constructor`, `__proto__` and
`hasOwnProperty` resolve to nothing, which is the assertion a plain object would fail.

**An unresolvable fact is false, never true and never an error.** A stage naming a metadata field the
document's type does not carry is a stage that does not apply. Throwing would stall an approval in
front of an author who cannot fix a definition; returning true would run a control the definition
scoped away.

**Ordering is preserved through resolution.** In an `ordered` stage the position in the resolved list
*is* the sequence, so de-duplicating from the end or filtering in query order would silently rearrange
somebody's approval chain. `activeAmong` filters against the input order for the same reason.

**A decision and its comment are one request.** A rejection whose reason arrived in a second call is a
rejection that existed for a moment with no reason, and that moment is what somebody reads years
later.

**Both identities travel from the start.** `decided_by_id` and `on_behalf_of_id` are on the task and
in the audit payload before delegation exists. Phase 11 relaxes one check in one place in the engine
and needs no migration.

**The timeline and the history are one shape.** A timeline is one instance rendered forwards and a
history is the list of them. Serving them from two endpoints would be two projections of one aggregate
to keep in step.

## 6. What the database enforces on its own

Three rules span two tables and are therefore triggers, and three more are check constraints and
partial indexes. Each trigger is asserted by the integration suite **bypassing every use case**,
because that is the only honest way to test a defence that exists for the case where the use case is
not what is writing.

| Rule | Why it cannot live only in a use case |
| --- | --- |
| An instance binds to a `PUBLISHED` version | "An instance binds to a version" is worth nothing if the version is still being edited. `DEPRECATED` is allowed: retiring stops new approvals and leaves running ones alone |
| A task belongs to a stage of its own instance | Two foreign keys individually valid and jointly nonsense. The task would count toward a quorum in an approval nobody meant it to be part of |
| A decision is taken only while the instance is `RUNNING` | A pause is meaningless if anything progresses under it, and a finished instance is evidence |
| One live approval per document | Partial unique index on `(document_id) WHERE state IN (RUNNING, PAUSED)`. Two submissions racing both pass the polite check |
| A decided task carries decision, decider and instant — or none of them | Half a decision is the shape a partial write leaves behind |
| A paused timer carries its remainder, and only a paused one does | §6's rule, made unrepresentable to get wrong |

## 7. The defect the integration suite found

Worth recording in full, because the design did not name it and no unit test could have.

Two approvers deciding at the same instant run in two transactions. Under `READ COMMITTED` neither
can see the other's uncommitted decision, so both evaluated the stage against one approval — and a
two-person quorum was met while the stage stayed `ACTIVE` forever, with the instance running and
nobody left to decide. The assertion that caught it is the one the phase brief asked for by name: "a
quorum counted under concurrency".

The fix is a row lock on the instance, taken **first** on every write path. It serialises decisions on
one approval — which is correct, because they are arithmetic over each other — and leaves decisions on
different approvals fully concurrent. Always taken first, so two decisions on one approval cannot
deadlock by acquiring rows in different orders.

## 8. What it costs

| Cost | Detail | Mitigation |
| --- | --- | --- |
| **Consumers run in the API process** | The outbox dispatcher and the timer consumer are registered by the modules that own their use cases, and `apps/worker` is still a skeleton | A consumer is a thin wrapper around a use case, so moving it is a deployment change rather than a code one. `QUEUE_CONSUMERS_ENABLED` already separates the two roles |
| **Decisions on one approval serialise** | The instance row lock is held for the length of a decision transaction | Approvals are decided in ones and twos by people. The alternative is a quorum that can silently never complete |
| **A failed enqueue is logged, not raised** | The approval has already committed; throwing would report failure for something that succeeded | The timer row is durable and `SCHEDULED` with a `fire_at` in the past, so it is visible. A reconciling sweep that re-enqueues them is owed |
| **No working-hours calendar** | `PT8H` is eight real hours that skip non-working days, not one working day | Stated here and in the module README. A 09:00–17:00 model with half-days is a bigger design |
| **Escalation resolves against the first pending task** | `MANAGER_OF: ASSIGNEE` during escalation uses one assignee's manager rather than each assignee's | Correct for the ordinary one-or-two-approver stage. A per-assignee escalation is owed |
| **No notification is delivered** | Every event a person would be told about is published to the outbox and routed to `notifications.deliver`, and nothing consumes that lane | Phase 12's. The events are durable and the routing is in place, so it is a consumer rather than a redesign |
| **The inbox is one person's own** | `assigneeId` naming somebody else is refused | A manager's view of a team's backlog needs the delegation and reporting phases behind it |

## 9. Deliberate limits

| Limit | Why | Unblocked by |
| --- | --- | --- |
| No document number at approval | [ADR-0004](../architecture/adr/0004-numbering-assigned-at-approval.md) assigns one at approval and [07 §8](../architecture/07-workflow-architecture.md) forbids earlier; allocation is Phase 5's. The engine calls `DOCUMENT_NUMBER_ALLOCATOR`, the port is **unbound**, and an approval completes with `numberAssigned: false` | Phase 5 |
| No delegation | §4 is untouched. The task carries both identities and the audit answers "who decided" and "for whom", so it stays buildable | Phase 11 |
| `APPROVED` does not become `PUBLISHED` | Publication needs the effective-date policy and "exactly one published revision", which is revision territory | Phase 6 |
| No revision on rejection | A rejected document is revised by editing it, not by a new controlled revision | Phase 6 |
| Legal hold does not pause anything | The pause exists, is audited and is exposed behind `workflow:manage`; there is no legal hold to call it | Phase 9 |
| No graphical designer | The engine reads JSON, so a designer is a UI over the same JSON with no engine change — which is what §7 promised and what this phase did not spend | Phase 16 |
| No search indexing of approval state | `document.*` events route to `search.index` and nothing consumes it | Phase 8 |
| `apps/worker` registers no consumers | Its queue catalogue moved to the shared package and it re-exports it; the consumers live with their use cases | The phase that needs the processes split |

## 10. Defects and drift found while doing it

**The `isDefault` calendar flag was cleared after the insert, not before.** The partial unique index
refuses a second default the instant the row lands, so a "clear the others, then write" that ran in
the other order was a statement that never executed. Found by the integration suite on its first run.

**`jsonb_path_exists` needed an explicit enum cast.** `v.state <> $1` against a `workflow_version_state`
column with a text parameter is `operator does not exist`. Recorded because the failure message names
the operator rather than the parameter, and the next raw query against an enum column will hit it too.

**The Phase 0.5 sketch of `workflow/application/ports.ts` had three repositories returning `unknown`
— one per aggregate.** It was replaced rather than filled in. Every engine operation touches the
instance, its stage and its tasks in one transaction, so three repositories would have put the
consistency into the service, which is the invariant the aggregate boundary exists to hold.

**`UserDirectory` was the right place for the routing lookups and it was not obvious.** The first
instinct was a workflow repository reading `user` and `user_role` directly. That interface's own
comment says it is "the only way out of this module — nobody reads Identity's tables", and it is
right: the four reads went there.

**The calendar arithmetic started in the workflow module and had to move.** Administration's preview
endpoint needed it, and `../../workflow/domain/**` is exactly what the cross-module boundary lint
forbids. It moved to `@edms/domain`, where it belongs — the rule bit before the mistake shipped,
which is the second time in two phases that lint has caught a boundary at authoring time.

## 11. Verification

| Gate | Result |
| --- | --- |
| `pnpm format:check` | Clean |
| `pnpm lint` | Clean across all thirteen tasks |
| `pnpm typecheck` | Clean across all seven packages |
| `pnpm test` | 318 API tests (up from 297), 88 domain tests (up from 71), plus the other packages and 21 web tests |
| `pnpm test:integration` | 18 files / 301 tests (up from 15 / 260) against real PostgreSQL |
| `pnpm build` | Clean, API and web |
| `pnpm prisma:deploy` | Verified against two tenant databases, including the new post-migration SQL |

Three suites are new, and each exists for a reason a double could not serve.

`workflow-engine.integration.spec.ts` runs the whole engine over a real PostgreSQL: twenty-five
assertions covering submission and its refusals, the decided-once race, the quorum counted under
concurrency, a rolled-back decision leaving no trace, ordered stages, skipped stages, the deadline
against a real stored calendar, pause and resume with the remaining duration, withdrawal, history, the
three database triggers and the audit payload. It is where the concurrency defect in §7 was found.

`outbox-dispatch.integration.spec.ts` asserts the dispatcher against a real database, including the
one property that cannot be observed any other way: a second connection holding a lock inside an open
transaction, and the pass skipping that row rather than blocking on it.

`approval-routing.integration.spec.ts` asserts the two configuration surfaces, including the `jsonb`
containment query that stops a group in use from being deleted — and that a group key appearing in a
stage's *name* does not count.

The pure engine is unit-tested where it belongs. `completion.spec.ts` (14) and `conditions.spec.ts`
(7) sit beside the code they cover in the workflow module; `working-calendar.spec.ts` (13) moved to
`@edms/domain` with the arithmetic. Every date in the last of them is one somebody could check against
a wall calendar, which is the only honest way to test deadline arithmetic — a deadline wrong by a day
is a reminder sent after the fact, an escalation to somebody's manager over work that was never late,
and under `AUTO_APPROVE` an approval nobody made.
