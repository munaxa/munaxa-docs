# Revision module

**Answers:** What did it look like at each controlled point in time?

| | |
| --- | --- |
| **Owns** | DocumentRevision, compare, restore |
| **Depends on** | Document, Storage |
| **Binds in core** | Nothing in core. |

## Layers

```text
revision/
├── revision.module.ts   composition for this module
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
| `revision.created` | A new draft revision exists beneath its document. |
| `revision.published` | This revision is effective; the previous one is superseded. |
| `revision.superseded` | No longer effective, still readable with history permission. |
| `revision.restored` | A new revision was created carrying an older revision\u2019s content. |

## Phase 3 — the first revision, and nothing else

A document's identity, the revision an approver approves and the bytes themselves are three records
with three lifetimes
([ADR-0003](../../../../../docs/architecture/adr/0003-document-identity-revision-file-separation.md)).
A document created without the middle one would be a document with no content, so **upload creates
ordinal zero**, in the same transaction, and that is the whole of this module today.

Check-out, check-in, compare and restore are Phase 6's; publishing and superseding are Phase 4's.
`document_revision` is already the full shape for all of them.

### The label is stored, not derived

The ordinal is the truth and the label is a display convention the document's type chooses
(`10-revision-architecture.md` §2). It is rendered **once**, at creation, because a type whose style
is changed later must not silently relabel history: a printed copy of revision 3 says `R3`, and a
system in which that revision is called something different next year is a system whose evidence
contradicts the paper.

### Why this module provides a token another module declared

`REVISION_WRITER` is declared in `document/application/ports.ts` and implemented here. Revision sits
*below* Document in the dependency order — it depends on Document, not the other way round — so
Document cannot call it. What Document can do is declare what it needs in its own words, which is
what the port is. This file imports Document's port; nothing in Document imports anything of this
module's.
