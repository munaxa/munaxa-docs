# Phase 10 — Soft Delete & Retention: what was built, what it costs, and what it deliberately does not do

**Status:** point-in-time record of the Soft Delete & Retention phase. Historical — superseded, never revised.
**Audience:** whoever builds Phase 11 and after, and whoever audits what Phase 10 claimed.

This phase inherited two halves of a capability that had never been introduced to each other.

Soft delete was further along than it looked. `deleted_at` was on the tables that have it,
`deletedFilterSchema` was a three-way `live | deleted | all` filter every administration list
already spoke, and `AdministrativeOperation` had `DELETED` and `RESTORED` values every administered
write already recorded. What was missing was not a mechanism but an *answer*: Phase 3's document
delete, Phase 2's folder delete and Phase 6's revision handling each decided locally what deletion
reaches, and the three decisions did not compose.

Retention was the last module in the product still an empty `@Module({})`. `RETENTION_SCHEDULE_REPOSITORY`
and its siblings had been declared and unbound since Phase 0.5. `RetentionPolicy` had been an
administered resource since Phase 2 — configurable, and drawn by nothing. The `retention.run` lane
was declared with concurrency 1 and the sentence "destruction is never run concurrently with
itself", and two schedules sat on it unconsumed.

And `StorageService.listUnreferenced` had carried the comment "only retention calls this, and only
at a reference count of zero" since Phase 3 without ever being called — which, it turns out, was
the tell.

## 1. The decision the phase turned on: what does deleting this cascade to?

There was no single answer, and finding out why is what shaped everything else.

`DefaultDocumentService.remove` gave back the reference on the document's **latest** revision. That
was correct in Phase 3, where a document had exactly one revision and no path existed to a second.
Phase 6 then gave documents as many revisions as anybody wanted, each taking a reference on its
blob at creation, and did not revisit the delete. So a document with four revisions returned **one**
reference when it was deleted. Three blobs stayed at a count of one forever.

Nobody noticed because nothing swept. `listUnreferenced` had no caller, so the query that would
have found zero blobs was never run, and the blobs that could never reach zero were never missed.
The two halves of this phase are the same defect seen from two ends.

Meanwhile `cascadeDeleteFolder` soft-deleted folders and stopped: the documents inside a deleted
folder stayed live — reachable by search, and by nothing else — although ADR-0010 §3 has said since
Phase 0 that deleting a folder cascades over its subtree.

**The answer is a table, not a fix.** `DOCUMENT_DELETION_RULES` in `@edms/domain` names every
relation a document's deletion reaches, what a delete does to it, what a purge does, and why — in
the same idiom and for the same reason as the permission catalogue and the queue catalogue: a rule
that is not there does not exist, and a relation absent from it is a relation nobody decided about.

It is pure data, and that is what keeps it from becoming documentation. The purge iterates the
foreign-key order it encodes; the integration suite reads the *same rows* and asserts row counts
per relation after a delete and after a purge. A relation added to the product without a decision
recorded in that table fails a test.

Three rows in it are worth reading on their own:

- **`number_reservation` is `RETAINED` on purge** — the only child row that outlives its parent
  entirely. ADR-0004's "never re-issued, even after deletion" is implemented by *keeping* the
  reservation and severing its pointers, so the formatted value stays unique forever with nothing
  left to point at.
- **`workflow_instance` is `REMOVED_ON_PURGE`**, and that was not obvious. Approval history feels
  like evidence. It is not *the* evidence: `SUBMITTED`, `APPROVED` and every decision are already in
  the audit trail, which refuses deletion. Keeping the instances would keep stage names, comments
  and reviewer notes about a record the policy said to destroy — a retention policy that destroys
  the document and keeps a transcript of the discussion about it is not a retention policy.
- **`preview_artifact` is `RETAINED` on delete and `DEREFERENCED` on purge.** A restored document
  must show the preview it had rather than queue a re-render, so the artefacts survive the
  reversible half; the purge gives their references back so derived blobs reach zero with their
  originals.

## 2. The named risk: `PURGED` must not purge its own evidence

13 §6 is explicit — a purged document's trail remains, "with the document number preserved so the
record is still meaningful" — and Phase 9 made it enforceable rather than merely stated:
`audit_event` refuses `DELETE` to every role including the owner, by trigger, so a purge that tried
to remove a document's trail fails loudly.

That is the constraint to design with, and it has a consequence the brief named and this phase had
to settle: **if the trail outlives the row, where does the document number live?**

Not in the rows already written. Adding it would be an `UPDATE` on `audit_event`, and that is the
single operation this product will not perform on that table for any reason — it is the property
the whole design exists for. Phase 9 met the same wall from the other side and versioned the digest
rather than backdating it; this phase meets it and writes elsewhere rather than rewriting.

**`document_tombstone` is where it lives.** One row per purged document, written by the purge, in
the purge's own transaction, from facts read *before* anything was removed — the number, the title,
the type name as it stood, the folder path, when it was deleted and when it was destroyed. Keyed by
the document identifier, which is exactly what every one of those audit rows already carries as
`subject_id`. It carries no `deleted_at`: a tombstone the recycle bin could hide would be a
headstone somebody could bury. It carries no foreign keys either, deliberately — to `document`
(gone by the time this commits), to `retention_schedule` and `retention_policy` (removed with it or
years later), to `document_type` (which a tenant may retire afterwards). A reference that a later
delete could break is one that would either block that delete or leave this row unreadable.

**What it costs, stated plainly.** For every audit event written **before this phase**, the document
number is *not* in the row and never will be. Reading an old trail for a purged document means one
join, to the tombstone, on an identifier the row already has. Events written from here on are
better off: the `PURGED` row carries the number, the title, the type and the path in its own
payload, so the last event of a document's life is legible with no join at all. There is no version
of this that puts a number into a row already hashed, and a design that offered one would be a
design in which the trail can be edited.

The purge writes **two** audit events, and that is deliberate rather than duplication. 13 §2 lists
`PURGED` under Document and `PURGE_EXECUTED` under Retention, in two groups, because they answer to
two readers: the first is the last entry on that document's own timeline and reads as "this record
was destroyed on this date"; the second carries the schedule, the policy and who approved the
disposition, which is what a records-management report reconciles against the policy register.
`AdministeredWriter` gained `record` for the second — one transaction, two events, same chain.

## 3. The specification left two things open, and both had to be decided

**"Drafts may be permanently deleted" versus "no user action ever destroys data".** The phase brief
says the first; ADR-0010 §1 and §4 say the second, and §4 rejects the administrator's "purge now"
button *by name* as "the exact mechanism by which records under an unnoticed legal hold get
destroyed".

They are reconcilable, and the reconciliation is where the recycle-bin window comes from. The
*delete* verb is soft for every document without exception, so ADR-0010 §1 holds and the recycle bin
is never a lie. What differs by document is **purge eligibility**: a document that has never held a
number and whose type names no retention policy has nothing to compute a disposition date from, so
its recycle-bin window *is* its retention period — `retention.recycleBinDays`, a tenant setting
defaulting to thirty days. The schedule it produces is an ordinary `retention_schedule` row with a
null policy, executed by the same sweep, on the same lane, with the same hold check and the same
tombstone. "Permanently deleted" therefore means "eligible for disposition after the window",
through the one destruction path, rather than "a button that removes rows".

A numbered document is never on that clock, however long ago it was deleted: it was approved, so its
frozen policy decides. That is the same sentence read from the other side.

**Review is forced for a purge, whatever the policy ticked.** ADR-0010 says a human disposition
review is "required for irreversible ones", and the policy screen lets an administrator leave
`reviewRequired` unticked on a `PURGE` policy. `proposeSchedule` sets it true regardless. An
administrator can configure a policy that destroys records without anybody looking; the product
will not honour it.

The one exception is the unnumbered draft's recycle-bin window, which is deliberately *not*
reviewed: a draft never numbered, never approved and never published is not a record anybody is
accountable for, and requiring a person to confirm each one would make the review queue a list of
other people's abandoned uploads.

## 4. Volume: the trigger fired, and the answer was still no

Phase 9 deferred `audit_event`'s monthly partitions and cold-storage tiering with a stated trigger:
"Phase 10, or the first tenant past tens of millions of rows, whichever comes first." Phase 10
arrived, and this section is the accounting — a trigger that fires and is quietly reset is a
deferral nobody is accountable for.

**The partitions are deferred again, with a new trigger, because Phase 9's reasoning survived its
own trigger.** Phase 9's argument was that partitioning is building the mechanism a month before
anything can use it, and that "the retention that would detach a partition is Phase 10's". The
second half is what turned out to be wrong, and pleasingly so: Phase 10's retention purges
*documents*, and its central constraint is that it must not touch `audit_event` at all. Nothing this
phase built detaches an audit partition, and nothing it built ever will. A document's disposition
and the trail's own compliance period are different clocks with different periods, and conflating
them is the failure mode 13 §6 exists to prevent.

What *would* detach a partition is a sweep over the trail's own seven-year period, and no deployment
of this product is seven years old. Building the detach path now would mean writing and maintaining
the one destructive operation on the one table that may not be rewritten, against a size no tenant
has, for a clock that has not started.

The new trigger is deliberately two conditions, so that neither can be read as belonging to a phase
that will not do it: the first tenant whose `audit_event` passes **twenty million rows**, or the
phase that gives audit its own retention period a disposition. Neither is Phase 11's, 12's or 13's
by any reading. 13 §6 now carries this, in the document rather than only here.

**What this phase does add is four indexes, every one of them partial**, and the partiality is the
decision. Phase 9 observed there was an index on `(tenant_id, action, occurred_at)` and none on
`deleted_at`. A *full* index on `deleted_at` would index the whole library to answer questions about
the thousandth of it that is deleted, on the busiest table after `audit_event`. So:

| Index | Predicate | Question |
| --- | --- | --- |
| `ix_document_deleted` | `deleted_at IS NOT NULL` | The recycle bin, newest first |
| `ix_retention_schedule_due` | `state IN ('PENDING','IN_REVIEW')` | 05 §3's own index, widened by one state — a schedule waiting for a reviewer is still due |
| `uq_retention_schedule_live` | `state IN ('PENDING','IN_REVIEW','SUSPENDED')` | One live schedule per `(document, trigger)` |
| `ix_legal_hold_live` | `released_at IS NULL` | "Is this held" — a released hold answers no |

`uq_retention_schedule_live` is the one that does real work beyond speed: it is what makes a
redelivered trigger update a row rather than queue a duplicate the sweep would then execute twice.

## 5. The module graph, and the one cycle that had to be broken twice

Retention depends on Document — the sweep asks it to purge. Document depends on Retention — its
delete asks whether a legal hold refuses, and writes a schedule. That is a cycle, and `forwardRef`
would have hidden it rather than resolved it.

**It is split at the line the dependency actually falls on, into two Nest modules over one folder.**
`RetentionModule` is everything *below* Document: the repositories, the policy reader,
`LEGAL_HOLD_SERVICE` and `RETENTION_SCHEDULER` — the seam a delete, restore or publication calls
inside its own transaction. `DispositionModule` is everything *above*: the sweep, the recycle bin,
the lane consumer and the HTTP surface. Neither knows the other exists. `DefaultLegalHoldService`
takes an identifier, writes a row and audits it, and reads nothing about documents — which is what
keeps the lower half genuinely lower.

The second cycle is Library's, and it is the one place in this product where plain DI could not
express the inversion. A folder's delete must reach the documents inside it, in Library's own
transaction, so an outbox event is not available. But Document already imports Library — a document
sits in a folder — so Library cannot import Document's module for a binding. **`FolderContentsRegistry`**
breaks it the way Preview's renderer registry does: Library declares the interface and holds the
slot; Document, which imports Library anyway, fills it in `onModuleInit`. Unfilled, it deletes
nothing and says nothing — honest rather than lax, because a composition with no documents genuinely
has none to cascade to, which is Library's own integration suite.

## 6. The lane, and the precedent it follows rather than departs from

`retention.run` was the last declared lane in the product with no consumer. `RetentionLaneConsumer`
is `AuditLaneConsumer`'s shape, deliberately unchanged: it runs in the **API process** behind
`queue.consumersEnabled` — every consumer since Phase 4 lives there, and `apps/worker` composes none
of the domain modules, so moving destruction there would mean composing them twice — and it declares
its schedules as **named** cron entries through `QueuePort.schedule`, so ten instances booting
produce one firing rather than ten.

Both of the lane's schedules land here: `retention.sweep` nightly and `storage.sweep-upload-sessions`
every fifteen minutes. Sharing one lane at concurrency 1 is the catalogue's own decision and worth
restating rather than second-guessing: the concurrency is 1 because *destruction is never run
concurrently with itself*, and expiring an abandoned upload deletes staged bytes, which is
destruction too — just of something nobody finished claiming. If the fifteen-minute sweep ever
queues behind a long nightly run, that is the lane working, not a defect: an abandoned upload
expires just as well four minutes later.

Idempotency lives below the consumer, where it belongs. A purge removes its schedule in the same
transaction as its document, so a redelivered sweep re-reads `listDue`, finds nothing live, and does
nothing — asserted directly in the suite rather than assumed.

## 7. What was built

| Area | What |
| --- | --- |
| The cascade | `DOCUMENT_DELETION_RULES` — one table, read by the code and by the suite; `delete_cascade_id` on `document` and `document_revision`; the folder cascade reaching documents at last |
| Soft delete | A mandatory reason on the row *and* in the trail's `reason` column; every revision's reference given back; a delete answering to the lifecycle table rather than the frozen set |
| Restore | By cascade identifier, so it reverses exactly one delete; a `DISCARDED` revision's row returns without its (absent) reference |
| Recycle bin | `/recycle-bin` — 16 §2's route, built; a `UNION ALL` read model over `document` and `folder`, paged and totalled in SQL; restore delegated to the owning modules' endpoints |
| Retention | `retention_schedule`, `proposeSchedule`/`decideDisposition` as pure rules, the sweep, `DISPOSITION_APPROVED` as the only manual step |
| Legal hold | `legal_hold`, `ErrorCode.LEGAL_HOLD` finally thrown, schedules suspended and resumed rather than skipped, several holds per record with release-the-last semantics |
| Purge | `RetentionDispositionAdapter` — eleven relations, one transaction, foreign-key order; `document_tombstone`; `PURGED` and `PURGE_EXECUTED` |
| Storage | `StorageBlobReaper` — `listUnreferenced` and `StoragePort.delete` called at last, `FOR UPDATE` re-check, `retention.blobGraceDays`; abandoned upload sessions and their staged objects |
| Queue | `RetentionLaneConsumer` draining `retention.run` and declaring both of its schedules |
| Core | `AdministrativeChange.reason` and `AdministeredWriter.record` — the trail's `reason` column written for the first time, and a second event in one transaction |
| Contracts | `packages/contracts/src/retention/` — the bin, the delete body, holds, the disposition queue and the register. No purge request shape exists |
| Web | `/recycle-bin` with its navigation row; the delete confirmation's mandatory reason on the document list only; en and ar |
| Docs | 05 §4 and §7, 10 §7, 13 §6 and a Phase 10 section; the retention, document, library and storage module READMEs |

## 8. What it costs

| Cost | Detail | Mitigation |
| --- | --- | --- |
| **A join to read an old purged trail** | Events written before this phase carry no document number; it is on the tombstone | The alternative is `UPDATE` on `audit_event`, which is the one operation this product refuses. Events written since carry it in the `PURGED` payload |
| **Two Nest modules for one capability** | `RetentionModule` and `DispositionModule` over one folder | The dependency genuinely runs both ways. `forwardRef` would hide the cycle instead of resolving it, and the split is one file with the reason written in both |
| **The purge writes rows five modules own** | `workflow_instance` and `number_reservation` are touched by Document's disposition adapter | The cascade must be one transaction and its order is the foreign keys'. A port per owner — one caller, one statement each — would put the order in no module at all, which is how three local answers arose in the first place. The contract is the table; the suite enforces it |
| **The recycle bin reads two modules' tables** | A `UNION ALL` over `document` and `folder` in Retention's infrastructure | A read model that writes nothing — Search's `PrismaSearchSourceReader` exception, for the same reason: merging two paged lists in memory makes `total` a lie |
| **A blob survives its last reference by a week** | `retention.blobGraceDays`, default 7 | Without it, a delete and a restore an hour later would restore a row pointing at nothing. Configurable, and the cost is storage the tenant is already paying for |
| **The sweep settles schedules one transaction each** | A pass is N transactions rather than one | A pass that failed on schedule ninety-seven would otherwise roll back ninety-six purges, every one of which had already earned a tombstone and two audit rows the trail cannot take back |
| **`retention.due` is delivered nowhere** | Published to the outbox, routed to a lane with no reminder consumer | The Phase 4 and Phase 9 position: the row is the record until a consumer exists. The disposition queue is a screen somebody opens, not a notification — Phase 12 makes it one |
| **Four more indexes on the two busiest tables** | `document` gains two, and two new tables gain one each | Every one is partial on the rows the question is about. The recycle bin, the sweep and the hold check are all unusable without them |
| **A hold on a document is checked twice per purge** | Once for the sweep's counts, once inside the destroying transaction | The second is the one that counts. The first is a read; removing it would make the counts a guess |

## 9. Deliberate limits

| Limit | Why | Unblocked by |
| --- | --- | --- |
| Still no monthly partitions or cold-storage tiering on `audit_event` | §4 above: Phase 9's trigger fired and its *reasoning* survived — this phase's retention deliberately never touches the audit table, so the mechanism would still have no user | Twenty million rows in one tenant's trail, or the phase that gives audit its own disposition |
| A published document cannot be deleted at all | The lifecycle table has no `PUBLISHED → DELETED` edge, and `ARCHIVED → DELETED` is the road. Archival is not this phase's — 13 §2 attributes `ARCHIVED`/`REINSTATED` to "the phase that builds each capability" | The archive phase. Retention can still *dispose* of a published record; a person cannot delete one |
| `ON_ARCHIVE` schedules are unreachable | Nothing archives a document except this phase's own `ARCHIVE` disposition, which is the end of a schedule rather than the start of one | The archive phase |
| The recycle bin holds documents and folders only | Administered configuration is deleted and restored on its own screen, beside the dependent-count refusal that explains it. Sixteen restore paths reachable from a screen showing none of their context is worse than sixteen screens | Nothing — this is the design |
| A legal hold does not block a restore | ADR-0010 §5 blocks "disposition and deletion"; a restore is neither, and putting a record where the matter can read it takes nothing away. The hold blocks the *delete*, so a held record cannot enter the bin, and the purge of one already in it | Nothing — a refusal here would be a rule the ADR does not state |
| The delete reason is mandatory for documents only | A controlled record's removal is an act somebody answers for; demanding a paragraph to retire an unused category is ceremony, not evidence | Nothing — this is the decision |
| No disposition-review reminder | 12's | Phase 12 |
| No disposition or hold screens beyond the API | The endpoints exist and are gated; the *screens* for the review queue and the register are dashboard work, and a review queue with no dashboard to sit on is a page nobody opens — the position Phase 9 took for the activity feed | Phase 13 |
| Quota accounting still cannot distinguish live, deleted-but-retained and derived bytes | ADR-0010's consequence 4. Entitlements are Phase 21's, and there is no quota to account against | Phase 21 |
| Purge is per document, never per batch | A tenant offboarding is an operator-console operation on a whole database, not a sweep over rows | ADR-0013's console |
| No SIEM streaming, no delegation subjects | Out of scope, named by the brief | Phases 17 and 11 |

**The Phase 9 report's limit rows discharged here:** one, and it is the partitioning row — discharged
as a **decision**, not as work. Phase 9 named this phase as its trigger; §4 above records that the
trigger fired, that the reasoning behind the deferral survived it, and states a new trigger with two
conditions rather than one. That is the discharge Phase 9 was owed: an answer, in this report, with
13 §6 updated to carry it. The Phase 9 report itself stands unedited.

Phase 9's **"`ACCESS_DENIED` from `AclGuard` is wired but unreached"** row is explicitly *not*
discharged here, and it is not this phase's to discharge. Its unblocker is "the phase that puts
`@ScopedTo` on object routes" — the ACL phase — and Phase 10 added no `@ScopedTo` and no ACL
entries. `PrismaAclResolver` still resolves tenant-level role grants only; this phase did not add a
fourth call site to it, and none of the routes it adds is object-scoped in that sense.

Every other Phase 9 limit belongs to a later phase and was untouched: the timeline's per-subject
decision, the audit search's absent ACL predicate, SIEM streaming, `ipAddress`/`userAgent` on the
wire, the undelivered chain-broken alert, delegation subjects, and the activity feed screen. This
line is their acknowledgement, not their revision.

## 10. Verification

| Gate | Result |
| --- | --- |
| `pnpm format:check` | Clean |
| `pnpm lint` | Clean across all thirteen tasks |
| `pnpm typecheck` | Clean across all seven packages |
| `pnpm test` | 409 API tests (up from 398 — the schedule arithmetic, the disposition decision and the deletion table), plus 106 domain, 26 contract, 21 web, 11 utils, 4 i18n and 2 worker |
| `pnpm test:integration` | 24 files / 405 tests against real PostgreSQL, two tenant databases (up from 23 / 384) |
| `pnpm build` | Clean, API and web — including the typed `/recycle-bin` route |
| `pnpm prisma:deploy` | Verified against two tenant databases, including the new migration and the post-migrate gate — which raises if a tenant-scoped table has no row-level security policy, and all three new tables carry one |

`soft-delete-retention.integration.spec.ts` carries the phase's own assertions, and each asks
something only a database can answer:

- **A refused delete leaves nothing behind.** No reason, no delete — and the row is untouched
  afterwards, so the refusal is not a partial delete.
- **The reason lands on the row and in the trail's own `reason` column**, not in a payload — which
  is what makes Phase 9's widened digest attest it.
- **A delete takes every revision and gives back every reference**, proved on a document with two
  revisions holding two blobs: both counts reach zero, both revision rows are deleted, and all three
  rows carry one cascade identifier.
- **A soft-deleted document is absent from every list and present in the recycle bin**, with its
  reason and the name of whoever deleted it.
- **A restore returns exactly what its delete took.** A revision discarded *before* the delete comes
  back as a row and its reference does **not** — re-taking a reference nothing holds would make that
  blob permanently un-reclaimable.
- **A folder restore reverses one cascade.** A document deleted on Monday and a folder deleted on
  Tuesday: restoring Tuesday's brings back what Tuesday took and leaves Monday's deleted.
- **An unnumbered draft gets the recycle-bin window and no policy**; a numbered one gets its frozen
  policy's, with review forced true although the policy said false.
- **A purge removes the row and the trail survives with the number in it** — read back from
  `audit_event` after the document is gone, and again from the tombstone, which also holds who
  approved the disposition. This is the assertion the phase turns on, and it proves the trail
  *survives* rather than that nothing threw.
- **The table refuses the deletion even to the owner.** `DELETE FROM audit_event` raises with the
  tenant context set — so `PURGED` could not purge its own evidence by mistake, which is stronger
  than the purge merely not trying.
- **A blob reaching zero is reclaimed and the bytes leave the disk** — `head` on the tenant's real
  storage prefix returns null afterwards, and returns non-null between the delete and the sweep,
  which is what the grace period is for.
- **A legal hold refuses a purge that would otherwise proceed**, with an unheld document beside it
  in the same sweep: both due, both approved, one destroyed and one not. The held schedule is
  `SUSPENDED` rather than skipped, and releasing the last hold resumes it at `PENDING` with the
  approval cleared.
- **Releasing one of two holds resumes nothing.** The second matter still holds the record.
- **A hold with no stated matter is refused by the use case and by the check constraint.**
- **The sweep is idempotent under redelivery**: the second pass purges nothing, writes no second
  tombstone and adds no audit rows to a destruction that happened once.
- **An abandoned upload session expires and its staged object is removed** — the second schedule on
  the lane, declared since Phase 0.5 and consumed for the first time.
- **`DOCUMENT_DELETION_RULES` describes what actually happened.** The suite iterates the table and
  asserts each relation's row count after the purge: everything marked removed is zero, everything
  marked retained is not.
