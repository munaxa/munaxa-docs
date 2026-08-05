# Retention module

**Answers:** How long must it be kept, and what happens then?

| | |
| --- | --- |
| **Owns** | RetentionSchedule, LegalHold, DocumentTombstone, the recycle bin, disposition review, purge |
| **Depends on** | Document, Storage, Library |
| **Binds in core** | Nothing in core. |

## Layers

```text
retention/
├── retention.module.ts        composition — the half *below* Document
├── disposition.module.ts      composition — the half *above* Document
├── domain/                    entities, value objects, pure rules, events — no Nest, no Prisma
├── application/               use cases and the ports this module declares
├── infrastructure/            Prisma repositories and adapters implementing those ports
└── presentation/              controllers, DTOs, OpenAPI decorators, view mappers
```

The dependency rule points inward, and it is enforced by `eslint.config.mjs` at the app root,
not merely described here. Other modules call this one through its **application service** or
react to its **events** — never through its repositories or its Prisma models.

## Why two Nest modules over one folder

This is the only module in the product composed as two, and the split is the module graph's rather
than the domain's.

`RetentionModule` is the half that sits **below** Document: the schedule and hold repositories, the
policy reader, and `RETENTION_SCHEDULER` — the seam Document's own delete, restore and publication
call *inside their transactions* to start or withdraw a clock. `LEGAL_HOLD_SERVICE` is here too,
because Document's delete asks it whether the record is held before it does anything.

`DispositionModule` is the half that sits **above** Document: the sweep that asks Document to purge
through `DOCUMENT_DISPOSITION`, the reaper that asks Storage to reclaim through `BLOB_REAPER`, the
recycle bin, the lane consumer and the HTTP surface.

One module doing both would need Document and be needed by it. That is the cycle `forwardRef`
exists to paper over, and papering over it would have meant a container that resolves in an order
nobody can read. Splitting at the line the *dependency* actually falls on costs one extra file and
buys a module graph that is still a graph.

## Events published

| Type | Meaning |
| --- | --- |
| `retention.scheduled` | A disposition date is set for a document. |
| `retention.due` | A schedule reached its date and needs review or execution. |
| `retention.hold-placed` | Disposition is suspended regardless of policy. |
| `retention.hold-released` | The suspension ended; the schedule resumes. |
| `retention.document-purged` | Content destroyed. The audit trail and the number remain. |

`retention.*` routes to `search.index`, so a purged document's entry leaves the index by the path
every other document event already takes. `retention.due` is consumed by nothing: Phase 12's
disposition reminder is what will consume it, and the outbox row is the record until it does — the
position Phase 4 took for `workflow.*` and Phase 9 for `audit.chain-broken`.

## Audit actions

`SCHEDULE_SET`, `HOLD_PLACED`, `HOLD_RELEASED`, `DISPOSITION_APPROVED`, `PURGE_EXECUTED` — 13 §2's
Retention group — plus the Document group's `PURGED`, which §2's ownership table attributes to this
phase. A purge writes **two** events, and that is deliberate rather than duplication: `PURGED` is
filed against the document and reads as the last entry on its timeline; `PURGE_EXECUTED` carries
the schedule, the policy and who approved the disposition, which is what a records-management
report reconciles against the policy register. Two groups, two audiences.

## What a purge may not do, and how that is enforced

`audit_event` refuses `DELETE` to every role, owner included
([`02-audit-immutability.sql`](../../../../../infra/sql/post-migrate/02-audit-immutability.sql)).
So a purge that tried to remove a document's trail would fail loudly rather than quietly succeed,
and the trail *will* outlive its subject whatever this module does.

That is a constraint to design with rather than around, and it has one consequence: a trail whose
subject is gone is only legible if the document number went somewhere the purge cannot reach. The
payloads of events written before Phase 10 cannot be rewritten to add one — rewriting a row is the
single operation this product will not perform on that table. So the number, the title, the type
and the folder path are copied to **`document_tombstone`** at purge time, in the same transaction,
from facts read before anything was removed.

The cost is stated rather than hidden: for events written **before** this phase, the document
number is not in the row and never will be — it is one join away, on the tombstone, keyed by the
same identifier the row's `subject_id` already carries. Events written from here on carry it in the
`PURGED` payload as well, so the last event of a document's life is legible on its own.

## The recycle bin's one exception

`PrismaRecycleBinRepository` reads `document` and `folder` — rows two other modules own. It is a
**read model** and it writes nothing, the same exception Search's `PrismaSearchSourceReader` is,
for the same reason: "one page of everything deleted, newest first" is a question only the database
can answer without reading everything, and paging two modules' lists and merging in memory would
make `total` a lie — which is exactly what `common/query.ts` refuses for every other list.

Restoring is **not** here. It goes back through `POST /documents/{id}/restore` and
`POST /admin/folders/{id}/restore`, because each owning module revalidates its own rules — the
folder must be live, the cascade must be exactly the one this delete took — and a second
implementation would disagree with the first the moment one of them was corrected.

## What is deliberately absent

There is no purge endpoint, and the wire cannot express one. ADR-0010 rejected the administrator's
"purge now" button by name — it is the mechanism by which records under an unnoticed legal hold get
destroyed — so the only manual step is *approving* a disposition the policy already scheduled, and
the sweep on the single-consumer `retention.run` lane is what executes it.
