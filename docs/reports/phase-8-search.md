# Phase 8 — Search: what was built, what it costs, and what it deliberately does not do

**Status:** point-in-time record of the Search phase. Historical — superseded, never revised.
**Audience:** whoever builds Phase 9 and after, and whoever audits what Phase 8 claimed.

Phase 8 inherited a module that was contracts and nothing else — four files, no domain, no
infrastructure, no presentation — and a lane already full. `SEARCH_PORT` was bound, but to
`TenantScopedSearch` wrapping the refusing `UnconfiguredSearchAdapter`: the isolation wrapper
was real and exercised in every environment, and the engine underneath said no. That shape was
deliberate (12 §2 — an adapter "cannot run a query without being told the index", and a
subject's `tenant_id` is overwritten from ambient context rather than trusted), so this phase
bound its adapter *underneath* the wrapper and left the wrapper alone. `INDEX_PORT`,
`SEARCH_PROJECTION`, `SAVED_SEARCH_REPOSITORY` and `SEARCH_SERVICE` were declared and unbound;
`search.document-indexed` and `search.rebuild-completed` declared and unpublished. Phase 7 had
started routing `document.*`, `revision.*` and `preview.*` onto `search.index` in earnest —
nineteen event types accumulating and expiring with no consumer — and had produced the text to
index: `TEXT` artefacts with the file's own words, `OCR` artefacts with what an engine read off
pixels, `PreviewQueryService.textPages` as the read side, and `preview.ocr-completed` published
for exactly this consumer. Unlike Phase 7, this phase inherited a migration, not a schema:
there was no `search_index_entry` and no `saved_search` table. What this phase did was make 12
true — and take the one decision that document could not take for it.

## 1. The decision the phase turned on: `ACL_RESOLVER` binds, over what genuinely exists

ACL filtering was this phase's named risk, and the seam it needed was itself unbound. 12 §3 is
unambiguous: a user must never learn a document exists — which excludes fetch-then-filter —
and `acl_subjects` must be "computed by the same pure resolver the API uses — one
implementation, two call sites, so the index can never disagree with a direct read." That
resolver is `ACL_RESOLVER`, it belongs to the Library module, and it was bound to
`DenyAllAclResolver`, because Phase 2 built the tree a grant is *made on* and not the grants or
the walk. The choice was explicit: build the resolver and its ACL entries in this phase, or
filter on what genuinely exists with the index shaped so the resolver drops in later.

**The decision: bind the first real resolver, without building ACL entries.** Search is what
forces the seam, and only the seam. The index must materialise `acl_subjects` from *the*
resolver — a search module computing its own answer would be the divergent second
implementation 08's rule forbids, and the one defect that fails silently and leaks. But a
deny-all resolver cannot serve an index anybody may see, and it would also be *wrong*: a direct
read today is not denied — it is gated by the tenant-level role grant (`RbacGuard` over the
token), because `@ScopedTo` sits on no route and no grant exists to walk. So
`PrismaAclResolver` (Library module, `@Global` — the `AuditModule` pattern, because the port is
declared in core and core may not import a module) resolves 08 §3 over what exists: steps 3–5
find no entries, step 6 is the tenant-level role grant, step 7 keeps it closed by default.

The subject vocabulary is the part built for the future. An index entry's `acl_subjects` are
typed tokens — `user:<id>`, `role:<id>`, `department:<id>`, and the one non-identity,
`grant:<permission>`, meaning "anyone whose tenant-level role grant covers this". In this
generation every entry carries exactly `grant:document:view`, and a caller's
`visibilityFilter` carries the grant token exactly when their roles hold the permission — so
the overlap predicate answers precisely what a direct read enforces, from one implementation.
When the ACL phase builds entries and the walk, entries below a node stop carrying the grant
token and start carrying explicit subjects, the affected subtree re-projects
(`library.acl-changed` is declared for exactly this), and 12 §3's SQL does not change. The
`acl_deny_subjects` column and its `NOT (… && …)` clause are live in every query now, matching
nothing — the predicate is exercised before there is anything to deny, the same reasoning that
had `TenantScopedSearch` exercised before there was an engine.

What was deliberately **not** built: the `acl_entry` table, the upward walk, deny precedence,
`@ScopedTo` on object routes, `capabilitiesFor` in responses, and 08 §8's cache. Those are the
ACL phase's, and building them here would have been building a future phase inside this one.
The one repair made in passing: the resolver resolves a caller's departments from
`user_department` itself, because they are not in the token and `AclGuard` builds the subject
with an empty list — 08 §3 step 1 makes collecting subjects the resolver's own job.

## 2. The lane, finally consumed

`SearchIndexConsumer` follows `PreviewConsumer` and `WorkflowTimerConsumer` exactly: registered
in the owning module, gated on `queue.consumersEnabled`, its own system context (`userId:
null` — the system acted alone), malformed payloads logged and dropped ("the payload will not
grow the missing field on a fifth attempt"), idempotency in the database and never in the
delivery. Three job shapes share the lane. An **outbox event** is translated to the document it
concerns — `preview.*` events name a revision, resolved to its document — and re-enqueued as a
**projection job** whose deterministic id is the document plus the current debounce bucket.
Identical ids coalesce in the queue, so five changes to one document inside the window are one
projection (12 §6), and the delay pushes execution past the window's end so the one run reads
every change the window collected. The projection rebuilds the row *whole* from current truth,
which is what makes at-least-once delivery harmless: there is no partial update to double.
**Rebuild jobs** are the third shape (§4). Phase 7's routing decision — a prefix match
returning a list of lanes, over the declared-but-dead `EventRoute` registry — was consumed
as-is; this phase re-architected nothing about it.

The projection's sources, and the boundary decision they forced: text comes from
`PreviewQueryService` (the pipeline consuming its own output — the direction 14 drew), the ACL
from `ACL_RESOLVER`, and everything else from `PrismaSearchSourceReader` — a recorded exception
to "modules call each other's application services", reading document, folder, library,
organisation, confidentiality, metadata, revision and approval rows *as rows*. The alternative
was six bespoke bulk-read services invented for one consumer, spreading the read model's shape
across six modules. The discipline that matters is preserved: the reader makes no decision and
writes nothing; a schema change that breaks it breaks a projection the rebuild repairs, and it
cannot corrupt a source of truth it never touches.

Honesty rides the row. `content_pending` is `preview_render.state` materialised at projection
time and refreshed by the `preview.*` events — never a second status (12 §4). A document whose
format yields no text — DWG, TIFF, an image-only PDF — is findable by number, title and
metadata, and the entry says `body_source: null` so the UI says "findable by details only"
rather than pretending. An OCR body is marked as one, low-confidence reads flagged below
Phase 7's own threshold. The confidence-scale trap Phase 7 left (the event carries 0–1, the
table 0–100) never bites: the projection reads the *table*, through Preview's own service.

## 3. The query, which is where the leak would have lived

`PostgresSearchAdapter` implements 12 §3's SQL to the letter, in the security order: tenant
first, then `acl_subjects && callerSubjects AND NOT (acl_deny_subjects && callerSubjects)`,
then the structured filters, then the text match — and scoring, `ts_headline`, the total and
every facet count run strictly after that `WHERE`. A facet count over documents the caller
cannot read is the leak the predicate exists to prevent, and the integration suite asserts it
where only a database can: a caller whose roles lack `document:view` gets zero hits, a zero
total and zero facet counts while the row provably sits in the index. `search:all` — in the
catalogue since Phase 1, used for the first time — drops the ACL clause and nothing else, and
writes `SEARCH_PERFORMED` to the hash chain with the query in the payload, per 12 §3.

**Field queries parse, never concatenate.** `number:QMS-*`, `status:PUBLISHED`, `approver:me`,
`updated:>2026-01-01` come out of a pure domain parser as the same structured-filter shape a
clicked facet produces; an unknown field stays text (`re:union` in a title is a colon, not a
syntax error), `me` resolves in the service, a `type:` code resolves to its id — or to a
match-nothing id, because a code that resolves to nothing asked for a type that does not exist
and the honest answer is zero results. Every filter value is validated shape-by-shape and
bound as a parameter; an unknown key is a refusal, never a pass-through.

**Arabic is in the query path, not only the labels.** Normalisation — hamza carriers to bare
alef, alef maqsura to ya, ta marbuta to ha, tashkeel and tatweel stripped — lives in
`@edms/domain`'s `search-text.ts`; the index carries both the original and the normalised
spelling, the query is normalised, and stemming is the `arabic` configuration's. Language is
detected per revision by script counting, leaning Arabic, because a procedure that is
one-third Arabic letters is an Arabic document with Latin codes in it. The suite proves the
sentence that matters: a title spelled with hamza and tashkeel is found by a query spelled
with neither — and still found by its exact spelling.

**Pagination is keyset on `(rank, document_id)`** — the Phase 0.5 port sketch had offsets, and
the port was replaced to say so, the same procedure as Phase 7's renderer ports and for the
same recorded reason. The cursor is minted and refused by the engine, versioned by its sort
order, opaque everywhere else; the port also grew what a result list actually renders (the
stored summary fields, highlight *spans* rather than markup) and the `unrestricted` flag on
`SearchSubject`. Number and title sort exist beside relevance and recency; did-you-mean does
not (§7).

## 4. The rebuild, which was the part with teeth

12 §6: safe against a live index, resumable, readable throughout — the shadow table, not a
truncate. `search_index_entry_shadow` is the live table's exact shape; `POST /search/rebuild`
(behind `settings:manage`, audited as `SEARCH_REBUILD_REQUESTED`) writes the state row and
enqueues a deterministic job; the consumer fills the shadow in batches — 200 documents, each
batch one transaction with the cursor advanced inside it, so a crash loses at most one batch
and the retried job resumes from the cursor instead of starting over. One `RUNNING` row per
tenant, decided by a partial unique index rather than this code — the check-out lock's shape.
While a rebuild runs, every live projection dual-writes into the shadow too (ADR-0008's
dual-write, inside one engine), so a change landing mid-fill survives the swap; a deletion
mid-fill removes from both.

**The swap is an atomic tenant-scoped transaction, not a table rename — deliberately.** The
document's phrase is "rebuilt into a shadow table and swapped", and the obvious swap is three
`ALTER TABLE RENAME`s. Two facts rule it out: renaming a table is the owner's privilege, and
the application role deliberately does not own the tables (`infra/sql`'s whole design); and in
a single-database installation holding two tenants — the deployment RLS exists to keep honest
— a rename would swap *every* tenant's index because one tenant asked. So the swap is one
transaction: delete the tenant's live rows, insert the tenant's shadow rows, empty the shadow
— RLS-scoped end to end, and MVCC keeps readers whole: a concurrent query sees the index
before the swap or after it, never empty. The suite asserts exactly that, plus resumability's
plumbing and `search.rebuild-completed` committed with the completion.

## 5. The decisions the specification left open

**Saved searches are per user; sharing waits for grants.** "Shareable by ACL" is 12 §5's own
bullet, and there are no ACL entries to share by. A sharing model invented before grants exist
would be a second permission system — the exact defect §1's decision exists to prevent — so
`saved_search` is one person's shortcut, soft-deleted and versioned like every aggregate root,
name-unique per owner among live rows (partial, case-insensitive, raw SQL — Prisma cannot
express it). Recent searches are telemetry-shaped like `document_view`: deduplicated by
digest, pruned to a configured cap in the same transaction as the search that recorded them.
Neither is audited, for the reason favourites are not: a fact about a menu, not about a
controlled record.

**Search is gated by `document:view`; drafts are findable.** A separate `search:*` permission
for the surface would gate finding on something other than seeing. Today's reach model shows
any holder of `document:view` every document, drafts included — exactly what the document list
already does — and the status facet is how a reader narrows to the published. When per-node
grants arrive, both surfaces narrow together, through the one resolver.

**"Tags" are metadata, because tags do not exist.** The phase brief lists tags; no phase has
built a tag table or a tagging surface, and 05's `document_tag` is target design. Indexing a
table nothing writes would be dead weight, so the B weight carries what tenants actually
classify with today — searchable metadata fields and select values — and `meta.<fieldId>`
filters serve the structured side. Tags become searchable in the phase that makes them exist.

**Approvers are the people who decided.** `approver:me` matches `approval_task` rows in state
`DECIDED` — `decided_by` falling back to the assignee — not pending assignees, because "what
have I approved" is the compliance question and "what is waiting for me" is the task inbox's,
already built.

**Deleted documents leave the index entirely.** Soft-deleted and purged rows are removed at
projection, never filtered at query time: an unfindable row in the index is a leak waiting for
a predicate bug. The recycle bin lists deletions from the live tables, where it always has.

**One engine binding, refused loudly when absent.** `SEARCH_DRIVER=OPENSEARCH` validates at
boot and refuses at composition, naming the variable — the `OCR_DRIVER=HOSTED` precedent
exactly. `UnconfiguredSearchAdapter` is deleted rather than kept: `SEARCH_DRIVER` has no
`NONE`, so no configuration means "search refuses" — the same deletion Phase 7 made of
`UnconfiguredPreviewAdapter`.

## 6. What was built

| Piece | What it does |
| --- | --- |
| `prisma` — `search_index_entry` (+ shadow), `saved_search`, `recent_search`, `search_rebuild`, `SEARCH` audit subject | One migration: the read model with weighted `tsvector`, GIN and opclass indexes in raw SQL; the partial uniques Prisma cannot express |
| `core/authorization` + `library` — `PrismaAclResolver`, `acl-subjects.ts`, the `aclSubjectsFor` port method | The first real `ACL_RESOLVER`: role-grant resolution, the typed subject vocabulary, one implementation for both call sites; `DenyAllAclResolver` deleted |
| `ports/search.port.ts` | The rebuilt contracts: keyset cursor, hit summaries, highlight spans, `unrestricted`, the rebuild's three-step `IndexPort` |
| `search/domain` — `query-parser.ts`, `audit-actions.ts`; `@edms/domain` `search-text.ts` | Field syntax into structured filters; Arabic normalisation and per-revision language detection, shared where both module and engine may reach them |
| `search/application` — projection, query service, rebuild, saved searches | The use cases: idempotent whole-row projection, the security-ordered query, the resumable fill, one person's shortcuts |
| `search/infrastructure` — the consumer, the source reader, the Prisma repositories | The lane's first consumer with queue-level coalescing; the recorded read-model exception |
| `infrastructure/search` — `PostgresSearchAdapter`, `PostgresIndexAdapter`, `search-cursor.ts` | ADR-0008's engine under the untouched `TenantScopedSearch`; driver selection with the boot refusal |
| Config — `SEARCH_DEBOUNCE_MS`, `SEARCH_REBUILD_BATCH_SIZE`, `SEARCH_RECENT_LIMIT`, `SEARCH_MAX_BODY_CHARS` | The coalescing window, the resume granularity, the recents cap, the body cap |
| Contracts — `search/search.ts` | The wire shapes: query, hits with segmented highlights, facets, cursor, saved/recent, the rebuild status |
| API — `search.controller.ts` | `GET /search`, saved-search CRUD under `If-Match`, recents, `POST/GET /search/rebuild` (202; `settings:manage`) |
| Web — `features/search/`, `/search`, the nav row | The search screen: query bar with syntax hint, facet rail, keyset "load more" through a server action, saved and recent searches, pending/OCR badges; EN and AR in the same commit |

One migration; no new permission — `search:all` and `settings:manage` were in the catalogue
since Phase 1, and this phase is `search:all`'s first caller.

## 7. What it costs

| Cost | Detail | Mitigation |
| --- | --- | --- |
| **The projection reads text back over HTTP** | `textPages` fetches each `TEXT` artefact through a presigned URL, sequentially, inside the projection's transaction | The Phase 7 trade, inherited knowingly: one artefact pattern beat a text column. The body cap bounds it; a bulk read on the repository is the recorded improvement if projection latency ever shows in numbers |
| **The swap rewrites the tenant's index rows** | Delete-and-insert instead of a rename, per §4's reasoning | MVCC keeps readers whole; the cost is one transaction over the tenant's entries at the *end* of an operation that is rare by design |
| **Every entry stores its body twice over** | The text and its lexemes (`body` + `tsv`), plus normalised Arabic doubling tokens | `SEARCH_MAX_BODY_CHARS` caps it; the body column is what makes highlighting and re-analysis possible without refetching blobs |
| **The debounce delays freshness by its window** | Every change waits out `SEARCH_DEBOUNCE_MS` before projecting | Default 1 s, inside 12 §6's two-second target; a deployment trades latency for coalescing explicitly |
| **A GIN index per write** | The first thing 12 §7 says to monitor | The migration triggers are written down; meeting one means writing `OpenSearchAdapter`, which the boot refusal already names |
| **`search.document-indexed` has no consumer** | Published per projection into the outbox, routed nowhere | The Phase 4 position on notifications, again: the row is the record until a consumer exists; the dispatcher marks unrouted events processed |

## 8. Deliberate limits

| Limit | Why | Unblocked by |
| --- | --- | --- |
| No ACL entries, no walk, no deny precedence | §1's decision: search forces the resolver seam, not the grants | The ACL phase extends `PrismaAclResolver` and re-projects; the predicate does not change |
| Saved searches are not shareable | Sharing by ACL needs ACLs to exist | The same phase, over `saved_search` rows |
| No did-you-mean | `pg_trgm` is installer surface bought against a need nothing measures yet | One migration (`CREATE EXTENSION pg_trgm`, a trigram index) and one suggestion query |
| No tag search | No tag table exists anywhere in the product; the brief's "tags" are served by metadata | The phase that builds tagging |
| `search:all` matrix row is trusted from the token | The resolver could re-derive it; the token's `permissionVersion` already forces re-issue on role change | Nothing — this is the same trust every `@RequirePermission` route places |
| OpenSearch refused at boot | No adapter yet; a value that boots and never answers would be an outage found at the first query | 12 §7's migration triggers; the port's method set was kept narrow for exactly that week of work |
| Delegation subjects are always empty | Phase 11's; `AuthorizationSubject.delegationIds` and the token vocabulary leave the room | Phase 11 fills the field; entries re-project |
| A TIFF still never reaches OCR | Phase 7's `UNSUPPORTED` branch returns before `maybeQueueOcr`, so 12 §4's "scanned TIFF becomes searchable" is not yet true — found by this phase, owned by Preview | A Preview fix routing OCR-capable unsupported formats to the slow lane; the projection needs no change |
| Retention, legal hold, notifications, dashboards, reporting, semantic and cross-tenant search | Out of scope, named by the brief | Phases 9/10, 12, 13, 15, and 12 §7's triggers respectively |

The Phase 7 report's "Search consumes nothing yet" limit row is discharged by this phase — the
lane has its consumer, and the events it accumulated are the projection's diet. That report is
historical and stands unedited; this line is its discharge.

## 9. Verification

| Gate | Result |
| --- | --- |
| `pnpm format:check` | Clean |
| `pnpm lint` | Clean across all thirteen tasks |
| `pnpm typecheck` | Clean across all seven packages |
| `pnpm test` | 382 API tests (up from 362 — the parser, the cursor codec, the subject vocabulary, the coalescing consumer), 99 domain tests (up from 88 — the Arabic folds and language detection), 26 contract tests, 21 web tests |
| `pnpm test:integration` | 22 files / 365 tests (up from 21 / 349) against real PostgreSQL, two tenant databases |
| `pnpm build` | Clean, API and web — including the typed `/search` route |
| `pnpm prisma:deploy` | Verified against two tenant databases, including the new migration and the RLS policies the post-migrate gate applied to every new table |

`search.integration.spec.ts` carries the phase's own assertions, and each asks something only
the database can answer: the permission predicate refusing a caller whose roles lack
`document:view` — zero hits, zero total, zero facet counts — while the row provably sits in
the index; the entry carrying exactly the resolver's `acl_subjects` and a 64-hex `acl_hash`;
projection idempotency under redelivery, twice in and one row out; content honestly `pending`
before the render and `TEXT`-sourced with highlights after it; a soft-deleted document leaving
the index entirely; Arabic detected per revision and found under a spelling its author never
used; `search:all` widening past empty role grants with a `SEARCH_PERFORMED` row naming the
query; recents deduplicated and capped in the database; another person's saved search
answering as nonexistence; the rebuild answering readers mid-fill, dual-writing a mid-flight
document into the shadow, completing with the live count equal to the findable count and the
shadow empty; a second tenant's database holding zero entries even for an unrestricted search;
a subject lying about its tenant overwritten by the scoping wrapper; and keyset pages that
never overlap, with a cursor from another sort refused.
