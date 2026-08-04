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

## Phase 3 — the first revision; Phase 6 — the rest of them

A document's identity, the revision an approver approves and the bytes themselves are three records
with three lifetimes
([ADR-0003](../../../../../docs/architecture/adr/0003-document-identity-revision-file-separation.md)).
Phase 3 created ordinal zero at upload and nothing else; Phase 6 filled in the whole life of the
record: the next revision at check-in, the working-status moves the two-machine model needs,
publication with its supersession, the discard a cancelled check-out performs, and the restore that
creates a new revision carrying an older one's content — a row, not a copy, because the restored
revision references the same blob.

The module's own surface is the **read side**: `GET /documents/{id}/revisions` (the timeline) and
`GET /documents/{id}/revisions/compare` (content by checksum, metadata by the snapshot publication
wrote), both behind `document:history:view` — a superseded revision remains readable because
history is compliance evidence, not clutter (`10-revision-architecture.md` §2). The *writes* —
check-out, check-in, publish, restore — are Document's use cases, because every one of them moves
the document's lifecycle or takes its lock; they reach this module's rows only through the port
below.

### The label is stored, not derived

The ordinal is the truth and the label is a display convention the document's type chooses
(`10-revision-architecture.md` §2). It is rendered **once**, at creation, because a type whose style
is changed later must not silently relabel history: a printed copy of revision 3 says `R3`, and a
system in which that revision is called something different next year is a system whose evidence
contradicts the paper. Phase 6 took the decision Phase 3 left open for `MAJOR_MINOR`: publication
increments the major, and the minor counts drafts since the last publication — `1.0`, then `2.0`
for the first draft after the original publishes, `2.1` for its replacement.

### Why this module provides a token another module declared

`REVISION_WRITER` is declared in `document/application/ports.ts` and implemented here. Revision sits
*below* Document in the dependency order — it depends on Document, not the other way round — so
Document cannot call it. What Document can do is declare what it needs in its own words, which is
what the port is. This file imports Document's port; nothing in Document imports anything of this
module's. Phase 6 widened the port along the same seam rather than cutting a second one, and the
implementation publishes Revision's own events (`revision.created`, `revision.published`,
`revision.superseded`, `revision.restored`) from inside the caller's transaction — Document causes
Revision's facts without knowing how they are spelled.
