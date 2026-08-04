# Phase 5 — Document Numbering: what was built, what it costs, and what it deliberately does not do

**Status:** point-in-time record of the Document Numbering phase. Historical — superseded, never revised.
**Audience:** whoever builds Phase 6 and after, and whoever audits what Phase 5 claimed.

More of this phase existed before it started than any previous phase's subject did. Phase 2 built
the whole administration of numbering — the rule and its segment list, the save-time validation,
`number_sequence` with its scope-key uniqueness, the admin screen with a live preview — and drew
nothing. Phase 4 cut the engine's side of the seam exactly: `DOCUMENT_NUMBER_ALLOCATOR` declared,
`@Optional` in the constructor, deliberately unbound, with `assignAtApproval` already called inside
the approval's transaction and `numberAssigned` recorded either way.

Phase 5 is everything in `09-numbering-architecture.md` §2 and §3: `number_reservation`, the
issuance service, the one write path onto `document.document_number`, and the binding. **Binding the
allocator made every completed approval numbered with no change to the engine's completion path**,
and the integration suite's "completes without a number" assertion flipped to "completes with one" —
which is the phase working, not a regression, and was the test Phase 4 set for whether its seam was
cut correctly. The unbound composition is still asserted beside it, because "an approval completes
honestly unnumbered when nothing is bound" remains a property of the engine.

## 1. The counter under concurrency, which was the risk

Timers were Phase 4's named risk; the counter is this phase's, and it was built first. A hundred
documents approved at the same instant in one series must receive a hundred distinct numbers, and a
duplicate is not a bug that can be fixed later — it is a duplicate identifier on printed paper.

**The claim is one statement.** Not `SELECT … FOR UPDATE` followed by `UPDATE`, but an upsert whose
conflict arm increments:

```sql
INSERT INTO number_sequence (…, next_value, …) VALUES (…, 2, …)
ON CONFLICT (tenant_id, numbering_rule_id, scope_key)
DO UPDATE SET next_value = number_sequence.next_value + 1
RETURNING next_value - 1 AS claimed
```

It takes exactly the row lock §2 describes and holds it for the microseconds until commit, creates
the series on first use — so "which draw creates the counter" stops being a race of its own — and
closes the read-then-write window two statements would reopen. A rolled-back transaction takes its
claim with it, which is correct: the gap ADR-0004 tolerates is a *voided reservation*, a committed
fact, never a counter that half-moved.

**Lock order is fixed and stated.** Phase 4's instance lock already serialises decisions per
approval; two approvals in one series additionally contend on the sequence row. Every path takes its
locks in the same order — the workflow instance first (every engine write path already does), the
document row next (`assignNumber`), the sequence row always last, inside the allocator. Two
approvals in one series therefore serialise on the counter for the shortest possible tail of their
transactions, and cannot deadlock across it, because nothing ever takes the sequence lock before an
instance lock. The manual path holds no instance lock and keeps the same relative order: document,
then sequence.

The integration suite asks the database itself: a hundred parallel draws in one series produce
exactly 1–100; two series never move each other; five full engine approvals deciding in parallel
produce five distinct consecutive numbers.

## 2. The decisions the specification left open

**A reservation's text and series are fixed when the value is drawn.** §1 says `YEAR`/`MONTH` come
from the assignment date; a reservation drawn in December and approved in January puts the two in
tension. The decision: the pending reference reviewers held is the number the document receives.
The formatted text and the scope key are computed once, at drawing time, in the tenant's timezone
(`locale.timezone` — the same clock the working calendar counts deadlines against), and assignment
never re-renders. The value was spent from December's counter, so December's series is where the
gap would fall if the approval failed — the counter a value came from is the counter that accounts
for it. `numbered_at` records the assignment instant separately. For a rule that draws only at
approval the tension does not arise: drawing and assignment are one transaction.

**No `expires_at`, because a reservation cannot leak.** The Phase 0 sketch of `number_reservation`
carried an expiry. Every path that ends an instance — rejection, return to author, withdrawal,
cancellation, the overdue `TERMINATE` — voids the reservation in the same transaction, and an
instance cannot end any other way, so a reservation lives exactly as long as its approval and a
sweeper would have nothing to sweep. The column was left out rather than left null; the report
records the divergence, and `05-database-design.md` now shows the built shape. The reservation also
carries `(numbering_rule_id, scope_key)` rather than the sketch's `sequence_id`: a reservation
belongs to a series' identity, not to the counter row.

**The scope key is computed from the document's real context, never from a client.** The schema
comment on `number_sequence.scope_key` promised "built by the application"; this phase is what makes
it true. Document resolves its own codes — entity and department from the library's scope chain,
exactly as the approval context resolves participants; company from the same chain; the branch
through the department's `branch_id`, a read Organization did not have and now has (`branchCodeOf`,
the one read anything outside administration makes of a branch, and still never part of a chain).
The codes go to Administration's issuance service, which owns the formatting and the counters.
Nothing a client sends reaches a scope key; the held-block endpoint is the one place codes arrive in
a request body, and it is an administrator naming a series under `numbering:manage`, not a client
influencing its own document.

**Manual assignment is `numbering:manage`, not a new catalogue entry.** §3's manual path needed a
permission decision. Recording a number by hand is a document controller's act on the numbering
system — the same authority that configures the rules and holds blocks — not an edit of a document,
so it reuses the existing key rather than adding one, and the matrix in
`08-permission-model.md` is unchanged: the row already reads tenant administrator and document
controller, which is exactly who this is for. A finer `numbering:assign` can be split out if a
tenant ever needs a person who assigns but must not reshape rules; nothing in the code assumes the
two are one key beyond the two `@RequirePermission` decorators.

**`ck_document_numbered_when_published` was added now.** `PUBLISHED` is not reachable until Phase 6
builds publication, but the constraint is statable today without a caveat —
`CHECK (status <> 'PUBLISHED' OR document_number IS NOT NULL)` — and adding it now means the rule
stands *before* the code it constrains exists. A Phase 6 publication path that skipped numbering
would be refused by the database before it passed review. `ck_document_numbered` was added beside
it: the number and `numbered_at` travel together, both ways.

## 3. What was built

| Piece | What it does |
| --- | --- |
| `prisma` — `number_reservation`, `document.numbered_at`, two enums | Every value ever drawn, recorded forever; partial unique indexes keep one live pending value per approval and per document |
| `administration/application/numbering-issue.service.ts` | The drawing: reserve, commit, release, manual assignment, held blocks — every mutation with its own audit event, inside the caller's transaction |
| `administration/infrastructure/prisma-number-issue.repository.ts` | The one-statement claim, the `GREATEST` fast-forward, the reservation rows |
| `administration/domain/numbering.ts` — `matchManualNumber` | §3's shape validation, by reconstruction: the non-sequence segments render to known strings, and the candidate either is that rendering or is refused |
| `document/application/document-number.service.ts` | The document's side: code resolution from its real placement, the write-once `assignNumber`, the `document.number-assigned` event |
| `workflow/infrastructure/document-number-allocator.adapter.ts` | The binding that fills Phase 4's seam — a remap and nothing else |
| Engine: reserve on submit, void on every non-approval ending | Three call sites, each inside the transaction of the move it accompanies |
| `organization` — `branchCodeOf` | The branch code's first read path |
| Web | The pending-number marker on a document under review, manual assignment behind `numbering:manage`, and the per-rule reservations screen with held blocks |

One migration; no change to any existing table beyond the one document column.

## 4. Decisions worth carrying forward

**Write-once is a property of the statement.** `assignNumber` carries `document_number IS NULL` in
its `WHERE`, so a numbered document matches no rows whatever raced ahead — the same shape as Phase
4's `decideIfPending`, for the same reason. There is no update path; §5's "never changed" is not a
check that ran a moment earlier.

**A voided value blocks its text as firmly as an assigned one.** `uq (tenant_id, formatted)` on the
reservations is deliberately not partial on anything, and it is the second half of never-reused —
`uq (tenant_id, document_number)` ignoring `deleted_at` is the first. The delete-and-recreate
refusal in the suite exercises both: a deleted document's number is refused to a new document by
constraint, not by courtesy.

**A manual number fast-forwards the series its own text names.** `…-2019-0154` moves 2019's counter
past 154 — never backwards, by `GREATEST` — so a legacy import cannot spend the live series and a
later automatic draw cannot collide with it. A supplied value matching a `HELD` reservation claims
it rather than colliding with it, which is what a held block is *for*: the offline process comes
back, and its numbers attach.

**Gapless mode is the same code path, not a second one.** `reserveOnSubmit: false` and
`strictGapless: true` both collapse to "draw at approval": the reservation and the assignment happen
in the one transaction, so no reservation can ever be voided — which is the entire guarantee. The
policy read (`policyFor`) folds the two flags into one boolean the callers act on, and nothing
downstream knows which mode asked.

**Every issued value has a row forever, and the screen shows the voided ones.** ADR-0004 says
visible gaps must be explained rather than treated as defects, so the reservations screen lists
`VOIDED` beside `ASSIGNED` — each gap in a series has a row saying what became of the value, who
voided it and why.

## 5. The validator rule tightened while building §3

`MONTHLY` reset previously required only a `MONTH` segment. A monthly counter restarts every month
of every *year*, and a number whose text carries only the month renders identically in March of two
consecutive years — the same text for two different documents, which `uq (tenant_id, formatted)`
would refuse at issuance a year after the rule was saved, in production, with no way to renumber.
`checkRule` now pairs `MONTHLY` with `YEAR` as well as `MONTH`, refusing the rule at save time —
the same courtesy the padding rule extends. Found while writing `matchManualNumber`, whose
reconstruction of a number's expected form made the collision obvious.

## 6. What it costs

| Cost | Detail | Mitigation |
| --- | --- | --- |
| **Approvals in one series serialise on the counter** | The sequence row lock is held from the draw to commit | It is the last lock the transaction takes, so the hold is the tail of the transaction, and two series never touch. §2's throughput expectation holds |
| **A reservation spends a value even if the approval fails** | Rejection voids it; the series shows a gap | The design's own trade-off (ADR-0004): a tenant that cannot accept gaps sets `strictGapless` |
| **`IMPORTED` origin exists and nothing writes it** | The manual endpoint records `MANUAL`; a bulk legacy import is a later phase's feature | One enum value waiting, not a code path pretending. The import path will reuse `assignManual` with the origin it deserves |
| **The held-block form takes codes as text** | An administrator types `entityCode` rather than picking a node | The codes name a series, not a permission; a wrong code holds values in a series nobody draws from, visible on the same screen. A picker is polish, not correctness |
| **The pending number is fetched per document detail** | One extra indexed read on an unnumbered document's `GET` | Partial index on `(tenant_id, document_id) WHERE state = 'RESERVED'` serves it; numbered documents skip the read entirely |
| **`before` states in numbering audit events are thin** | `NUMBER_ASSIGNED` records what was assigned, not a before-image | The before-state of an assignment is "no number", which the event's existence already says |

## 7. Deliberate limits

| Limit | Why | Unblocked by |
| --- | --- | --- |
| Revision control untouched | The number identifies the document, not the revision (§4); nothing in this phase touches `document_revision` | Phase 6 |
| `APPROVED` does not become `PUBLISHED` | Publication needs the effective-date policy and "exactly one published revision". `ck_document_numbered_when_published` already stands guard over it | Phase 6 |
| No bulk legacy import | §3's import row is served by the manual path one document at a time; a migration tool is its own feature | The phase that builds import |
| No correction path for a wrong number | By design, not omission: supersede and reference, never renumber (§3) | Never |
| `METADATA` / `CUSTOM_PREFIX` / `SUFFIX` segment kinds from §1's table | Phase 2 did not model them and no rule can name them; adding them is validator + formatter work with no schema change | The phase a customer needs them in |
| Preview, search, delegation, the designer | Out of scope, named by the phase brief | Phases 7, 8, 11, 16 |

The Phase 4 report's §9 row — "No document number at approval … Unblocked by Phase 5" — is
discharged by this phase. That report is historical and stands unedited; this line is its
discharge.

## 8. Defects and drift found while doing it

**The `number_reservation` sketch in `05-database-design.md` had drifted from what §2 needs.**
`sequence_id` would tie a reservation to a counter row that upsert-on-first-draw may not have
existed when the sketch was written; `expires_at` assumed a leak path the transactional voiding
closes. Both divergences are recorded in 09's Phase 5 notes and 05 now shows the built shape.

**A test that looks up by formatted text must filter by tenant.** `formatted` is unique per tenant,
and the integration database hosts every past run's tenants — an owner-client
`findFirstOrThrow({ formatted })` happily returned another tenant's row of the same text. Caught by
the suite's own full run; recorded because the next test that queries a per-tenant-unique column
through the owner client will hit it too.

**Three audit actions existed only on paper.** `13-audit-architecture.md` §2 has named
`NUMBER_RESERVED`, `NUMBER_ASSIGNED` and `NUMBER_VOIDED` since Phase 0, and no code declared or
wrote them. They are in `AdministrationAudit` now, written by the issuance service from inside the
issuing transaction — the catalogue and the code agree again, which is the only state a compliance
document is allowed to be in.

## 9. Verification

| Gate | Result |
| --- | --- |
| `pnpm format:check` | Clean |
| `pnpm lint` | Clean across all thirteen tasks |
| `pnpm typecheck` | Clean across all seven packages |
| `pnpm test` | 325 API tests (up from 318, including the manual-number matcher), 88 domain tests, plus the other packages and 21 web tests |
| `pnpm test:integration` | 19 files / 312 tests (up from 18 / 301) against real PostgreSQL, two tenant databases |
| `pnpm build` | Clean, API and web |
| `pnpm prisma:deploy` | Verified against two tenant databases, including the new migration and its constraints |

Two suites carry the phase's own assertions, and each asks something only a database can answer.

`numbering-issue.integration.spec.ts` is the counter alone: a hundred parallel draws in one series
yielding exactly 1–100, two series fully independent, fast-forward never moving backwards, and a
rolled-back claim leaving no trace.

`workflow-engine.integration.spec.ts` gained a numbering section over the full stack: the flipped
completes-with-a-number assertion (submission's pending value becoming the document's number, same
text), the unbound composition still completing honestly unnumbered, five parallel engine approvals
drawing five distinct consecutive numbers, rejection and withdrawal voiding without reuse, gapless
mode holding no reservation during review, the manual path fast-forwarding and refusing every
collision — including a deleted document's number — and a held block that the automatic path skips,
a manual assignment claims, and a release voids forever.

The pure additions are unit-tested where they live: `matchManualNumber` beside the formatter in the
administration domain, against the architecture's own worked example, including the legacy-year
series decision, the wider-than-padding counter, and the one-admissible-spelling rule for optional
segments.
