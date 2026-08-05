# Phase 9 — Audit & Compliance: what was built, what it costs, and what it deliberately does not do

**Status:** point-in-time record of the Audit & Compliance phase. Historical — superseded, never revised.
**Audience:** whoever builds Phase 10 and after, and whoever audits what Phase 9 claimed.

This is the rare phase that inherited its hardest invariant already working. `ChainedAuditWriter`
had bound `AUDIT_WRITER` since Phase 1, taking `pg_advisory_xact_lock(hashtext(tenant))`, reading
the tail, and appending with a gap-free per-tenant `sequence` and a SHA-256 over a canonical
serialisation; `02-audit-immutability.sql` revoked `UPDATE` and `DELETE` from `edms_app` and added a
`BEFORE UPDATE OR DELETE` trigger that raises for *every* role, owner included. Forty-nine action
constants across nine modules wrote through it. None of that was re-litigated.

What was missing was everything that *reads* it. `AUDIT_SERVICE` was declared and bound to nothing —
the module's own docblock said so. `AuditRepository.listForSubject`, `listForActor` and
`listForVerification` had been written in Phase 1 and never called. `AuditActivityReader` was bound
to `ACTIVITY_READER` with no caller. `core/audit/hash-chain.ts` exported a pure, tested
`verifyChain` wired to nothing. There was no `presentation/` directory, no route, no contracts under
`packages/contracts/src/audit/`, and no audit UI. `audit:view` and `audit:export` had been in the
catalogue since Phase 1, seeded to two roles, gating exactly zero routes.

And three things in `13-audit-architecture.md` were untrue of the code. Checkpoints did not exist.
The verification job did not run. Read auditing was synchronous. This phase's job was to build the
read path and to stop the document claiming things the code did not do — in both directions, because
one of the four decisions below changed the document rather than the code.

## 1. The decision the phase turned on: the digest was widened, and versioned

The chain's digest covered nine fields: event id, tenant, instant, actor, action, subject type,
subject id, outcome, payload. It did **not** cover `sequence`, `channel`, `reason`,
`on_behalf_of_id`, `correlation_id`, `ip_address` or `user_agent`.

Three of those are evidence in their own right. A confidentiality level can *require* a stated
reason for access (08 §4) — the trail's `reason` column exists for exactly that — and it was
unattested. A delegation puts a second identity on an act, and Phase 4 deliberately put both on
every decision "before delegation exists, so the trail answers 'who decided' and 'for whom' without
a migration"; `on_behalf_of_id` was unattested. And `sequence` is the entire argument that nothing
was removed from the end — the argument the module README makes at length — and the digest did not
cover it, so a chain could in principle be renumbered without breaking.

An evidence bundle claiming to prove those fields would have claimed more than the chain proved.
That is the one failure mode an evidence bundle may not have.

**The widening is versioned rather than retrospective.** `chain_hash_version` is a column; `2`
covers every column but the hashes themselves; new appends are written under it. Rows written before
this phase keep the digest they were written with, because they *cannot* be rehashed — `audit_event`
refuses `UPDATE` to every role including the owner, and that refusal is the property the whole design
exists for. Backdating would have required suspending it, which is the one operation this product
will not perform on this table for any reason.

So verification dispatches on each row's own version, and an evidence bundle's manifest carries an
`attests` section stating, per version present in its range, exactly which columns that version's
hash covers — with a note on the v1 entry saying in words that the exported reason, delegate,
correlation id, address, agent and sequence are recorded facts and **not** covered by that row's
hash. The columns are still exported: withholding them would make the bundle less useful without
making it more honest.

What it costs: a permanent branch in the verifier, a column on the widest table in the product, and
a bundle that says two different things about two halves of a long trail. The alternative was a
bundle that said one thing and was wrong about half of it.

## 2. Reading, and how a timeline is filtered

This was the phase's named risk. `listForSubject` filters on `tenantId` and `subjectId` and nothing
else; 13 §6 requires the timeline be "filtered to what the caller may see"; and Phase 8 had bound
`ACL_RESOLVER` for real, with `visibilityFilter` designed to be pushed into SQL.

The obvious move — push `visibilityFilter` into the timeline query — is not available, and finding
out why is what settled the design. **An audit row has no scope.** It carries
`(subject_type, subject_id)`, no folder, no library, no chain. There is nothing to push a predicate
against. Worse, Phase 8 made `SEARCH` rows carry the *actor's own user id* as `subject_id` — the
first subject in the product that is not a domain object at all — so a per-row object lookup would
find no such document and would have to guess.

And a per-row lookup would have been wrong where it worked. **Audit outlives its subject** (13 §1):
a purged document's trail remains, deliberately, with its number preserved. A filter that resolved
each row's object would silently hide exactly the history that matters most — the trail of a thing
that no longer exists.

**So the decision is resolved once, at the subject, before the query runs.** A timeline request names
one object; whether the caller may see that object is one question; it goes to `ACL_RESOLVER` — the
same port, the same binding, the same algorithm Phase 8 bound for search. Every row on the page is
about that object, so one decision covers the page exactly. No per-row lookup, no second predicate,
and the third call site of one resolver rather than a second answer to the product's most
security-sensitive question.

The **audit search** is filtered differently, and that is a decision rather than an omission. It
crosses every subject in the tenant, so there is no object to resolve. `audit:view` gates it, and
that grant *is* the filter: 08 §6 gives it to the tenant administrator, the document controller and
the auditor, three roles whose definition is reading the trail. Narrowing an auditor's search by
document ACLs would produce an auditor who cannot audit — the opposite of the row 08 §5 writes for
them. The two surfaces stay separate: `document:history:view` plus reach gets a timeline,
`audit:view` gets the search, and holding one is not holding the other.

## 3. Checkpoints, and the job that writes them

13 §4 promised a daily signed checkpoint "written to a separate store so an attacker with database
access alone cannot rewrite history undetected". There was no table, no key and no store — and a
checkpoint stored in the database it attests would have been ceremony, since the access that rewrote
the trail rewrites its attestation in the same transaction.

There is still no table. The store is **object storage**, keyed `audit/checkpoints/<sequence>.json`
zero-padded to twenty digits so the store's own lexicographic listing is the chronological one, and
`latest()` is a bounded listing rather than a scan. The checkpoint is signed with
`AUDIT_CHECKPOINT_SECRET`, held in the deployment's own secret material — in neither the database
nor the bucket. Production refuses to boot without one, the way it refuses a placeholder storage or
mail driver.

The signature turned out to matter for a second reason, and it is the one worth recording. A
verification pass **resumes from the last checkpoint** rather than walking from genesis. If the
resume point were an unsigned marker, an attacker with database access could move it past the rows
they had rewritten and every subsequent pass would report the chain intact. Because the store
refuses to return a checkpoint whose signature does not recompute, "start from sequence 84,213 with
digest 9c2f…" is an authenticated claim.

**The job runs.** `audit.verify-chain` was in `SCHEDULE` with a cron expression and nothing to fire
it. `QueuePort` gained `schedule`, which upserts a **named** cron schedule in the broker: every
instance that boots declares the same one, so there is one firing rather than one per instance.
That is strictly stronger than the lock around a timer `ScheduledJob.lockKey` anticipated — a lock
stops two processes running the same pass at once; a named schedule means there was only ever one
pass. The firing is tenant-less and fans out one job per tenant from `TENANT_REGISTRY.all()`, since
each tenant has its own database and its own chain.

It consumes in the **API process**, behind `queue.consumersEnabled`. That is the precedent — Phase
4's timers, Phase 7's renderers, Phase 8's index all live there — and the reason it was not departed
from is concrete: `apps/worker` composes none of the domain modules, so running audit verification
there would mean composing them twice or having one flag mean "consume everything" in one process
and "consume one lane" in another.

## 4. Read auditing: the buffer 13 §5 had specified since Phase 0

§5 said `VIEWED` "is buffered and flushed in batches, because it must not cost a transaction per
page view". It was not. Every audited view took `pg_advisory_xact_lock(hashtext(tenant))` inline,
and `audit.readEventsAboveRank` defaults to `0` — so *every* view did. A document everybody reads
throttled every approval, upload and publication in the same organisation behind it.

`READ_AUDIT_BUFFER` is the buffer. A flush takes the lock once, reads the tail once, and chains the
whole batch under it: a hundred views cost one lock, and the chain cannot tell the difference
afterwards. `occurredAt` is captured at `record`, so the trail's ordering is the reading's ordering
rather than the buffer's, and the event id is a UUID v7 minted from that instant for the same reason.

Three rules shape the rest, and all three are 13's rather than choices:

- **Nothing is dropped** (§7). A failed flush retains its batch and retries; past the hard bound
  `record` writes synchronously, which is Phase 1's behaviour — slower, never lossy. Degrading to
  correct-and-slow is the only degradation an audit trail may have.
- **A flush failure raises an alert** (§5). Logged at error with the retained count.
- **A print is not exempt.** §5 exempts `VIEWED` and nothing else; prints are rare and deliberate,
  and a print is the act a confidentiality level most wants a hard record of. `DOCUMENT_PRINTED`
  stays synchronous and transactional.

The cost is stated in the configuration rather than hidden: `AUDIT_READ_BUFFER_MAX` is how much
evidence a process may hold un-durable, and the honest way to read it is "how much would a crash
lose" — at the default, a thousand views.

## 5. The export

13 §6's signed bundle exists, and the one shape decision worth recording is that it is **a prefix of
objects rather than one archive**. `events.jsonl`, `events.csv`, `manifest.json` and `manifest.sig`
under `evidence/<exportId>/`, with the manifest as the entry point and one signed URL per artefact.

A single downloadable file would have meant a ZIP, and a ZIP meant either a compression dependency
and a second assembly pass — precisely the in-memory hold the `audit.export` lane's own description
forbids — or hand-rolling a stored-entry archive writer, which is a format implementation nobody
asked for. The auditor gets four links instead of one; the product does not gain an archive format
to maintain.

**`StorageService.storeDerived` takes a `Buffer`**, which is correct for a thumbnail and contradicts
that lane's description for a bundle. So Storage gained a streaming write, deliberately and in the
module that owns bytes: `StoragePort.put` takes an `AsyncIterable<Uint8Array>`, the filesystem
adapter pipes to a `.partial` and renames, and the S3 adapter drives a multipart upload itself a
part at a time — bounded at `STORAGE_STREAM_PART_BYTES` whatever the artefact's size. `read` and
`list` came with it, for the checkpoint store. All three are scoped by `TenantScopedStorage`,
including the listing *prefix*, which is the one call in that port where an absent argument would
otherwise mean "the whole bucket".

The export is audited three times, for three facts: `AUDIT_EXPORTED` when it is requested (before
anything is produced — the `FILE_DOWNLOAD_ISSUED` reasoning one level up), `AUDIT_EXPORTED` again
with the outcome, and `BULK_DOWNLOAD` every time the links are issued, because producing evidence
and carrying it away are different acts and the second can happen repeatedly by whoever holds the
link. The artefacts are stored as `file_object` rows, so each issuance also writes Storage's own
`FILE_DOWNLOAD_ISSUED` through the path that already exists rather than a second signing path
beside it.

One subtlety the integration suite pinned down: **the chain is verified over the whole range the
batches cover, then the rows are filtered.** Verifying only the exported rows would verify a
subsequence, and a subsequence of a chain never chains — the links between the excluded rows are
missing by construction.

## 6. The catalogue, reconciled

13 §2's table had never absorbed the per-phase addenda that follow it, so the one table a compliance
report reads did not name most of the actions the product writes. Phases 3, 4, 5, 6 and 8's rows are
now in it, and the addenda remain because they carry the reasoning for each split.

Two naming drifts were resolved **in favour of the code**: `SIGNED_URL_ISSUED` is
`FILE_DOWNLOAD_ISSUED` and `SCAN_INFECTED` is `FILE_SCANNED`. Phase 3 wrote both under those names,
so a filter written from the document would have matched nothing — and the code's names are the
better ones anyway: a URL is issued for a *file*, and a scan is recorded whatever its verdict, which
`SCAN_INFECTED` could not express for the clean scans that are most of them.

`ACCESS_DENIED` finally has a writer. 08 §7 has required it since Phase 1 and `writeStandalone` was
written for exactly this caller; nothing in `core/authorization/` had ever called it.
`AccessDenialRecorder` is one recorder with two call sites — `AclGuard` and the audit timeline's own
refusal — because a refusal recorded differently in two places is a compliance report that has to
know which path denied it. §7's "on an *existing* object" condition cannot arise today, since
`PrismaAclResolver` decides from role grants without consulting the object (08 §9), so a refusal
carries no information about whether the identifier names anything; the condition is documented in
the recorder, which is where it will matter when the walk arrives.

`AuditSubjectType` gained **`EXPORT`**. A bundle is not a `DOCUMENT`: filing `AUDIT_EXPORTED` under
the document type would have put the row in the timeline of whichever document happened to be first
in the range.

And the rows that are *not* this phase's are now attributed in the document rather than left as
unowned gaps — the Permission-ACL group to the phase that builds grants, Delegation to 11, Retention
and `PURGED` to 10, `REPORT_EXPORTED` to 15, the MFA and session rows to 14.

## 7. Volume

13 §6 specifies 7 years, monthly range partitions and cold storage after 12 months. `audit_event` is
a plain table.

This phase adds **`ix_audit_action` on `(tenant_id, action, occurred_at DESC)`** — §6's audit search
filters by action first, "every `ACCESS_DENIED` last quarter" is the question it exists to answer,
and without the index that is a sequential scan of the whole trail.

It does **not** partition, and that is a decision rather than an oversight. Converting `audit_event`
to a partitioned table is a rewrite of the one table that may not be rewritten while the application
writes to it; the retention that would detach and drop a month is Phase 10's; and the immutability
trigger already leaves DDL uncovered precisely so a detach will work when it arrives — the design
anticipated this. Building the mechanism now would mean building it a month before anything could
use it, against a table whose size no deployment has yet. The trigger is Phase 10, or the first
tenant past tens of millions of rows, whichever comes first.

## 8. What was built

| Area | What |
| --- | --- |
| Chain | `chain_hash_version`; a v2 digest over every column but the hashes; `attestedFields`; a verifier that dispatches per row and reports `DIGEST_MISMATCH`, `LINK_MISMATCH` or `SEQUENCE_GAP` separately |
| Reading | `AuditReadService` — the subject-resolved timeline and the `audit:view` search; `distinctActions` for the filter list; `AUDIT_SERVICE` bound at last, through a facade over three services |
| Verification | `AuditVerificationService`: resume from a signed checkpoint, walk by keyset in batches, bounded per pass, checkpoint where it stopped, publish `audit.chain-verified` / `audit.chain-broken` |
| Checkpoints | `AUDIT_CHECKPOINT_STORE` + `StorageCheckpointStore` — HMAC-SHA256, object storage, refused when the signature does not recompute |
| Read auditing | `READ_AUDIT_BUFFER` + `BufferedReadAuditWriter`: chained batch flush, per-tenant, retry-on-failure, synchronous fallback, flush on shutdown |
| Export | `AuditExportService`, `audit_export`, streamed JSONL + CSV, signed manifest with its `attests` section, signed download URLs, three audit rows |
| Storage | `StoragePort.put` / `read` / `list`; streaming writes in both adapters; `evidenceKeyFor`; all three scoped by `TenantScopedStorage` |
| Queue | `QueuePort.schedule` / `unschedule`; `AuditLaneConsumer` draining `audit.export` and declaring `audit.verify-chain` |
| Authorization | `AccessDenialRecorder` — 08 §7's `ACCESS_DENIED`, one recorder, two call sites |
| Contracts | `packages/contracts/src/audit/` — entries carrying `chainHashVersion`, the structured search query, the export shapes |
| Web | The document timeline as a **suspended** server component; `/audit` gated on `audit:view` with its navigation row; en and ar |
| Docs | 13 §2 reconciled and a Phase 9 section; 08 §10; the audit and storage module READMEs |

## 9. What it costs

| Cost | Detail | Mitigation |
| --- | --- | --- |
| **Two digests, forever** | The verifier branches on a per-row version, and a long trail's manifest describes two attestation levels | The alternative was rehashing a table that refuses `UPDATE` by design. The branch is ten lines and one golden test pins the v1 material byte-for-byte |
| **A crash loses the buffer** | Up to `AUDIT_READ_BUFFER_MAX` view events are held un-durable | Bounded and configurable; the shutdown hook flushes; the fallback past the bound is a synchronous write. §5 chose this trade, and the alternative was the lock contention it chose it over |
| **A view is no longer atomic with its "recent" row** | `open()` writes the recent entry in a transaction and buffers the audit event outside it | A read is not a change; there is nothing an event whose content is "somebody looked" must commit *with* |
| **The export holds its rows** | `collect` reads the range in batches but keeps the rows so both artefacts describe the same set | Two independent passes would risk a CSV and a JSONL that disagree. The *artefacts* stream; the row set does not, and the range is the requester's choice |
| **One lane, two workloads** | A 15-minute export and a nightly verification share `audit.export` at concurrency 2 | They differ in cost, which is the argument for separate lanes; two lanes at concurrency 1 each is the same capacity with more configuration. If an export ever delays a night's verification, the fix is a lane |
| **`ix_audit_action` on every insert** | A fourth index on the product's highest-volume table | §6's search is unusable without it. It is the one index this phase adds |
| **`audit.chain-broken` has no delivery** | Published to the outbox, routed nowhere | The Phase 4 position, again: the row is the record until a consumer exists. A break is *also* logged at error, because a compliance failure that waits for Phase 12 is one nobody hears |
| **A bundle is four objects, not one file** | The auditor opens four links | A ZIP costs a dependency and an in-memory assembly the lane forbids |

## 10. Deliberate limits

| Limit | Why | Unblocked by |
| --- | --- | --- |
| No monthly partitions, no cold-storage tiering | §7 above: a rewrite of the one table that may not be rewritten, for a size no deployment has, a month before retention could detach anything | Phase 10, or the first tenant past tens of millions of rows |
| `ACCESS_DENIED` from `AclGuard` is wired but unreached | `@ScopedTo` is applied to no route yet — the ACL phase's work. The timeline's own refusal is the live call site, and it is exercised in the integration suite | The phase that puts `@ScopedTo` on object routes |
| The timeline's decision is per subject, not per row | The row model has no scope, and audit outlives its subject | Nothing — a per-row filter would be wrong, not merely absent |
| The audit search applies no ACL predicate | `audit:view` is the trail-wide grant and *is* the filter (§2 above) | Nothing. The library manager's scoped `S` arrives with ACL entries |
| No SIEM streaming | 13 §6's optional per-tenant sink is an integration, named for Phase 17 | Phase 17 |
| `ipAddress` and `userAgent` are not on the timeline wire | They are in the trail and in an export, where an investigation reads them; publishing one colleague's address to another on a record page answers no question either is asking | A surface with a reason to show them |
| The chain-broken alert is not delivered | Notifications are Phase 12's | Phase 12 |
| Delegation subjects are still empty | `AuthorizationSubject.delegationIds` and `on_behalf_of_id` leave the room; Phase 11 fills them. The widened digest already covers `on_behalf_of_id`, so nothing re-hashes when it does | Phase 11 |
| No activity feed screen | `ACTIVITY_READER` is still bound with no caller. The dashboard is Phase 13's, and an activity feed with no dashboard to sit on is a screen nobody opens | Phase 13 |
| Soft delete, retention execution, legal hold, notifications, dashboards, reporting, MFA | Out of scope, named by the brief | Phases 10, 12, 13, 14, 15 |

**The Phase 8 report's limit rows discharged here:** none. Phase 8 left eight limits and every one
of them belongs to a phase after this: ACL entries and the walk, shareable saved searches,
did-you-mean, tag search, OpenSearch, delegation subjects, the TIFF-to-OCR gap in Preview, and
retention. This phase touched none of them, and that report stands unedited — this line is its
acknowledgement, not its revision. Phase 8's "delegation subjects are always empty" is *narrowed*
rather than discharged: the digest now covers `on_behalf_of_id`, so Phase 11 fills a field that is
already attested rather than one that is not.

## 11. Verification

| Gate | Result |
| --- | --- |
| `pnpm format:check` | Clean |
| `pnpm lint` | Clean across all thirteen tasks |
| `pnpm typecheck` | Clean across all seven packages |
| `pnpm test` | 398 API tests (up from 389 — the widened digest and its golden v1 material, the bundle's quoting, manifest signature and attestation, the streaming digest), plus the domain, contract and web suites |
| `pnpm test:integration` | 23 files / 384 tests against real PostgreSQL, two tenant databases |
| `pnpm build` | Clean, API and web — including the typed `/audit` route |
| `pnpm prisma:deploy` | Verified against two tenant databases, including the new migration and the post-migrate gate |

`audit-compliance.integration.spec.ts` carries the phase's own assertions, and each asks something
only a database can answer:

- **A chain the real writer appended verifies**, and the checkpoint written for it is a file in the
  tenant's own storage prefix — read back from disk — not a row anywhere.
- **The next pass resumes from that checkpoint**: `fromSequence` is the previous `toSequence`, and
  one new event is verified rather than the whole trail.
- **A forged checkpoint is refused.** The authentic one carrying a different sequence, and one
  carrying a different digest, both fail `isAuthentic`; the untouched one passes.
- **The table refuses the tamper.** `UPDATE` and `DELETE` raise for the owner role with the tenant
  context set — so a "tamper then detect" test is impossible by construction, which is the strongest
  result available. Detection is therefore proved against records altered *after* they were read
  back: the digests, the links and the verifier are all the real ones, and only the tampering the
  database refuses is simulated.
- **An altered `reason` is caught**, which is precisely what the widened digest bought and what the
  Phase 1 digest would have passed.
- **A gap in `sequence` is caught** — and the same test shows why it is needed: a chain truncated
  from the end still verifies perfectly, and only the contiguity claim, anchored by a signed
  checkpoint, makes the hole visible.
- **The chain holds under twelve concurrent writers on one tenant**, verified rather than merely
  contiguous.
- **A chain spanning both digest versions verifies**, which is what every upgraded deployment holds.
- **The timeline refuses a caller whose roles hold nothing, and records the refusal** — an
  `ACCESS_DENIED` row with `DENIED` and the right subject, written through the recorder the guard
  uses. An auditor holding `audit:view` is answered without the object question being asked at all,
  and a `SEARCH` subject — which has no scope — is refused to anyone without that grant.
- **Buffered views land chained and contiguous**: nothing is durable before the flush, the pending
  count is exact, and after it the whole trail — buffered and synchronous rows interleaved —
  verifies as one chain. The recorded instant is the read's, not the flush's.
- **A bundle's manifest digests match the bytes on disk.** Every artefact is read from the tenant's
  storage prefix, its length and SHA-256 compared with what the record claims; the manifest's
  signature verifies against the deployment key and the manifest's own artefact digests agree with
  those bytes; the JSONL line count equals the claimed event count; and the `attests` section is
  present rather than implied.
- **The export is idempotent under redelivery**: a second run finds the row claimed and produces no
  second bundle with different digests under the same identifier.
- **Filters narrow the bundle** to one action, while `chainIntact` still reflects verification over
  the *whole* range — because a subsequence of a chain never chains.
