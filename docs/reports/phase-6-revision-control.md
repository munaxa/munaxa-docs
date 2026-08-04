# Phase 6 — Revision Control: what was built, what it costs, and what it deliberately does not do

**Status:** point-in-time record of the Revision Control phase. Historical — superseded, never revised.
**Audience:** whoever builds Phase 7 and after, and whoever audits what Phase 6 claimed.

Phase 6 inherited more standing structure than any phase before it. `document_revision` was already
the full shape — contiguous ordinal, the label rendered once in the type's style, status, file
reference, change note, `uq (document_id, ordinal)` deliberately not partial on `deleted_at`.
`DOCUMENT_LOCK_REPOSITORY` sat declared in Document's ports with nothing implementing it and no
table beneath it. `LEGAL_TRANSITIONS` carried every `PUBLISHED`/`CHECKED_OUT` row from 06 §3 with
`IMPLEMENTED_TRANSITIONS` honestly narrower — and `APPROVED → PUBLISHED` already *offered* since
Phase 5, with nothing performing it. The permissions were in the catalogue with matrix rows in 08.
The events were declared and unpublished. What this phase did was make all of it true: the lock
bound, the rows performed, the events published, the transitions moved from the design table to the
honest one.

**Every new Document↔Revision seam follows the inversion Phase 3 cut.** `REVISION_WRITER` widened —
`createNext`, `setWorkingStatus`, `publish`, `discard`, `describe` — rather than a second pattern
appearing: Document declares each operation in its own vocabulary, Revision implements it and
publishes Revision's own events (`revision.created`, `revision.published`, `revision.superseded`,
`revision.restored`) from inside the caller's transaction. Nothing in Document imports anything of
Revision's; the composition binds them, as before.

## 1. The lock under concurrency, which was the risk

The sequence counter was Phase 5's named risk and timers Phase 4's; the lock is this phase's, and
it was built first. Two check-outs racing must produce one lock and one refusal, and that is a
partial-unique-index question, never a read-then-check question — the check that ran a moment
earlier is a moment old by the time the insert runs.

**The index is the referee.** `uq_document_lock_live` on `document_lock (document_id) WHERE
released_at IS NULL` — exactly the shape of `uq_workflow_instance_live`, for exactly the reason:
the live claim is unique, the history is unbounded, and the history is the point of having rows
(who held it, since when, how it ended, why). `acquire` is an insert against that index and nothing
else; a violation is translated into a refusal *naming the holder*, because a refusal that does not
say who is a refusal nobody can act on.

**The lock order against the document row is fixed and stated: the document row first, the lock row
second, revision rows last.** Every path that moves the document's status takes the row under its
optimistic version before touching `document_lock`, so two operations on one document serialise on
the row and cannot deadlock across the pair. In the common race the version guard settles it a
statement early — the loser's `UPDATE … WHERE version = n` matches nothing — and the index is the
invariant that still holds when some later path forgets the discipline. The expired-lock takeover is
the one path that touches the lock table without first moving the document row (the status is
already `CHECKED_OUT` and stays there), and it takes no document-row lock at all, which is what
keeps it deadlock-free against a concurrent cancel.

**Expiry is a tenant setting, swept in-line.** `documents.checkoutExpiryHours` (default 72) is read
at acquisition and stamped onto the lock. An expired live lock is released as `EXPIRED` by the next
check-out that wants the document — audited, inside that check-out's transaction — rather than by a
background job, because a lock nobody wants to take over excludes nobody and a sweeper would be a
process with nothing to protect.

The integration suite asks the database itself: two racing check-outs yield one live lock row and
one refusal; the loser's error names the holder; the takeover releases the lapsed claim as
`EXPIRED`.

## 2. The decisions the specification left open

**"Multiple file check-in" means many documents, not many files in one revision.** ADR-0003 gives a
revision exactly one file, and `document_revision.file_object_id` is that decision in a column. The
batch endpoint (`POST /documents/checkin`) checks several documents in — one transaction per item,
each with one file, outcomes reported per item so a refused antivirus verdict on the fourth
document does not roll back three honest check-ins. A request wanting several files inside one
revision is refused by the contract's construction. Attachments, if the product ever wants them,
are a later phase's modelling decision — not something to smuggle in as "the rest of the files".

**`keepCheckedOut` is what makes the cancel row reachable.** 06 §3's cancel says "draft revision
discarded", which requires a draft to exist under a live lock — and a check-in that always released
the lock could never produce one. So a check-in may keep the claim, recording the new revision as
the lock's working draft: a further check-in replaces it (the old draft `DISCARDED`, its ordinal
spent, its blob dereferenced), a cancel discards it and returns the document to `PUBLISHED`
untouched, and a force check-in preserves it by default (10 §3) — the document lands in `DRAFT`
exactly as if the holder had finished. `DISCARDED` joined the revision status enum for this; a
discarded draft stays in the history because a history with unexplained gaps is the opposite of
evidence.

**Effective dates live on the revision, not the document.** The 05 sketch drew
`effective_from/effective_to` on `document`; 10 §6 files effective dates under "belongs to the
revision", and 10 §6 is right — they describe one controlled version, and the document's own
effectiveness is its current revision's. The sketch is updated to the built shape and the
divergence recorded here, the same procedure as Phase 5's `number_reservation` drift.

**Publication is manual, and immediate.** 06 §3 allows "effective date reached or published
manually"; the manual half is built (`POST /documents/{id}/publish`, behind `document:publish`) and
the scheduled half deliberately is not — it needs a timer, and a future `effective_from` accepted
today would be a promise nothing keeps. So the effective-from date defaults to today in the
tenant's timezone, may state a past day (a policy that has in truth applied since the 1st), and may
not be in the future. Publication writes `published_at`, the effective window and the metadata
snapshot of 10 §6 — what the approver actually saw, provable after the live metadata moves on —
moves the prior published revision to `SUPERSEDED` (keeping its own `published_at`), and points
`current_revision_id` at the new revision, in one transaction. `uq_revision_published` (partial on
`PUBLISHED`, the second half of "exactly one" beside `uq_document_current_revision`) referees the
race; the suite publishes twice concurrently and counts one `PUBLISHED` row.

**An approved, unnumbered document does not publish — it is told where to go.** A document approved
under a definition with `assignNumber: false` is legitimately approved and unnumbered.
`ck_document_numbered_when_published` has stood guard since Phase 5; the use case refuses first,
with a sentence pointing at manual assignment under `numbering:manage`, because a person should get
a sentence before a constraint gets a violation.

**`MAJOR_MINOR` finally means something: publication increments the major.** Phase 3 stored the
label at creation and left "what increments a major" open. Decided: the major is the count of
publications before the revision was created plus one, the minor counts drafts since the last
publication — `1.0` for the original, `2.0` for the first draft after it publishes, `2.1` for that
draft's replacement after a discard. Rendered once, at creation, still: a revision's name never
changes when its document's later history does.

**The check-out refusal is `423`, not §3's `409`.** The platform's error catalogue has mapped
`LOCKED` to `423 Locked` since Phase 1, and it is the more precise status. The refusal carries the
holder and the expiry either way; the divergence from 10 §3's sketch is recorded here rather than
silently absorbed.

**Restore is guarded by `document:checkout`, because that is what it mechanically is.** A restore
is the check-out and check-in that produce the next revision, in one transaction — the same
transitions, a lock row acquired and released `CHECKED_IN` so the lock history says it happened,
the same refusal when somebody else holds the document. No new catalogue entry; the matrix in 08 is
unchanged by this phase, which is what "permissions exist" was supposed to mean.

## 3. What was built

| Piece | What it does |
| --- | --- |
| `prisma` — `document_lock`, revision columns, `DISCARDED`, two partial uniques | One migration: the lock with its live-claim index and release bookkeeping; `published_at`, `effective_from/to`, `restored_from_revision_id`, `metadata_snapshot` on `document_revision`; `uq_revision_published` |
| `infra/sql/post-migrate/03-content-gate.sql` | One more trigger: a restore source must belong to the same document — the same class of defence as `current_revision_belongs_to_document`, for the same worst failure |
| `document/application/revision-control.service.ts` | Check-out, check-in (single and batch), cancel, force check-in, publish, restore, per-revision download — every operation one transaction with its audit events and outbox rows |
| `document/infrastructure/prisma-document-lock.repository.ts` | The insert the index referees, the in-line expiry sweep, the release bookkeeping |
| `revision` — widened `PrismaRevisionWriter`, `RevisionQueryService`, `RevisionsController` | The writer implements the widened port and publishes Revision's events; the read side serves the timeline and the compare API behind `document:history:view` |
| `document/domain/lifecycle.ts` | `IMPLEMENTED_TRANSITIONS` gains the performed rows; `FROZEN_STATUSES` gains `CHECKED_OUT` |
| `document.service.ts` — `applyLifecycleTransition` | Keeps the revision's own machine in step: `DRAFT ↔ IN_APPROVAL` moves ride the document transitions that mean them |
| `document-number.service.ts` | The revision-cycle branch: a numbered document re-entering approval reserves nothing and keeps its number (see §5) |
| `RevisionControlAudit` | `CHECKED_OUT`, `CHECKED_IN`, `CHECKOUT_CANCELLED`, `CHECKOUT_FORCED`, `PUBLISHED`, `SUPERSEDED`, `RESTORED_FROM` — 13 §2's Revision rows, written from inside the transactions that earn them |
| `Settings.CHECKOUT_EXPIRY_HOURS` | The tenant-configured lock lifetime, 1 hour to a year, default 72 hours |
| Contracts — `documents/revision-control.ts` | Check-in (single and batch), force, publish, restore bodies; the history and compare shapes; `currentRevision` and `liveLock` on the document |
| Web | The revision panel on the document screen: check-out/check-in/cancel/force/publish/restore actions, the timeline with discarded drafts labelled, the compare summary, the version badge beside the number — never inside it — and the "checked out by whom, until when" banner. EN and AR in the same commit |

One migration; no new permission; no change to the engine's completion path.

## 4. Decisions worth carrying forward

**The two machines are kept in step by the transition that means it, guarded by what the revision
currently is.** `applyLifecycleTransition` moves the latest revision `DRAFT → IN_APPROVAL` on
submission and back on every road to an editable document — with the *current* status in the
writer's `WHERE`, so a transition that finds the revision elsewhere leaves it alone. That guard is
what makes the engine's repeated `UNDER_REVIEW` transitions harmless and the fresh check-in draft
(already `DRAFT` when the document follows it) untouched.

**Readers read the current revision, not the latest.** After a check-in the latest revision is an
unapproved draft; downloads and the file card serve `current_revision` — "the published revision
stays effective until the new one publishes" applies to bytes before anything else. The draft's own
bytes are reachable through the revision history, deliberately behind `document:history:view`.

**Restore costs a row, not a copy — and the suite counts.** The restored revision references the
old blob: `ref_count` up by one, `file_object` count unchanged, `restored_from_revision_id`
recorded, the source untouched evidence, the ordinal sequence contiguous. A trigger refuses a
restore source belonging to another document even for a raw owner-role write, because presenting
another document's approved content as this one's is the single worst thing this product could get
wrong, and Phase 6 opened one more door to it.

**The compare API promises only what it can keep.** Content by checksum (exact and free under
content addressing), metadata by the published snapshots — a draft has no approved snapshot, and
the response says `available: false` rather than diffing live values that prove nothing about what
an approver saw. Text and page comparison state `UNAVAILABLE`: the contract is stable, Phase 7's
artefacts fill the state in.

## 5. Defects and drift found while doing it

**A numbered document could not be re-approved.** Phase 5's `writeNumber` treated "the WHERE saw a
number already present" as unreachable — "a numbered document cannot re-enter approval" — which was
true until this phase made the revision cycle exist. The first full revise-approve cycle in the
integration suite died with *"This document already holds its number, forever."* The fix is the
deliberate branch the seam was always going to need: `reserveForSubmission` reserves nothing for a
numbered document and `assignAtApproval` returns the number it already holds — no counter moves, no
reservation is drawn, and the suite asserts the number identical across
`Original → R1` with 09 §4 finally testable rather than merely stated.

**`FROZEN_STATUSES` did not include `CHECKED_OUT`.** The phase brief described it as already
present; the code disagreed, and the integration suite's frozen-content assertion failed against a
checked-out document that cheerfully accepted a retitle. It is in the set now — 06 §1's "new draft
revision only" — added the moment the state became reachable, which is the same timing the set's
other members got in Phase 4.

**The revision module's Phase 0.5 skeleton ports had drifted from the built table.** The old
`RevisionRecord` sketch carried `author_id`, `change_summary` and a nullable file reference —
column names and shapes `document_revision` never had. Replaced by the read-side port the phase
actually serves; recorded here because the next phase that trusts a skeleton port's field names
over the schema will repeat it.

## 6. What it costs

| Cost | Detail | Mitigation |
| --- | --- | --- |
| **A checked-out document is fully frozen** | The holder edits offline; nobody edits metadata meanwhile — stricter than a lock on content alone | 06 §1 says "new draft revision only", and an edit landing under somebody working from a copy would change the record beneath them. Cancel or check in to edit |
| **Expired locks persist until wanted** | No sweeper; an expired lock sits released-in-name-only until the next check-out sweeps it | It excludes nobody: any later check-out takes over, audited. The holder is not yet notified of expiry — that is Phase 12's channel |
| **Publication serialises on the document row** | Two publishes contend on the version guard, then on `uq_revision_published` | Publication is a human act on one document; the tail is one transaction long |
| **The metadata snapshot is denormalised `jsonb`** | A second copy of the values, written at publish | That is its job — 10 §6's "prove what the approver saw" requires a copy the live values cannot rewrite. It is written once and never updated |
| **Batch check-in is sequential** | Fifty documents check in one after another, each its own transaction | Correctness first: per-item outcomes with no partial transaction. The cap is 50 items per request |
| **`revision.created` fires for restores too, beside `revision.restored`** | A consumer counting drafts sees the restored draft twice if it listens to both | The events mean different facts about one row; consumers idempotent on `eventId` (the standing rule) are unaffected |

## 7. Deliberate limits

| Limit | Why | Unblocked by |
| --- | --- | --- |
| No scheduled publication, no expiry | "Effective date reached" and `PUBLISHED → EXPIRED` need a timer watching `effective_from/to`; nothing runs one | The phase that schedules it |
| Document-level `SUPERSEDED` stays unperformed | A newer *revision* supersedes a revision; the document stays `PUBLISHED`. A document superseded by another document is `document_link`'s `SUPERSEDES`, unbuilt | The phase that builds document links |
| Text and page comparison `UNAVAILABLE` | They consume the preview pipeline's artefacts; the compare API's contract is this phase's, its rendering is not | Phase 7 |
| Rejection still creates no revision | By design: a rejected document is revised by editing the same draft, not by a new controlled revision. Phase 6's check-in is the only maker of revision *n+1*, and it starts from `PUBLISHED` | Never — this is the design |
| No lock-expiry notification | The holder should be told; there is no delivery channel | Phase 12 |
| Archival, retention, legal hold untouched | `ARCHIVED`/`PURGED` rows stay in the design table only | Phases 9/10 |
| Preview, search, delegation, the designer | Out of scope, named by the phase brief | Phases 7, 8, 11, 16 |

The Phase 3 report's "No second revision" row, the Phase 4 report's "`APPROVED` does not become
`PUBLISHED`" and "No revision on rejection" rows, and the Phase 5 report's "Revision control
untouched" and "`APPROVED` does not become `PUBLISHED`" rows are discharged by this phase — the
rejection row by confirming its design rather than changing it. Those reports are historical and
stand unedited; these lines are their discharge.

## 8. Verification

| Gate | Result |
| --- | --- |
| `pnpm format:check` | Clean |
| `pnpm lint` | Clean across all thirteen tasks |
| `pnpm typecheck` | Clean across all seven packages |
| `pnpm test` | 327 API tests (up from 325, including the major/minor lineage rules), 88 domain tests, plus the other packages and 21 web tests |
| `pnpm test:integration` | 20 files / 331 tests (up from 19 / 312) against real PostgreSQL, two tenant databases |
| `pnpm build` | Clean, API and web |
| `pnpm prisma:deploy` | Verified against two tenant databases, including the new migration, its constraints and the restore-source trigger |

`revision-control.integration.spec.ts` carries the phase's own assertions, and each asks something
only a database can answer: two racing check-outs yielding one live lock row and one refusal naming
the holder; two racing publishes yielding exactly one `PUBLISHED` revision; the frozen-content
refusal against a checked-out document; the restore that adds one reference and zero blobs, with
the ordinal sequence contiguous and the source untouched; the expired-lock takeover audited as
`EXPIRED`; the batch check-in reporting per-item outcomes with the failed item taking nothing else
with it; the trigger refusing a restore source from another document even for the owner role; and
the full revision cycle — publish, check out, check in, approve, publish again — with the prior
revision `SUPERSEDED` in the same transaction and the document number identical throughout.

The pure additions are unit-tested where they live: the major/minor lineage beside the label
renderer, against the decision as taken — publication increments the major, a replaced draft
increments the minor, and a lineage that does not count whole revisions is refused.
