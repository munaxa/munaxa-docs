# Document module

**Answers:** What is this document, in the business's terms?

| | |
| --- | --- |
| **Owns** | Document, DocumentMetadataValue, Tag, Link, check-out Lock |
| **Depends on** | Library, Administration |
| **Binds in core** | Nothing in core. It is the product's root aggregate and the busiest publisher of events. |

## Layers

```text
document/
├── document.module.ts   composition for this module
├── domain/                    entities, value objects, pure rules, events — no Nest, no Prisma
├── application/               use cases and the ports this module declares
├── infrastructure/            Prisma repositories and adapters implementing those ports
└── presentation/              controllers, DTOs, OpenAPI decorators, view mappers
```

The dependency rule points inward, and it is enforced by `eslint.config.mjs` at the app root,
not merely described here. Other modules call this one through its **application service** or
react to its **events** — never through its repositories or its Prisma models.

## Events published

| Type | Meaning |
| --- | --- |
| `document.created` | A controlled record exists in DRAFT; it has no number yet. |
| `document.submitted` | Handed to the workflow; content is frozen from here. |
| `document.approved` | All stages passed and the number was assigned in the same transaction. |
| `document.published` | This revision is the effective one; the previous one is superseded. |
| `document.rejected` | Terminal for this attempt; no number was issued. |
| `document.checked-out` | Exclusively locked for the next revision. |
| `document.checked-in` | A new draft revision exists beneath the published one. |
| `document.moved` | Folder changed, so inherited permissions changed. |
| `document.archived` | Retired from active use, still readable. |
| `document.deleted` | Soft-deleted and recoverable; the number stays reserved forever. |
| `document.restored` | Returned to the state it was deleted from, never a higher one. |
| `document.number-assigned` | Issued once, at approval, and never reused. |

## Phase 3 — the library

The first phase whose tables hold a customer's own content rather than their configuration. What is
built: creating a controlled record from uploaded content, its business metadata, where it sits, and
the two per-person lists — favourites and recents — that make a library navigable.

Tags, links and the check-out lock are later phases. The aggregate is here.

### File metadata and business metadata are separate, deliberately

What a file *is* — digest, size, type, scan verdict — belongs to `file_object` and is a fact about
bytes. What a document *means* — its type, its category, its confidentiality, the tenant's own
fields — belongs to `document` and `document_metadata_value` and is a fact about the business. A file
replaced at the next revision changes every fact in the first group and none in the second.

`document_metadata_value` has **typed columns**, not a `jsonb` bag. The tenant defines which fields
exist; the product knows what a date is. A bag would make "documents expiring this quarter" a scan
and a cast, and would let a `NUMBER` field hold whatever a form posted.

### A document, its first revision and its blob's reference are one transaction

A document with no revision has no content; a revision holding a blob nothing counted is a blob
retention will delete underneath it. Neither state is observable.

### The type's policy is copied, not referenced

Confidentiality and retention are frozen onto the document at creation. That is what lets an
administrator edit a document type without rewriting history, and what stops raising a type's
default silently declassifying every document already created under it. A document's own level may
be raised and never lowered — every handling rule on a level subtracts, so choosing a lower one
would be a way to grant access the type's author decided against, from a dropdown.

### A duplicate is a warning, not a refusal

Content addressing already made identical files one blob, so "is this a duplicate" is a lookup
rather than a comparison. Filing the same signed form against two projects is ordinary; doing it
*unknowingly* is the mistake — so the first attempt is refused with what it found, and an attempt
that says it knows is accepted.

### Moving is not editing

A move changes the folder, which changes the ACL chain the document resolves through, which changes
who can see it. Its own permission, its own endpoint, its own audit action — and `If-Match` is
**required** rather than optional, because a blind move is a change to who can see a document made by
somebody who has not looked at where it is.

## Two ports this module declares and other modules implement

`REVISION_WRITER`, `DOCUMENT_CONTENT_GATE` and `DOCUMENT_THUMBNAILER` are declared in
`application/` and implemented by Revision, Storage and Preview respectively. That is dependency
inversion rather than a boundary violation, and the import direction is the proof: those modules
import Document's ports, and **nothing in Document imports anything of theirs**. The Nest imports in
`document.module.ts` are composition wiring, which points from a consumer to whatever satisfies it.

Each port is deliberately narrower than the service behind it. `DOCUMENT_CONTENT_GATE` can describe
a blob, reference it, dereference it and link to it — it cannot create an upload, complete one or
delete a blob, because a document use case able to delete a blob is one able to delete another
document's content.

## The lifecycle — Phase 4

`domain/lifecycle.ts` is the transition table from
[`06-document-lifecycle.md`](../../../../../docs/architecture/06-document-lifecycle.md) §5, and it is
**the only source of truth**: there is no `if (status === 'PUBLISHED')` anywhere in this module, and
an inline status check is a check that disagrees with the table the first time somebody adds a state.

Two tables rather than one, and the second is the honest part. `LEGAL_TRANSITIONS` is the design and
includes rows owned by Phases 5, 6, 9 and 10. `IMPLEMENTED_TRANSITIONS` is what the product can
actually perform today, and it is what `GET /documents/{id}/workflow` reports — because §5's rule is
that the UI renders exactly the transitions the API offers, and offering one that nothing performs
would make a client draw a button that returns a 404.

`refuseWhenFrozen` was written in Phase 3 against statuses nothing could reach. Phase 4 is what makes
it fire, and the set moved here with the table it belongs to: "the bytes under review must be the
bytes approved" is a row of §4, not a rule of this service. `CHANGES_REQUESTED` is deliberately
absent from it — an approver asking for changes is asking the author to make them.

Workflow reads this module through `approvalContext`, which assembles the flat, pre-approved fact map
a stage condition is evaluated against. The assembly is here rather than in the engine because that
is the security-relevant half: §2 requires that no tenant-authored expression reaches an evaluator
that can touch I/O, so the facts are gathered *before* evaluation by code that knows what it is
fetching, into a `Map` whose keys a tenant does not choose.

## Phase 5 — the number

`DOCUMENT_NUMBER_SERVICE` is the one path onto `document.document_number`, and this module owns it
because the number is the document's: the service resolves the document's real organisational codes
— its library's scope chain, its department's branch, its type and category — and hands them to
Administration's issuance service, which owns the rules, the counters and the reservations. Nothing
a client sends ever reaches a scope key. The engine reaches it through Workflow's
`DOCUMENT_NUMBER_ALLOCATOR` adapter; the manual path (`POST /documents/{id}/number`, behind
`numbering:manage`) validates a supplied number against the rule's shape and fast-forwards the
series past it. `assignNumber` in the repository carries `document_number IS NULL` in its `WHERE`,
so write-once is a property of the statement rather than a check that ran a moment earlier.

## Phase 6 — revision control

The check-out lock and the operations over it live here, because both belong to this module's
aggregate: `RevisionControlService` (check-out, check-in, cancel, force check-in, publish,
restore) moves the document's lifecycle and takes its lock, and every write onto
`document_revision` itself goes through the widened `REVISION_WRITER` port — the same inversion
Phase 3 cut, carried forward rather than joined by a second pattern.

Three rules the service states and every path obeys:

- **The lock order against the document row is fixed**: the document row first (under its
  optimistic version), the lock row second, revision rows last. The check-out *race* is not
  decided by that order — it is decided by `uq_document_lock_live`, the partial unique index of
  exactly `uq_workflow_instance_live`'s shape, so two check-outs racing produce one lock and one
  refusal naming the holder.
- **The two machines stay two machines.** `applyLifecycleTransition` keeps the revision's own
  status in step — submission freezes the draft into `IN_APPROVAL`, every road back to an
  editable document returns it to `DRAFT` — and publication is the only thing that makes a
  revision `PUBLISHED`, superseding the prior one in the same transaction.
- **Check-in content passes the same gate as creation**: `CLEAN` or refused, in the use case and
  again by the database trigger beneath it.

`FROZEN_STATUSES` gained `CHECKED_OUT` the moment the state became reachable: a checked-out
document accepts a new draft revision and nothing else.

## Deliberate limits

| Limit | Why | Unblocked by |
| --- | --- | --- |
| No `capabilities` on a response | Object-level permission resolution is the ACL resolver's, and it is unbound. Inventing the object would be the client rendering affordances from a decision nothing made | The ACL phase |
| Declassification is refused outright | Reducing a document's confidentiality is a decision with its own procedure. Allowing it here would make it an ordinary edit any document editor can perform | The phase that gives it one |
| No tags or links | Named in this module's own contract and not needed to file a document | Phase 16 |
| Publication is manual and immediate | Scheduled publication at a future effective date needs a timer this phase deliberately did not build | The phase that schedules it |

## Phase 7 — the preview surface

The preview access decisions live here, beside the download's, because they are the same
decisions about the same record: **permission** on the route (`document:view` for preview —
deliberately not `document:download`, because preview is what "readable, not downloadable"
means; `document:history:view` for a named revision; `document:print` for print), **state** in
`document-preview.service.ts` (readers are served the current revision, exactly as downloads
are), **confidentiality** last and subtract-only — `allow_print` refuses a permitted caller,
`watermark` decides whether the issued URL points at bytes that carry the stamp. What exists
and how to present it is Preview's answer (`PreviewQueryService`); whether is this module's.
A served view audits `DOCUMENT_VIEWED` gated by `audit.readEventsAboveRank`; a print audits
13 §2's `PRINTED` row, unconditionally, through the rendition and never the original.

## Phase 10 — the delete, closed

Phase 3 shipped a delete that gave back the reference on the *latest* revision, and Phase 6 built
revisions nothing ever detached. Together that meant a document with four revisions returned one
reference when it was deleted: its blobs could never reach zero, and the retention sweep that
reclaims bytes at zero could never reclaim anything. Phase 10 closes it, and the answer is one
table rather than a fix in one place — `DOCUMENT_DELETION_RULES` in `@edms/domain`, which the
purge, the cascade and the integration suite all read.

What changed here:

- **A delete cascades over every live revision**, stamped with one `delete_cascade_id`, giving
  back each row's reference. A restore reverses *that* cascade — so a revision discarded on its own
  beforehand comes back as a row and does **not** re-take a reference it had already given up.
- **A reason is mandatory**, stored on `document.delete_reason` and written to the audit trail's own
  `reason` column, where Phase 9's widened digest attests it. The recycle bin shows it beside the
  row: a reason somebody must open the trail to read is a reason nobody reads before restoring.
- **A legal hold refuses, absolutely.** `LEGAL_HOLD` rather than `FORBIDDEN`, because no grant
  would change the answer (ADR-0010 §5). The gate is `LEGAL_HOLD_SERVICE`, injected from
  Retention's lower half — which knows nothing about documents, so the dependency stays one-way.
- **A delete answers to the lifecycle table rather than to the frozen set.** `ARCHIVED → DELETED`
  is legal — it is how a record leaves the shelf — while a published or in-approval document still
  refuses, because deleting the controlled copy everybody is reading is a decision retention makes
  and never a click.
- **`RetentionDispositionAdapter` binds `DOCUMENT_DISPOSITION`** — the purge, performed by the
  module that owns the aggregate being destroyed. It is the one place this module writes rows it
  does not own (`workflow_instance`, `number_reservation`), and the file says why at length: the
  cascade is one transaction over relations owned by five modules, its order is the foreign keys',
  and a port per owner would put that order in no module at all.
- **`DocumentFolderContentsParticipant`** fills the slot Library declares, so a folder's delete
  finally reaches the documents inside it. Before this, they stayed live in a deleted folder —
  reachable by search and by nothing else.

## Phase 16 — bulk operations, templates and signatures

Three capabilities, and the first two of them are the same argument in different clothing: neither
adds a second way to do something this module already does.

**Bulk metadata, bulk restore, bulk upload and bulk export** live in `application/bulk-*.service.ts`
and reimplement nothing. Every `apply` is a call to `DefaultDocumentService`'s own single-object use
case, so a bulk restore reverses exactly one cascade because `restore` does, a bulk edit refuses a
frozen document because `update` does, and `ErrorCode.LEGAL_HOLD` refuses one document and lets the
batch finish because Phase 10 put it in the delete path and nothing here reaches around it. The
choreography — a transaction per object, the caller's reach resolved *per object* through
`ACL_RESOLVER`, the tally, the operation record and the one operation-level audit row — is
`core/bulk/`, which owns no rules.

The fast implementation of a bulk metadata edit is one `UPDATE … WHERE id IN (…)`. It is one to two
orders of magnitude quicker and skips six correctness properties: the reach check per object, the
frozen-status check, the optimistic lock, the per-document audit row, the outbox event and the
search re-projection. The report states the cost of not taking it.

**`DOCUMENT_CONTENT_GATE` gained one method** — `storeManifest` — and the narrowing that file has
carried since Phase 3 still holds. Document still may not create an upload, complete one, or delete
a blob; it may now write one derived artefact whose content it composed, which is the same
permission the preview pipeline has for a thumbnail. The alternative was for the bulk export to hold
`STORAGE_SERVICE`, which would have handed this module `abandonUploadSession` to obtain one call.

**Templates** are configuration that *produces* documents, not documents in a hidden folder. The
distinction is the whole design: modelling one as a document would have given every blank form a
workflow, a retention schedule and a row in everybody's search results. Authoring is
`template:manage`; *using* one is an ordinary `document:create`, and `createFrom` calls `create` so
every rule the manual path enforces still runs. The body is a **reference** to the same
content-addressed blob ADR-0007 deduplicates, so a thousand documents from one template are one blob
with a thousand and one references — obtained by not writing a copy path rather than by adding one.

**Signatures** are [ADR-0017](../../../../../docs/architecture/adr/0017-electronic-signature-as-witnessed-attestation.md)'s
reading of a word that means four different things: a 21 CFR Part 11 §11.50 manifestation — printed
name, instant, meaning — bound under §11.70 to the signed revision's content digest and witnessed by
the server with the construction Phase 9 uses for audit checkpoints. It is **not** an eIDAS
qualified signature and nothing here may say it is. `document:sign` is seeded to no role including
the tenant administrator, which is 08 §6's first deliberate row applied a second time: a signatory
conferred by seniority is what an electronic-signature regime exists to prevent.

Two ports Identity answers: `SIGNER_AUTHENTICATOR` re-proves the signer's credentials at the moment
of signing (§11.200), reusing `MfaService.challenge` so the recovery-code path and the replay window
come with it, and `DocumentConfiguration.signer` supplies the printed name — read once, copied into
the signed bytes, and never re-resolved, because a person who changes their surname must not
retroactively change what the record says was signed.
