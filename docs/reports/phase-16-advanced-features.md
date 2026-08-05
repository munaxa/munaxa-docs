# Phase 16 — Advanced Document Features: what was built, what it costs, and what it deliberately does not do

**Status:** point-in-time record of the Advanced Features phase. Historical — superseded, never revised.
**Audience:** whoever builds Phase 17 and after, and whoever audits what Phase 16 claimed.

The brief lists twelve items. **They are not twelve features, and sorting them was the first real
decision of the phase**, because a plan that treated them as twelve equal pieces of work would have
spent most of its effort on the eight that were already built.

| Group | Items | What the work actually was |
| --- | --- | --- |
| **Already built** | OCR, Watermarks, Thumbnail Generation, Document Compare, Storage Optimization | Discharging four named limit rows from Phase 7 and one question about Phase 10's reaper — mostly by proving what is and is not reachable, and closing the one part that was |
| **Genuinely new** | Document Templates, Digital Signatures | Two tables, an ADR, a permission each, and one word that means four different things |
| **Bulk** | Bulk Upload, Bulk Metadata, Bulk Approval, Bulk Restore, Bulk Export | Five operations over one primitive, and the phase's centre of gravity |

Phases 3, 6 and 7 built the first group. Phase 12 built the storm control that had nothing to
control, Phase 14 built the reach predicate the third group must not undo, and Phase 15 built the
export mechanism the third group had to argue with. Almost nothing in this phase is new machinery;
almost all of it is a decision about how the machinery that exists composes.

---

## 1. The named risk: every bulk operation is a permission decision repeated N times

Phase 14 put the reach predicate inside `PrismaDocumentRepository.whereFor`. Phase 15 built ten
reports on top of it and spent its report explaining why a report must never widen the audience of
the surface it summarises. And the tempting bulk implementation — the one that is quicker to write,
quicker to run, and passes any test that counts rows — resolves the caller's reach **once** and then
applies the answer to a list of identifiers the client supplied.

That is fetch-then-filter wearing a new hat, and it is worse than the original, because it *writes*.
A bulk approve would decide a task the caller could not decide singly. A bulk restore would
resurrect a document they cannot see. A bulk metadata edit would write to a row outside their reach.
All three through one permission check that passed.

**So the executor resolves reach per object, immediately before writing that object, in the
transaction that writes it.** Not before the loop; not once per request. The same `ACL_RESOLVER` that
answers `AclGuard` on the single-object routes, called N times.

The integration suite asserts it in the only way that can distinguish the two implementations: two
callers send the **same identifier list**, and get different sets of `APPLIED` rows back.

```
Ada  → applied 5, refused 0
Ben  → applied 3, refused 2   (the two in the folder he is denied on, named individually)
```

A resolve-once implementation gives both of them five.

### Why a bulk route cannot carry `@ScopedTo`, and what replaced it

`@ScopedTo('id', ScopeType.DOCUMENT)` binds **one** route parameter to **one** object so `AclGuard`
can resolve its chain before the use case runs. A bulk route has N objects in its body and no route
parameter at all, so the decorator cannot express what it needs to — and `AclGuard` reads
`request.params`, so a decorator naming a body field would silently resolve `undefined` and refuse
every request, which is a worse failure than not having one.

The check is not left out. It moved *inward*, which is strictly stronger: the guard resolves once
before the use case, and the executor resolves immediately before each write, so an administrator
revoking an entry mid-batch stops the objects after it rather than racing the ones in flight.
`@RequirePermission` is still on every bulk route, so `RoutePermissionRegistry` still fails the boot
on a gap — it is the tenant-wide floor, exactly as it is everywhere else.

### One transaction per object, which is the difference between partial success and a silent skip

A single transaction for the batch means one legal-held document rolls back the other three hundred
and ninety-nine, and the caller is told nothing about which one. A transaction each means the hold
refuses its own document, the rest commit, and the record names it — and the per-object audit rows
commit with their own changes, which keeps 13's "audit commits with its change" true *inside* a bulk
operation rather than only outside one.

The outcome vocabulary is four values rather than a boolean, because "it did not happen" has three
distinct causes that call for entirely different responses:

| Outcome | Means | What somebody should do |
| --- | --- | --- |
| `APPLIED` | It happened | — |
| `REFUSED` | The caller does not reach this object | Nothing; they selected across a boundary they cannot see, and the product behaved correctly |
| `BLOCKED` | Reachable, and a rule said no — a legal hold, a version conflict, an illegal transition | Look at the rule; a matter may be on hold |
| `FAILED` | Something broke | This is an incident |

"42 of 50 succeeded" makes all three look the same. That is why no bulk endpoint answers `204`.

---

## 2. Digital signatures: the word means four things, and choosing was the work

"Digital Signatures" is one line in the brief and appears nowhere else in the architecture — no
table, no port, no ADR, no section in 03, 06 or 17, and no action in 13 §2. Every other capability in
the phase had somewhere to look.

[ADR-0017](../architecture/adr/0017-electronic-signature-as-witnessed-attestation.md) argues four
readings before choosing:

1. **An approval record.** Phase 4 already is this, completely. A second would give the product two
   answers to "who approved this".
2. **A cryptographic signature over the bytes.** Phase 9's `signManifest` and the checkpoint store
   are the existing precedent, and they work.
3. **A drawn image on a rendition.** What most document systems mean, and the weakest of the four:
   an image is copyable and proves nothing about who applied it.
4. **A qualified eIDAS signature.** A certificate from a trust-service provider and a key under the
   signer's sole control.

**The decision is reading 2 in service of 21 CFR Part 11 subpart C**, which is what the regulated
customers this product is for actually need: §11.50's manifestation (printed name, date and time,
and the **meaning** of the signature), §11.70's signature/record linking, and §11.200's two
identification components.

So `document_signature` holds the signer, the purpose, the instant, **the exact statement that was
signed**, and the server's HMAC over it. The statement is a canonical, versioned, field-ordered
serialisation in `@edms/domain` carrying the tenant (a digest is not unique across tenants), the
revision **and its content SHA-256** (§11.70's link), and the signer's printed name and email *as
they stood at that instant* (§11.50, and because a person who marries next year must not
retroactively change what the record says was signed).

Reading 4 is refused, and **not because the lockfile cannot gain a signing library**. It is refused
because a product holding its users' private keys would not be producing qualified signatures
anyway. The consequence is stated rather than buried: the witness is the *server's*, so somebody
with the witness key and write access to the database could forge a signature and no verification
here would detect it. That is genuinely weaker than reading 4, which is why nothing in this product
may call the result a qualified or digital signature — the wire contract names the *witness* rather
than a certificate subject and has no field for one, and the interface says "signed".

Three decisions worth naming beyond the ADR:

- **`document:sign` is seeded to no role, including the tenant administrator.** 08 §6's first
  deliberate row excludes approval from the tenant administrator because approval is a `T`. A
  signature is an `S` — an ACL entry on the node somebody is accountable for grants it — and a
  signatory conferred by seniority is the failure mode an electronic-signature regime exists to
  prevent. A fresh tenant therefore has no signatory until somebody chooses one, which is correct
  and will look like an omission to whoever meets it first.
- **Verification answers three booleans, not one.** `signatureValid` (the witness still verifies),
  `contentMatches` (the revision's file still has the digest that was signed — a §11.70 finding
  rather than a broken signature) and `withdrawn`. One `valid` flag would collapse "somebody edited
  the database" and "somebody withdrew their approval".
- **A withdrawal is the row's own columns, dated and attributed.** Not a delete, and not a flag
  alone: "this signature was later withdrawn, by whom, why and when" is the question an inspection
  asks. Only the signer may withdraw their own — an administrator retracting somebody's personal
  attestation on their behalf is a different fact this product has no honest way to record.

**13 §2 gained `DOCUMENT_SIGNED`, and the addition is argued rather than assumed.** The alternative
was to overload `APPROVED`, which would make *"which approvals were signed"* — the one question the
whole capability exists to answer — unanswerable.

---

## 3. The decisions the specification left open

### Where does a bulk operation live, given a module may not call another sideways?

A `bulk` module would be the worst available answer: a module that *every* other module calls
sideways, holding four modules' rules about what may be restored, approved and edited. That is the
coupling `modules/README.md` exists to prevent, and it is what a "BulkService" becomes by its second
release.

The shape taken is `AdministeredWriter`'s: **a choreography in `core/` that owns no rules.** What
repeats across all five operations is the transaction per object, the reach decision, the outcome,
the tally and the operation row. What each operation *does* stays in the module that owns the
rows — a bulk restore is `DefaultDocumentService.restore` called N times, and a bulk approval is
`WorkflowEngine.decide` called N times, so every rule those enforce still runs and each writes its
own audit event exactly as the single-object path does.

The cost of that choice is explicit: the fast implementation of a bulk metadata edit is one
`UPDATE … WHERE id IN (…)`, one to two orders of magnitude quicker, and it skips six correctness
properties — the reach check per object, the frozen-status check, the optimistic lock, the
per-document audit row, the outbox event and the search re-projection.

### One audit row per object, or one per operation?

**Both**, and the reasoning is symmetric.

The per-object rows are the single-object use cases' own — the executor writes none of them. Dropping
them would make a document's own timeline skip the day it was edited, and the document timeline is
the trail's primary query. Writing *only* them would leave "who ran the bulk edit that touched four
hundred documents" unanswerable, because four hundred rows by one actor in ninety seconds is not the
same fact as one act over four hundred documents.

So an operation over N objects writes **N + 1** rows, and the report says so rather than hiding it.
The operation row carries counts and **never the identifier list** — 13 §3's minimised payload, and
five thousand UUIDs in one `jsonb` would be a second copy of the operation with no retention policy.
Which objects were touched is `bulk_operation_item`, which is a table, indexed and pageable. The
suite asserts both halves: 26 rows for 25 objects, and the operation payload not containing any
document identifier.

`BULK_OPERATION` is one action for five kinds with the kind in the payload, following 13 §2's
"one action per area" convention. Five actions would put `BULK_RESTORED` beside `RESTORED` in a
filter and give "every restore last quarter" two right answers.

### Bulk export: reuse, generalise or diverge?

Phase 9 built `audit.export` and the evidence bundle; Phase 15 built `reporting.export`, a
`report_export` record with an idempotent claim, an audited run and `StreamDigest`. A third export
mechanism would be the third, so the choice has to be stated.

**It diverges in mechanism and reuses the shape**, for the reason the brief names: a bulk document
export moves *bytes* rather than rows. The other two read a table and write a file; there is nothing
to read here — every document already *is* a file, content-addressed since ADR-0007, sitting in
storage with a digest. Generalising `report_export` to cover it would mean teaching a row-streaming
lane to move blobs, which is not a generalisation: it is a second mechanism with the first's name.

What it produces is **a manifest and a signed link per document**, exactly as Phase 9's bundle
produces three artefacts and three links rather than one ZIP. That is the better answer here rather
than a limitation worked around:

- **Compliance.** Every byte still leaves through `createDownloadUrl`, so every document released
  writes its own `FILE_DOWNLOAD_ISSUED`. A ZIP would produce **one** audit row for five hundred
  documents leaving the building, and "which of these did they actually take" would be unanswerable.
- **Storage.** An archive copies every document's bytes into a second object, leaving N extra copies
  for the length of the reaper's grace period — undoing, in the same phase, the storage optimisation
  the brief asked about.

The honest cost: a caller wanting one file to hand to somebody does not get one. The manifest names
each document's number, revision, digest and size, so a recipient can prove what they received —
which is a better *evidentiary* artefact than an archive — but it is not a ZIP, and a client that
wants one assembles it from the links.

The links are a **second request**, minted against the caller's reach *now*. An export is the record
of a release having been decided; a link is the release happening. Durable links issued at export
time would let somebody whose access was revoked an hour later still take the content.

### Which of the five notify, and coalesced how?

Phase 12 built `notification_batch` and its own report stated plainly that **nothing then produced a
storm** — `retention.due` was the only coalesced family, and its window is a *day* rather than an
operation. Phase 16 is the first thing 18 §7's row was actually written for.

**Every bulk operation notifies, through one family, coalesced on the requester.** The window key is
`bulk:{requesterId}` rather than the operation, so six imports in a morning are one message — which
is what coalescing is for — and an operation split across several requests by an operator is one
arrival.

**The recipient is the requester alone**, and that is the decision to argue. The obvious alternative
is to tell whoever would have been told about each object, and it is wrong twice. It is a disclosure
risk: 18 §8 and Phase 12's `RecipientVisibilityService` require every name in a recipient list
derived from documents to pass the ACL resolver, and a *summary* cannot satisfy that — "412
documents were restored" describes a set the recipient may only partly reach, and there is no honest
per-recipient count without resolving 412 times per recipient. And it is noise: those people already
receive the per-object notifications their own documents produce.

The per-object events are unchanged and still flow to their existing consumers — a bulk restore
publishes four hundred `document.restored` events from inside each document's transaction, and the
search index re-projects each one exactly as it always has.

### Was `sharp` reachable? Was `@pdf-lib/fontkit`? Answered with commands.

The brief asked for a command rather than an assumption. Here are the commands and their answers.

```
$ node -e "require.resolve('sharp')"          # from apps/api
Error: Cannot find module 'sharp'
$ ls node_modules/.pnpm | grep '^sharp@'
sharp@0.34.5                                  # in the store, linked into no workspace package
$ node -e "require.resolve('@pdf-lib/fontkit')"
Error: Cannot find module '@pdf-lib/fontkit'
$ ls node_modules/.pnpm | grep '^@pdf-lib'
@pdf-lib+standard-fonts@1.0.0
@pdf-lib+upng@1.0.1                           # fontkit is absent from the store entirely
$ node -e "require.resolve('pdfjs-dist/package.json')"
/home/user/munaxa-docs/node_modules/.pnpm/pdfjs-dist@4.10.38/…   # reachable
```

`sharp@0.34.5` is in the lockfile as a transitive dependency of Next.js, is a direct dependency of
nothing, and is linked into no workspace package's `node_modules` — pnpm's isolation is doing exactly
what it is for. Reaching it means adding it to `apps/api/package.json`, which means a lockfile
change, which CI's `--frozen-lockfile` refuses. **Not reachable.** `@pdf-lib/fontkit` is not present
at any level. `pdfjs-dist` is reachable and is not a way around either problem: it parses PDFs
perfectly well and has nothing to draw onto.

So three of Phase 7's four rows stay closed, and the report below names what would open them.

### What was left of Storage Optimization?

Less than the name suggests, and the honest answer is worth stating plainly: **ADR-0007 content-
addresses and deduplicates, Phase 10's reaper reclaims at `ref_count = 0` past a grace period, and
Phase 15 found and fixed `storeStreamed` not deduplicating.** There was no dedupe gap to close.

What this phase contributes is that its two new bulk-adjacent write paths *inherit* it rather than
adding a third:

- A bulk import of five thousand scanned forms stores each distinct blob once, because it goes
  through Phase 3's ordinary upload path. Nothing here does anything to obtain that.
- A thousand documents created from one template are **one blob with a thousand and one
  references**, because a template's body is a reference rather than a copy. That is the clearest
  instance in the phase of a capability being obtained by *not* writing a code path.
- A bulk export copies nothing, for the reason above.

Quota remains ADR-0012's and Phase 21's, and Phases 10, 13 and 15 have each recorded that storage
reports bytes and never a quota. That stays true; this phase adds no quota column to any of its four
tables.

### 19 §5's fairness claim was false, and now is not

That section has said since Phase 0 that "per-tenant concurrency caps stop one large tenant's bulk
import from monopolising a pool". `QueueDefinition.concurrency` is per **lane**, so one tenant's five
thousand jobs take every slot and everybody else waits. Jobs have carried their tenant id since
Phase 4 and nothing read it. Nothing had ever produced five thousand jobs, so the claim was true of
a deployment nobody had.

`QueueDefinition.perTenantConcurrency` is now declared per lane and **absent by default**, so every
existing lane behaves byte-for-byte as it did. `documents.bulk` declares 2 against a lane concurrency
of 4. Enforcement is a Redis counter taken before the handler and released after, with an expiry
longer than the lane's wall-clock budget so a killed process cannot strand a tenant; a job over the
cap is **re-queued with a short delay rather than failed**, because "wait your turn" is not a failure
and must not consume a retry attempt.

What makes that lane the one to cap is what it contends on: a bulk operation is N transactions, each
writing an audit row onto a chain that serialises **per tenant** under an advisory lock. The
expensive resource is one tenant's own chain, and a second tenant's bulk restore does not contend
with it at all — which is exactly the shape a per-lane number cannot express.

### Does anything make `ARCHIVED`, `REINSTATED` or `LINKED` writable?

**No, and the row stays.** 13 §2 assigns them to "the phase that builds each capability", and this
phase built none of them: archiving and reinstatement are lifecycle transitions 06 defines and
nothing performs — `document:archive` is in the catalogue and no route declares it — and a document
*link* is a relationship with no table. A bulk restore reverses a *delete* and writes
`DOCUMENT_CHANGED` with `operation: RESTORED`, which is Phase 10's row and a different act from
reinstating an archived record. A document created from a template is `CREATED`.

---

## 4. What was found by building this phase

**`DocumentService.exists` was declared in Phase 0.5 and never implemented.** `DOCUMENT_SERVICE`'s
interface names it; `DefaultDocumentService` did not have it. Nest's `useClass` does not
structurally check a provider against its token, so it was never reachable and never failed — it
surfaced only when a Phase 16 collaborator was typed against the port. It is implemented now, and
`DOCUMENT_SERVICE` is bound with `useExisting` over a direct provider so the class is a resolvable
token, which is what three of this phase's services needed.

**`@ScopedTo` cannot bind a body field, and the failure would have been silent.** `AclGuard` reads
`request.params`; a decorator naming `folderId` on a `POST` with a body would resolve `undefined` and
throw `NotFoundError` on every request. It was written that way first, and removing it is why the
bulk-upload route resolves the folder's reach through the executor like everything else.

---

## 5. What was built

| Area | Added |
| --- | --- |
| Domain | `bulk.ts` (kinds, states, four outcomes, the tally invariant, `normaliseTargets`, the size verdict) and `signature.ts` (purposes, the canonical statement, `revisionIsSignable`), both pure and both specified |
| Permissions | `document:sign` and `template:manage`; the first seeded to no role at all, the second to the document controller |
| Settings | `bulk.maxObjects`, `bulk.synchronousLimit`, `bulk.tenantConcurrency`, `signature.requireReauthentication`, and four feature flags read at the use case rather than at the button |
| Queues | `documents.bulk`, the first lane in the product to declare `perTenantConcurrency`, enforced in the BullMQ adapter |
| Schema | `document_template`, `document_signature`, `bulk_operation`, `bulk_operation_item`, four enums, and `BULK_OPERATION` on `audit_subject_type` — all four tables carrying `tenant_id`, so the post-migration SQL discovers and forces RLS on them |
| Core | `core/bulk/` — the executor, the record, the repository and one audit action; a choreography that owns no rules |
| Document | Bulk metadata, restore, upload and export; templates with create-from; signatures with re-authentication, withdrawal and three-answer verification |
| Workflow | Bulk approval, and `documentOfTask` on the query repository so reach resolves at the document |
| Preview | `pdf-images.ts` — lifting `/DCTDecode` page images out of a scanned PDF so it can be OCR-read, with no decoding and no dependency |
| Notification | The `bulk.operation-completed` type, EN and AR templates, and the second coalesced family in the product |
| Web | Opt-in selection and a capability-gated bulk bar on `ResourceList`, the folder browser's bulk actions, and a per-object result dialogue |
| Contracts | `documents/bulk.ts`, `documents/template.ts`, `documents/signature.ts` |
| Docs | ADR-0017; 13 §2, 15 §1, 16 §2/§5, 18 §7 and 19 §5/§7 updated |

---

## 6. What it costs

| Cost | Figure | Why it is accepted |
| --- | --- | --- |
| A bulk operation is N transactions | Measured: 25 objects → 26 audit rows, chain intact and gap-free | One transaction for the batch cannot express partial success, which is the whole capability |
| N + 1 audit rows per operation | Linear in the batch | Suppressing the per-object rows breaks the document timeline; writing only them loses the act |
| Reach resolved N times | One resolver call per object, cached per request by the resolver's own cache in production | The alternative is the defect the phase exists to prevent |
| A bulk request is bounded | 5 000 objects per request, 50 before it must be queued | Both are tenant settings; the numbers are 19 §5's own example rather than fresh opinions |
| `document:sign` reaches nobody by default | A fresh tenant has no signatory | Deliberate; a signatory conferred by seniority is what Part 11 exists to prevent |
| A bulk export produces no archive | The deliverable is a manifest plus per-document links | A ZIP would cost one audit row for five hundred releases and N copies of every byte |

---

## 7. Deliberate limits

| Limit | Why | Unblocked by |
| --- | --- | --- |
| **No server-side rasteriser, still** | `sharp` is in the store and linked into no workspace package; reaching it is a lockfile change CI's `--frozen-lockfile` refuses. `pdfjs-dist` parses and has no canvas | A deployment-packaging decision — Phase 18's, which is where system packages and native bindings get pinned |
| **`/CCITTFaxDecode` and `/JPXDecode` scans are not OCR-read** | Their streams are raw samples needing a codec and a container written around them — the hand-written-decoder trade Phase 3 refused for JPEG thumbnails | The same rasteriser, or an OCR engine that ingests PDFs |
| **Non-PNG thumbnails still absent** | Unchanged: the Phase 3 trade stands | The same rasteriser |
| **Watermark text is still WinAnsi** | `@pdf-lib/fontkit` is absent from the store entirely, not merely unlinked | The same lockfile change, plus a vendored Noto subset |
| **The queued bulk path ships the lane and the record, not a consumer** | `bulk.synchronousLimit` and `documents.bulk` exist, and every bulk operation currently runs in its request. Shipping a consumer with no producer is the fifth declared-but-unbound contract this product has had to discharge | The phase that needs an import larger than a request can hold; the seam is the lane, the record and the per-tenant cap, all built |
| **Bulk delete is not one of the five** | Phase 10 made a delete state a reason, and one reason for four hundred records is a reason for none of them | A design that captures a reason per object, which is not a bulk operation |
| **Bulk approval cannot reject** | A rejection must say why, and one sentence for forty documents is the field an auditor reads | Nothing; this is the answer rather than a gap |
| **Bulk metadata cannot change confidentiality** | That change demands an `If-Match`, and a bulk request cannot carry N versions | Nothing; the single-object path is one click away |
| **Signatures are witnessed by the server, not by the signer** | ADR-0017 §Consequences: this product must not hold users' signing keys | Becoming party to a trust framework — a product decision that supersedes ADR-0017 rather than editing it |
| **`ARCHIVED`, `REINSTATED`, `LINKED` still have no writer** | This phase built none of those capabilities | The phase that builds each |
| **Quota accounting still does not exist** | ADR-0012's and Phase 21's | Phase 21 |
| **Webhooks, SIEM, API integration; production readiness and the integrity sweep** | Out of scope, named by the brief | Phases 17 and 18 |

---

## 8. Limit rows discharged from earlier reports

Earlier reports are historical and stand unedited; these lines are their discharge.

**Phase 7's four rows are this phase's**, and the honest tally is one closed, one partly closed, two
open.

| Phase 7 row | Status |
| --- | --- |
| *An image-only PDF is not OCR-read* | **Partly discharged.** A scanned PDF whose pages are `/DCTDecode` — which is what every document scanner and every "print to PDF" of a photograph produces — is now read, by lifting the JPEG the file already contains rather than by rasterising the page. `/CCITTFaxDecode`, `/JPXDecode` and `/FlateDecode` images are not, and the row's own blocker is unchanged for them |
| *No server-side page images for PDF and Office* | **Open.** The blocker is exactly as stated: a raster needs a canvas, a canvas in Node is a native binding, and the lockfile cannot gain one |
| *Non-PNG thumbnails still absent* | **Open**, for the same reason |
| *Watermark text is WinAnsi* | **Open.** `@pdf-lib/fontkit` is not in the lockfile at any level, so the named unblocker is not reachable in this sandbox |

**Phase 12's report** stated that nothing then produced a storm and that `retention.due` was the only
coalesced family. Both are now false in the way that report anticipated: `bulk.operation-completed`
is the second family, and 18 §7 records which of the five operations notify and how.

**Phase 15's two rows are left alone**, as the brief instructs: report *delivery* is Phase 17's and
the evidence-CSV formula finding is Phase 18's.

---

## 9. Verification

| Gate | Result |
| --- | --- |
| `pnpm format:check` | Clean |
| `pnpm lint` | Clean |
| `pnpm typecheck` | Clean |
| `pnpm test` | Clean |
| `pnpm test:integration` | **499 tests across 30 files**, against two real tenant databases |
| `pnpm build` | Clean |

The phase's own assertions, all against a real PostgreSQL:

- Two callers, **one identifier list**, two different sets of `APPLIED` rows — the assertion that
  distinguishes per-object reach from resolve-once.
- An identifier that does not exist answers `REFUSED`, identically to one the caller cannot see, so
  a bulk request is not a probe for which identifiers exist in a tenant.
- A legal-held document is `BLOCKED` with `ErrorCode.LEGAL_HOLD` and the other four in the batch
  complete.
- Three deletes carry three distinct cascade identifiers, and a bulk restore puts each back and
  clears each mark — so a restore reverses exactly one delete.
- A document the caller cannot reach is not resurrected, and the row stays deleted.
- 25 objects produce 26 audit rows; every row's `previous_hash` matches its predecessor's `hash` and
  the sequence is gap-free; the operation payload contains no document identifier.
- Two bulk operations by one person accumulate **one** window with `itemCount = 2`, and closing it
  produces at most one message per channel for one recipient rather than one per object.
- A document named twice in one request is acted on once.
