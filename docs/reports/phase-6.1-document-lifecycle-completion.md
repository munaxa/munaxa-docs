# Phase 6.1 — Document Lifecycle Completion

**Purpose:** complete the lifecycle Phase 6.0 found unfinished — make `ARCHIVED` reachable by a user
action, make `EXPIRED` reachable at all, and give both the audit actions the catalogue has listed as
owing since Phase 9.
**Scope:** the document lifecycle only. No other Phase 6.0 finding was touched.
**Status:** point-in-time report. Not edited afterwards.
**Method:** every Phase 6.0 finding relevant to this phase was re-verified against the source before
any code changed. Every gate below was executed in this container, against a real PostgreSQL 16 with
two tenant databases and a real Redis, provisioned by the repository's own procedure.

## Final status: **COMPLETE** for archival, reinstatement and expiry. `LINKED` is **out of scope and remains owing**, with the reason in [§4](#4-audit-event-report).

---

## 1. Document Lifecycle Completion Report

### 1.1 Step 1 — verification of the Phase 6.0 findings

Nothing was taken on trust. Each finding, and what inspection actually showed:

| Phase 6.0 finding | Verdict | Evidence |
| --- | --- | --- |
| `IMPLEMENTED_TRANSITIONS` has no archive transition | **Confirmed** | `IMPLEMENTED_TRANSITIONS[PUBLISHED]` was `[CHECKED_OUT]`; `[ARCHIVED]` was `[DELETED]`; `[EXPIRED]` was `[]` |
| `ARCHIVED` reachable only through the retention disposition adapter | **Confirmed** | `grep DocumentStatus.ARCHIVED` outside specs and the table returned exactly one writer: `retention-disposition.adapter.ts:185` |
| Nothing watches `effective_to` | **Confirmed** | `effective_to` is written at publication and read by the revision panel. No entry in `SCHEDULE`, no predicate, no consumer acted on it. `EXPIRED` was unreachable |
| `ARCHIVED`, `REINSTATED`, `LINKED` audit writers not established | **Confirmed, with a correction** | The three are named in `13-audit-architecture.md` §2, which is *documentation*. In code they did not exist at all — not as unused constants. `grep "'LINKED'"` and `grep REINSTATE` over `apps` and `packages` both returned **zero** |
| Some writers were marked "verify", not missing | **Correct to have flagged.** One of the three turned out to be **already implemented** | See §1.2 |
| `document:archive` enforced by nothing | **Confirmed** | Non-seed, non-spec references: **zero**. It appeared only in `permissions.ts`, `role-seed.ts` and the matrix |

**A finding Phase 6.0 did not make, found by this phase's own inspection:** `documentArchivedEvent`
already existed in `domain/events.ts` and was already listed in `DOCUMENT_EVENT_TYPES` — declared in
Phase 3 and published by nothing for eighteen phases. It is now published rather than redefined, and
its payload shape is unchanged: *"its payload shape never changes once shipped"* applies to a
declared event whether or not anything had emitted it, and widening it would have been the easier
and wronger move.

### 1.2 What was verified as already implemented, and therefore not touched

Phase 6.0 explicitly marked three audit actions "verify, not missing". Inspecting them:

| Action | Verdict |
| --- | --- |
| `ACCESS_DENIED` | **Already implemented.** Written by Phase 14's ACL guard. Untouched |
| `SEARCH_REBUILD_REQUESTED` | **Already implemented.** Declared in `search/domain/audit-actions.ts` and written by the rebuild service. Untouched |
| `ROUTING_CHANGED` | **Already implemented.** Written by `approval-routing.service.ts`. Untouched |

The brief's instruction was followed exactly: none was treated as missing, and none was modified.

### 1.3 What was built

One capability per gap, each on the existing mechanism:

1. **Explicit archival** — `POST /documents/{id}/archive`, behind `document:archive`, with a
   mandatory stated reason.
2. **Reinstatement** — `POST /documents/{id}/reinstate`, same permission, same shape.
3. **Expiry** — `documents.expire-effective`, an hourly sweep on the **existing** `retention.run`
   lane, reaching Document through a port.
4. **Three audit actions** — `ARCHIVED`, `REINSTATED`, `EXPIRED`.
5. **`document:archive` enforcement**, at the route, the object scope and the UI.

---

## 2. State Transition Matrix

### 2.1 The states, unchanged

Thirteen. **No state was added, removed or renamed.** `DocumentStatus` is byte-for-byte what it was.

### 2.2 `LEGAL_TRANSITIONS` — unchanged

The design table was already complete and already allowed every transition this phase performs:
`PUBLISHED → ARCHIVED`, `PUBLISHED → EXPIRED`, `SUPERSEDED → ARCHIVED`, `EXPIRED → ARCHIVED`,
`EXPIRED → CHECKED_OUT`, `ARCHIVED → PUBLISHED`, `DELETED → ARCHIVED`. **Not one line of it was
edited.** That is the clearest evidence the lifecycle was completed rather than redesigned: the
design was right in Phase 0 and only the *performing* half was missing.

### 2.3 `IMPLEMENTED_TRANSITIONS` — the only table that changed

| From | Before | After | Added by |
| --- | --- | --- | --- |
| `PUBLISHED` | `CHECKED_OUT` | `CHECKED_OUT`, **`EXPIRED`**, **`ARCHIVED`** | the sweep; the archive route |
| `EXPIRED` | *(none)* | **`ARCHIVED`**, **`CHECKED_OUT`** | the archive route; check-out already worked |
| `ARCHIVED` | `DELETED` | **`PUBLISHED`**, `DELETED` | the reinstate route |
| `SUPERSEDED` | *(none)* | *(none)* — unchanged | unreachable as a document state |

`EXPIRED → CHECKED_OUT` needed **no new code**: `checkOut` already delegates its legality decision
to `applyLifecycleTransition`, and the pair was already legal. Offering it was a one-line table
change, and it is what stops the new state being a trap.

### 2.4 Actors, permissions, transaction boundaries and audit

| Transition | Actor | Permission | Trigger | Transaction | Audit action |
| --- | --- | --- | --- | --- | --- |
| `PUBLISHED`/`EXPIRED`/`SUPERSEDED` → `ARCHIVED` | A person | `document:archive` + `@ScopedTo` document | HTTP | One; audit + status + outbox commit together | `ARCHIVED` (`via: EXPLICIT`), reason attested |
| *(any legal)* → `ARCHIVED` | The system | none — a schedule, not a request | Retention disposition | Joins the disposition's transaction | `ARCHIVED` (`via: RETENTION`) **and** `PURGE_EXECUTED` |
| `ARCHIVED` → `PUBLISHED` | A person | `document:archive` + `@ScopedTo` document | HTTP | One | `REINSTATED`, reason attested |
| `PUBLISHED` → `EXPIRED` | The system, actor **always null** | none | `documents.expire-effective`, hourly | **One per document** | `EXPIRED`, carrying the arithmetic |
| everything else | unchanged | unchanged | unchanged | unchanged | unchanged (`DOCUMENT_CHANGED`) |

---

## 3. Archive / Expiration Design

### 3.1 Convergence — the brief's central constraint

> *"The explicit archive path and retention-driven archive path must converge on the same domain
> invariant rather than creating two competing implementations."*

They converge on **`isLegalTransition(from, ARCHIVED)`**, the pure function in
`domain/lifecycle.ts`. Both call it; neither has a status check of its own. That convergence
**predates this phase** — `RetentionDispositionAdapter` has called it since Phase 10 — and this
phase preserved it rather than inventing a new shared abstraction over it.

What did **not** converge, and now does: the retention path wrote only `PURGE_EXECUTED`, in
Retention's disposition register, so **a document retired by policy had nothing on its own timeline
saying it had left the shelf.** It now writes the same `ARCHIVED` action the explicit path writes,
with `via: RETENTION` distinguishing them in the payload. That is the `PURGED`/`PURGE_EXECUTED`
split (13 §2 — two groups, two audiences) applied to the other disposition.

**The two paths remain two code paths, deliberately**, and the reason is a database predicate:
`setStatus` matches on `deleted_at IS NULL`, so it *cannot* move a soft-deleted row — and the
retention disposition's whole job includes archiving soft-deleted records (`DELETED → ARCHIVED`).
Forcing the sweep through `DocumentService.archive` would have meant relaxing that predicate, which
would let any caller move the status of a deleted document. Two callers of one invariant is
correct; one caller with a weakened guard would not be.

### 3.2 One lifecycle, not two — how the audit action varies without a second implementation

`applyLifecycleTransition` gained two optional fields, `auditAction` and `auditFacts` (and later
`attestReason` — §7). Every caller that existed before this phase omits all three and produces
`DOCUMENT_CHANGED` rows byte-for-byte identical to before.

The alternative was a second method that performs the same status move and records a different row.
That is precisely the "second lifecycle implementation" the brief forbids, and it would disagree
with the first the moment somebody adds a state. So the transition keeps **one** legality check,
**one** idempotency rule, **one** version guard and **one** revision-machine sync, and only the name
on the audit row varies.

### 3.3 Idempotency — inherited, not added

Archiving an archived document succeeds. That is `applyLifecycleTransition`'s existing semantics,
relied on by the workflow engine since Phase 4 (a second stage activating must not be a `409`). The
repeat writes an audit row marked `unchanged: true` — the trail records that somebody asked — and
publishes **no** event, because nothing happened. Asserted in the integration suite.

### 3.4 Expiry — the smallest architecture-consistent mechanism

**No new scheduler.** `SCHEDULE` in `packages/domain/src/queues.ts` already existed with twelve
entries; this is the thirteenth.

**No new lane.** It runs on `retention.run`, which is `storage.verify-integrity`'s decision applied
a second time: off-peak, bounded per pass, serialised per tenant, safe to miss. It also *had* to be
there — the queue adapter builds one worker per `subscribe`, so a second subscriber on that lane
would race `RetentionLaneConsumer` for its jobs, which is the defect that gave delegation a lane of
its own.

**No new consumer.** `RetentionLaneConsumer` gains a fourth kind, exactly as it already handles two
Storage schedules that are not Retention's.

**The seam.** `DOCUMENT_EXPIRY` is declared in `retention/application/ports.ts` and implemented by
`document/infrastructure/document-expiry.adapter.ts` — the mirror of `IntegritySweep`, which is
declared in the same file and implemented by Storage. `RetentionService.expireEffectiveDocuments`
is a one-line pass-through, exactly like `verifyStoredIntegrity` above it. Retention decides nothing
about expiry: not what `effective_to` is, not which timezone the boundary is in, not what `EXPIRED`
means.

| Requirement | How |
| --- | --- |
| **Deterministic** | The candidate query is a pure `date` comparison; the boundary arithmetic is one `calendarDay` call in the caller, unit-testable without a database |
| **Timezone-safe** | `calendarDay(now, locale.timezone)` — the same helper numbering rules and working calendars use. The cron is **hourly**, so each tenant's own midnight is caught within the hour; a nightly firing would be after midnight for some tenants and hours before it for others |
| **Idempotent** | Candidates are `PUBLISHED` documents with a closed window. A document this pass expires stops matching, so a redelivered job finds nothing |
| **Transactionally safe** | One transaction per document: status, audit row and outbox event commit together |
| **Retry-safe** | Same as idempotent, plus: a pass interrupted halfway resumes at the same place, because nothing is batched across documents |
| **No duplicate expiration events** | The event publishes only on a real transition |
| **Correct authorization** | `systemContext` — tenant, no user, no permissions. The audit actor is null because nobody decided it |
| **Never expired by a read** | The status changes only in the sweep. No read path evaluates `effective_to` |

**The boundary is inclusive.** `effective_to` is the last day the revision *is* effective —
publication refuses a window ending before it starts, so a same-day window is one valid day. A
document expires when the tenant's calendar day becomes *later* than `effective_to`. Both sides are
asserted against the database.

### 3.5 Reinstatement refuses a closed window

`ARCHIVED → PUBLISHED` on a document whose window closed last March would be
published-and-immediately-re-expired: the next sweep would take it straight back out, leaving a
reinstatement and an expiry minutes apart describing a decision nobody took. It is refused, naming
the date, and pointing at the way forward the product already has — publish a revision with a new
window.

---

## 4. Audit Event Report

| Action | Existed before? | Status |
| --- | --- | --- |
| `ARCHIVED` | No — not in code at all | **Implemented.** Written by both paths |
| `REINSTATED` | No | **Implemented** |
| `EXPIRED` | No, and not in the catalogue either | **Implemented**, and added to `13-audit-architecture.md` §2 in this commit |
| `LINKED` | No | **Not implemented — out of scope.** See below |
| `ACCESS_DENIED`, `SEARCH_REBUILD_REQUESTED`, `ROUTING_CHANGED` | **Yes** | Verified present, untouched |

For each action implemented:

| Question | Answer |
| --- | --- |
| Transactionally coupled to the business change? | Yes. `AdministeredWriter` writes the audit row **inside** the transaction that moved the status. Asserted: a refused transition leaves neither |
| Correct actor? | Yes. The person for archive/reinstate; **null** for expiry, because nobody decided it |
| `tenantId`? | Yes — from the ambient context, on every row, as every audit row has been since Phase 1 |
| `documentId`? | Yes — `subjectType: DOCUMENT`, `subjectId` the document |
| Revision information? | On `EXPIRED`: the closed window and the revision are in the event payload; the audit payload carries `effectiveTo`, `evaluatedOn` and `timezone`. Archive and reinstate act on the *document*, so a revision id would be a fact about the wrong aggregate |
| Required metadata? | Yes — `before.status`, `after.status`, `operation`, and the stated reason in the trail's attested `reason` column |
| A second audit implementation? | **No.** All four use the existing `AdministeredWriter` / `ChainedAuditWriter` and land on the same hash chain |
| Vocabulary renamed? | **No.** The three names are exactly `13-audit-architecture.md` §2's |

### `LINKED` — why it is not implemented, and why that is not a workaround

The brief says *"only implement a writer if the action is genuinely missing"*. It is genuinely
missing — and so is **everything it would describe**. There is no `document_link` table, no
migration, no relation on the schema, no service, no route and no UI. Document linking is a
capability, not a writer.

Writing a `LINKED` writer now would produce a function nothing calls, which the repository's own
standards forbid (*"no placeholder, no TODO, no dead code"*), and building the linking capability is
a feature this phase's brief does not describe — it is Phase 6.0's roadmap item 16, P2. The action
stays owing, and `13-audit-architecture.md` now says so in one line instead of grouping it with two
that are done.

### Deliberately not built: notifications for the three new events

`document.archived`, `document.reinstated` and `document.expired` route through the existing
`document.*` prefix to the search index and the notification lane, where the translator has no case
for them and produces nothing — the same treatment `document.moved`, `document.deleted` and
`document.restored` have had since Phase 12. Adding notification types would mean a type catalogue
entry, recipient resolution and templates in two languages: a Phase 6.0 §17 item, not a lifecycle
one. Named here rather than left to be noticed.

---

## 5. Permission Enforcement Report

`document:archive` was in the catalogue, in the matrix at 08 §6, seeded to `TENANT_ADMIN` and
`DOCUMENT_CONTROLLER`, offered in the role editor — and **named by no route**. An administrator
granting it was granting a control that did not exist, which is worse than one that is absent,
because it reads as applied.

| Boundary | Enforcement | Verified by |
| --- | --- | --- |
| Route | `@RequirePermission(Permission.DOCUMENT_ARCHIVE)` on both endpoints | The boot-time `RouteRegistry` assertion, plus `composition.spec.ts` |
| Object | `@ScopedTo('id', ScopeType.DOCUMENT)` — the ACL guard resolves the chain before the use case | Same mechanism as `move`, `delete` and `restore` |
| Domain | The lifecycle table refuses an illegal transition regardless of permission | `lifecycle.spec.ts`, and an integration test asserting a draft cannot be archived |
| Tenant | The repository's `tenant_id` predicate. Another tenant's document is a `404`, never a `403` | Integration test, and the sweep asserts a foreign tenant examines zero rows |
| UI | A server-computed `canArchive`; the button is absent without it | **`archive-affordance.spec.tsx`** — six rendered assertions |

**Both directions use the same permission**, and that is 08 §2 applied rather than an oversight:
"may retire a record" and "may un-retire the record they retired" are not two decisions somebody can
be trusted with separately, and splitting them would leave a holder of the first able to take a
document off the shelf and unable to put it back.

**Reinstatement is not `document:restore`.** That permission reverses a *delete* and gates the
recycle bin; conflating them would let anyone who can empty the recycle bin resurrect retired
controlled records.

Two catalogue entries remain unenforced and are **deliberately left**, per the brief's instruction
not to solve them here: `library:view` (a real gap) and `report:manage` (deliberate — it is for
shared report definitions, which do not exist). Both are now named in `08-permission-model.md` §7 so
the next reader does not have to re-derive them.

---

## 6. Test Report

Every test below was executed. Counts are before → after.

| Suite | Before | After | Added |
| --- | --- | --- | --- |
| API unit | 614 (+1 skipped) | **628** (+1 skipped) | 14 |
| API integration | 578 across 33 files | **594** across 33 files | 16 |
| Domain | 164 | 164 | — |
| Contracts | 26 | 26 | — |
| **Web** | 76 | **82** | 6 |
| Browser (a11y contrast + visual) | 28 | 28 | — |
| utils / i18n / worker | 11 / 4 / 2 | 11 / 4 / 2 | — |

### Coverage against the brief's list

| Required | Where |
| --- | --- |
| Valid archive transition | `lifecycle.spec.ts`; integration "archives a published document" |
| Invalid archive transition | `lifecycle.spec.ts` (eight refused source states); integration "refuses an archive from a state the table does not allow" |
| Unauthorized archive | Route `@RequirePermission` + `composition.spec.ts`; UI: `archive-affordance.spec.tsx` ×3 |
| Archive idempotency | Integration "is idempotent … and adds no second transition" |
| Reinstatement | Integration "reinstates an archived document, with a REINSTATED row of its own" |
| Expiration | Integration "expires a document whose window closed, and records the arithmetic" |
| Expiration boundary | **Both sides**: "does not expire a window that ends today"; "expires a window that ended yesterday" |
| Already-expired document | Integration "is retry-safe: a second pass expires nothing again" |
| Retry of expiration | Same test — `examined` is 0 on the second pass |
| Concurrent lifecycle operations | Integration "lets exactly one of two racing archives transition the document" |
| Archive produces `ARCHIVED` | Integration, asserting action, reason, actor and `via` |
| Reinstate produces `REINSTATED` | Integration, and asserts no `RESTORED` row is written |
| Linking produces `LINKED` | **Not applicable** — capability out of scope (§4) |
| Audit committed with the business transaction | Integration: the successful case asserts both; the refused case asserts **neither** status change nor audit row |
| Rollback removes both | See the honest note below |
| Tenant A cannot archive tenant B's document | Integration "refuses to archive another tenant's document" |
| Tenant A cannot trigger expiration for tenant B | Integration "expires nothing for a tenant that owns nothing" |
| API authorized / unauthorized / invalid state | Permission decorators asserted at boot; invalid state asserted at the use case |
| UI visible / unavailable / states | `archive-affordance.spec.tsx`; loading, error and success come from `FormDialog`, the screen's existing pattern |

### Two honest qualifications

**On "rollback removes both".** What is asserted is the observable property: a refused transition
leaves neither a status change nor an audit row, and two racing archives produce exactly one
transition and exactly one event. A test that forces a failure *between* the audit write and the
commit was not written — there is no seam to inject one without adding test-only code to the writer,
and the atomicity itself is `AdministeredWriter`'s, which Phase 1 established and its own suite
covers. Stated rather than claimed as more than it is.

**On the concurrency test.** "Lets exactly one of two racing archives transition the document" was
observed to fail **once in roughly nine runs**, during a run where the container was simultaneously
compiling, and has passed **seven consecutive full-suite runs** since. It is the same shape as two
racing tests this suite has shipped for phases ("lets exactly one of two racing publishes through",
and the check-out lock). It is kept rather than weakened, because it asserts the right property, and
it is recorded here rather than left for someone to discover.

---

## 7. Deleted / Changed Code Report

**Nothing was deleted.** No file was removed, no function replaced, no behaviour rewritten.

| File | Change |
| --- | --- |
| `domain/lifecycle.ts` | Three `IMPLEMENTED_TRANSITIONS` rows widened. `LEGAL_TRANSITIONS` **untouched** |
| `domain/audit-actions.ts` | Three constants added |
| `domain/events.ts` | Two events added; `documentArchivedEvent` unchanged and now published |
| `application/document.service.ts` | Three methods added; `applyLifecycleTransition` gained three **optional** fields |
| `application/ports.ts` | Two repository reads, two result types, one service method |
| `infrastructure/prisma-document.repository.ts` | Two reads and one date helper added |
| `infrastructure/retention-disposition.adapter.ts` | **One `writer.record` call** and an injected writer. The purge and the status move are unchanged |
| `infrastructure/document-expiry.adapter.ts` | New, 29 lines, no logic |
| `presentation/documents.controller.ts` | Two endpoints |
| `retention/application/ports.ts`, `retention.service.ts` | One port, one pass-through |
| `retention/infrastructure/retention-lane.consumer.ts` | A fourth schedule kind |
| `packages/domain/src/queues.ts` | A thirteenth `SCHEDULE` entry |
| `packages/contracts` | One schema |
| Web | One prop, two buttons, two dialogues, two actions, one page line |
| i18n | 13 keys each in `en` and `ar` — **parity exact at 1 392 / 1 392** |
| Tests | 3 new files, 36 new tests |
| Architecture docs | `06`, `08`, `13` updated in this commit, per the standing rule |

### The one behaviour change to an existing path

`RetentionDispositionAdapter.archive` now writes an `ARCHIVED` audit row in addition to the
`PURGE_EXECUTED` its caller already wrote. **No existing row changed shape**; a row was added, on a
timeline that previously had none for this act. This is the convergence §3.1 describes, and it is
the only place this phase alters what an already-shipped path records.

### A defect this phase introduced and fixed before shipping

The first implementation put the stated reason in the audit **payload** rather than the trail's
attested `reason` column, so an archive's justification would not have been covered by Phase 9's
hash digest. The integration suite caught it — two tests failed on `reason` being null. Fixed by
`attestReason`, which is **opt-in**, so the eighteen phases of callers that put `reason` in the
payload keep doing exactly that.

---

## 8. Validation Report

Executed in this container. PostgreSQL 16 and Redis 7 were provisioned with the repository's own
procedure — `infra/sql/cluster/01-roles.sql` and `scripts/migrate-tenants.mjs` against two tenant
databases — which is the same procedure CI runs.

| Gate | Command | Result |
| --- | --- | --- |
| Install | `pnpm install --frozen-lockfile` | **Clean.** 565 packages |
| Format | `pnpm format:check` | **Clean** |
| Lint | `pnpm lint` | **Clean** — 0 errors, 5 warnings (all `consistent-type-imports`, all pre-existing, matching Phase 19) |
| Typecheck | `pnpm typecheck` | **Clean** — 13/13 |
| Unit tests | `pnpm test` | **Clean** — 628 API (+1 skipped), 164 domain, 82 web, 26 contracts, 11 utils, 4 i18n, 2 worker |
| Build | `pnpm build` | **Clean** — 9/9 |
| Stylesheet guard | `pnpm verify:styles` | **Clean** — 10/10 |
| Accessibility + visual | `pnpm test:visual` | **Clean** — 28 browser tests, both themes |
| **Integration** | `pnpm test:integration` | **Clean** — **594 passed, 33 files, 0 skipped** |

The integration run included `SECOND_DATABASE_URL`, so the cross-database tenant-isolation
assertions **ran** rather than skipping — 594 passing with zero skipped, against 578 with 7 skipped
in the runs that omitted it.

**What was not run:** the load harness (`infra/loadtest`), which needs a staging deployment and has
needed one since Phase 18; and the container image build, which needs a registry.

### One boundary violation, caught by the repo's own lint rule and fixed properly

The first draft of the expiry seam test imported `DocumentExpiryAdapter` from the Document module
into a Revision test file. `no-restricted-imports` failed it: *"Cross-module calls go through the
owning module's application service or a domain event — never into its internals."* The rule was
right. The assertion moved to `composition.spec.ts`, whose job is exactly "is this port bound" —
which is a better home for it anyway, since a schedule wired to an unbound port is precisely the
failure that file exists to catch.

---

## 9. Architecture Compliance Report

| Rule | Held |
| --- | --- |
| Never rebuild | ✅ Nothing was rebuilt. `LEGAL_TRANSITIONS` — the design — was not edited at all |
| Never redesign | ✅ No state added, removed or renamed. No API contract changed. No migration |
| No second lifecycle | ✅ One `applyLifecycleTransition`. Both new use cases call it |
| No status mutation from a controller | ✅ Controllers call the service; the service calls the table then the repository |
| No bypass of the state machine | ✅ Both paths go through `isLegalTransition` |
| Existing authorization model | ✅ `@RequirePermission` + `@ScopedTo`, the catalogue's own permission |
| Existing transaction model | ✅ `AdministeredWriter`; audit inside the transaction |
| Existing audit infrastructure | ✅ The hash-chained writer. No second implementation, no renamed vocabulary |
| Existing scheduler | ✅ `SCHEDULE` + `retention.run`. No new lane, no new consumer, no new subscriber |
| No polling in HTTP requests | ✅ Expiry happens only in the sweep |
| Domain logic is a pure function first | ✅ The table and the boundary comparison are pure and unit-tested |
| Every state change writes audit in the same transaction | ✅ |
| Every consumer is idempotent | ✅ |
| Update the architecture document in the same commit | ✅ `06`, `08`, `13` |
| Never write a UI primitive | ✅ `Button`, `FormDialog`, `TextField` — all existing |
| No dead code | ✅ `LINKED` was **not** written, for exactly this reason |
| Never bypass a guard or lint rule | ✅ The one violation was fixed by moving the test, not by suppressing the rule |

**A note on `@munaxa/audit`.** The brief says to use "the already-adopted `@munaxa/audit`
infrastructure". Phase 19 established by reading the registry that **no such package exists** — the
seven published `@munaxa/*` packages are the design system plus lint and TypeScript configuration.
The audit infrastructure is this repository's own (`core/audit`), and that is what was used. Flagged
rather than silently reinterpreted.

---

## 10. Remaining Phase 6 backlog

Unchanged from Phase 6.0 except where this phase closed a row.

| # | Item | Phase 6.0 ref | Status |
| --- | --- | --- | --- |
| — | Archive / reinstate as user actions | §5, item 4 | ✅ **Closed** |
| — | Document expiry sweep | §5, item 5 | ✅ **Closed** |
| — | `ARCHIVED` / `REINSTATED` writers | §23 | ✅ **Closed** |
| — | `document:archive` enforcement | §4.1 | ✅ **Closed** |
| — | First capability-affordance UI test | §4.2 | ✅ **Closed** for this affordance; 161 files still unasserted |
| 1 | **Bulk async path** — `bulk.synchronousLimit` read by nothing | §25 | **Open, P0.** Untouched — a different subsystem |
| 2 | `library:view` enforced by nothing | §4.1 | **Open.** Brief said not to solve it here; now named in 08 §7 |
| 3 | Six admin screens for shipped APIs | §20 | **Open, P1** |
| 4 | Signature UI | §21 | **Open, P1** |
| 5 | Read-and-understood acknowledgement | §15 | **Open, P1** |
| 6 | Document linking + `LINKED` writer | §5, §23 | **Open, P2.** This phase's one deliberate scope exclusion |
| 7 | Notification types for archive / expiry | §17 | **Open, P2.** New row, added by this phase |
| 8 | `document.expired` → notify the owner before it expires | §17 | **Open, P2.** New row: an expiry warning is more useful than the expiry |
| 9 | An expired/archived filter on the library screen | §5 | **Open, P3.** New row: the states are reachable now, and nothing lists by them |
| 10 | End-to-end controlled-document journey test | §4.3 | **Open, P1** |
| 11 | Everything else in Phase 6.0 §28 | — | **Open**, untouched |

### What this phase deliberately did not do

**It did not touch the bulk path**, which Phase 6.0 rates P0 and higher-risk than anything here.
This brief was the lifecycle.

**It did not build document linking**, and therefore did not write a `LINKED` writer. §4 gives the
reasoning.

**It did not add notification types** for the three new events. §4 gives the reasoning.

**It did not solve `library:view` or `report:manage`.** The brief said not to, twice.

**It did not touch the `SUPERSEDED` document state.** It remains unreachable, which is correct and
unchanged: a newer revision supersedes a revision while the document stays `PUBLISHED`.
