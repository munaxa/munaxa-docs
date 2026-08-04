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

## Deliberate limits

| Limit | Why | Unblocked by |
| --- | --- | --- |
| No `capabilities` on a response | Object-level permission resolution is the ACL resolver's, and it is unbound. Inventing the object would be the client rendering affordances from a decision nothing made | The ACL phase |
| No document number | Reserved at submission, assigned at approval ([ADR-0004](../../../../../docs/architecture/adr/0004-numbering-assigned-at-approval.md)) | Phase 5 |
| Every document is `DRAFT` | The transition table and its guards are Phase 4's. `refuseWhenFrozen` is written now and never fires, because an edit path built without the check is one somebody has to remember to add | Phase 4 |
| Declassification is refused outright | Reducing a document's confidentiality is a decision with its own procedure. Allowing it here would make it an ordinary edit any document editor can perform | The phase that gives it one |
| No tags, links or check-out lock | Named in this module's own contract and not needed to file a document | Phases 6 and 16 |
