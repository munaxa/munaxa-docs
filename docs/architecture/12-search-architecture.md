# 12 — Search Architecture

**Purpose:** how documents are found — metadata, full text, OCR — without ever leaking one.
**Audience:** backend engineers; anyone building search UI.

## 1. Requirements

| Requirement | Consequence |
| --- | --- |
| Find by number, title, tag, author, approver, department, entity, type, status, revision, date | A structured index, not just a text blob |
| Find by content, including scanned paper | Extracted text + OCR feed the same index |
| Never return a document the caller may not see | Permission filtering happens **in** the query, not after it |
| Arabic and English | Language-aware analysis and a normalisation step |
| Sub-second at millions of documents | An index, never a scan of the live tables |
| Provider-replaceable | Everything behind `SearchPort` ([ADR-0008](./adr/0008-postgres-first-search.md)) |

## 2. Design

```mermaid
graph LR
    DOC[Document change] -->|outbox| Q[search.index queue]
    REV[Revision published] -->|outbox| Q
    OCR[OCR complete] -->|outbox| Q
    ACL[ACL change] -->|outbox| Q
    Q --> W[Index worker]
    W --> IDX[(search_index_entry<br/>tsvector + metadata + acl fingerprint)]
    UI[Search request] --> API
    API --> SP[SearchPort]
    SP --> IDX
```

The index is a **read model**. It is never authoritative, it is rebuildable from source at any time,
and a rebuild is a routine operation rather than an incident.

**One index per tenant** ([ADR-0015](./adr/0015-database-per-tenant.md)). Which index answers a tenant's
search is a placement, not a use-case decision, so adapters are written against a port that cannot run
a query without being told the index — and the `tenant_id` on a search subject is *overwritten* from the
ambient context rather than trusted, so a subject built for another tenant returns the caller's own
results rather than a leak. For the PostgreSQL generation the index lives in the tenant's own database
and the separation is already physical; for an external engine sharing one cluster, the index name is
the entire boundary.

### Index entry

| Field | Purpose |
| --- | --- |
| `document_id`, `tenant_id` | Identity and isolation |
| `tsv tsvector` | Weighted text: number and title (A), tags and metadata (B), summary (C), body/OCR text (D) |
| `number_exact`, `title_raw` | Exact and prefix matching, unaffected by stemming |
| `metadata jsonb` | Typed values for filtering and faceting |
| `type_id`, `category_id`, `status`, `confidentiality_rank`, `entity_id`, `branch_id`, `department_id`, `folder_path`, `owner_id`, `approver_ids[]`, `revision_ordinal`, dates | Filters and facets |
| `acl_subjects text[]` | The subject ids allowed to view, materialised for filtering |
| `acl_deny_subjects text[]` | Subjects explicitly denied |
| `indexed_at`, `source_version` | Staleness detection and safe re-projection |

Weighting: `setweight(to_tsvector(…number, title…), 'A') || setweight(…tags, metadata…, 'B') || …`.
A GIN index on `tsv`, B-tree indexes on the filter columns, GIN on `acl_subjects`.

## 3. Permission filtering

The hard rule: **a user must never learn that a document exists.** That excludes fetch-then-filter,
which leaks through result counts, pagination and facets.

```sql
WHERE tenant_id = current_setting('app.tenant_id')::uuid
  AND acl_subjects && $callerSubjects           -- allowed by user, role or department
  AND NOT (acl_deny_subjects && $callerSubjects)
  AND confidentiality_rank <= $callerMaxRank
  AND tsv @@ websearch_to_tsquery($lang, $query)
```

- `acl_subjects` is computed by the same pure resolver the API uses
  ([08](./08-permission-model.md)) — one implementation, two call sites, so the index can never
  disagree with a direct read.
- An ACL change re-projects the affected subtree asynchronously. Because the index can briefly lag,
  **every result is re-checked at open time**; the index narrows, the object check decides.
- Users with `search:all` (auditors, controllers) bypass the ACL predicate but not the tenant
  predicate, and their searches are audited.

## 4. Text extraction

| Source | Producer |
| --- | --- |
| Native text (PDF, Office, TXT, HTML) | Preview pipeline's text extractor |
| Scanned images and image-only PDFs | OCR worker via `OcrPort` ([14](./14-preview-architecture.md)) |
| Metadata and tags | Directly from the record |

Extraction is asynchronous and does not block publishing. A document is findable by number, title
and metadata immediately, and by content when extraction completes; the UI shows content indexing
as pending rather than pretending it is done.

Arabic handling: normalise alef/hamza/ya forms, strip tashkeel, index both the normalised and the
original forms, use the `arabic` text-search configuration, and detect language per revision rather
than per tenant.

## 5. Query features

| Feature | Behaviour |
| --- | --- |
| Simple query | `websearch_to_tsquery` — quotes, `OR`, `-` exclusion |
| Field query | `number:QMS-*`, `type:PROC`, `status:PUBLISHED`, `approver:me`, `updated:>2026-01-01` — parsed into structured filters, never into raw SQL |
| Facets | Type, category, status, department, entity, year, confidentiality, tag — counted post-filter, so counts never leak |
| Sorting | Relevance (`ts_rank_cd`), recency, number, title |
| Pagination | Keyset (`(rank, document_id)`) — offsets degrade badly at depth |
| Saved searches | Stored per user, shareable by ACL |
| Highlighting | `ts_headline` over the stored text, permission-checked |
| Did-you-mean | Trigram similarity (`pg_trgm`) on titles and numbers |

## 6. Freshness

| Change | Target latency |
| --- | --- |
| Create, publish, metadata edit, move | < 2 s |
| ACL change on a folder subtree | < 30 s for the subtree |
| OCR of a large scan | Minutes; visibly pending |
| Full rebuild of a tenant | Offline-capable, resumable, no downtime for reads (indexes are rebuilt into a shadow table and swapped) |

Coalescing: multiple changes to one document within the debounce window produce one projection.

## 7. When PostgreSQL stops being enough

Migration triggers, monitored from the start: p95 query latency > 800 ms at expected concurrency,
index write lag > 60 s sustained, or a requirement Postgres cannot serve (semantic search,
cross-tenant analytics at scale, per-field multilingual analyzers).

Because everything goes through `SearchPort`, migrating means writing `OpenSearchAdapter`,
dual-writing during backfill, comparing results on a sample, and flipping a configuration value.
No use case and no controller changes. This is the entire reason for the port
([ADR-0008](./adr/0008-postgres-first-search.md)).

## 8. What Phase 8 built

This document was written in Phase 0; Phase 8 made it real, and this section records where the
built thing is and the three places it deliberately differs in mechanism while keeping the
contract.

§2's diagram runs: the outbox fans `document.*`, `revision.*` and `preview.*` onto
`search.index` (Phase 7's routing, unchanged), and the lane's first consumer translates each
event to the document it concerns and coalesces per document through a debounce-bucketed,
deterministic job id — §6's "multiple changes produce one projection", enforced by the queue
rather than by bookkeeping. The projection rebuilds the entry whole from current truth, so
redelivery is idempotent by construction. `search_index_entry` carries §2's shape, including
`acl_subjects` / `acl_deny_subjects` / `acl_hash` computed by `ACL_RESOLVER` — the resolver's
first real binding, forced by this phase precisely so the index and a direct read answer from
one implementation. In this generation that resolution is the tenant-level role grant
materialised as a `grant:document:view` subject token; when the ACL phase builds entries and
the walk, the resolver widens, the affected entries re-project, and §3's SQL does not change.

§3 is implemented to the letter: the predicate runs inside the query before scoring, facet
counts and totals are computed after it, `search:all` bypasses the ACL clause only and is
audited (`SEARCH_PERFORMED`), and cross-checking at open time is the document endpoints' own
gating, unchanged. §4's "content indexing pending" is served from `preview_render.state`
materialised into the entry at projection time and refreshed by the `preview.*` events — a
projection of the one status, not a second one. Arabic follows §4 exactly: normalisation in
`@edms/domain`'s `search-text.ts`, both spellings indexed, the normalised form queried, the
`arabic` configuration for stemming, language detected per revision by script counting.

The three mechanism differences, each recorded in the Phase 8 report: the rebuild's swap is an
atomic tenant-scoped `DELETE`+`INSERT` transaction rather than a table rename (the application
role does not own the tables, and a rename in a shared-database installation would swap every
tenant at once); did-you-mean is deferred with `pg_trgm` (an extension is installer surface,
and nothing yet measures the need); and saved-search sharing waits for ACL entries to exist,
because a sharing model invented before grants would be a second permission system.
