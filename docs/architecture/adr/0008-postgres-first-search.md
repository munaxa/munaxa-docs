# ADR-0008 — PostgreSQL full-text search first, behind a search port

- **Status:** Accepted
- **Date:** 2026-07-31
- **Phase:** 0

## Context

Search must cover document number, title, metadata, tags, people, dates, status and full text
including OCR, in Arabic and English, permission-filtered, at millions of documents.

A dedicated search cluster is the obvious answer and brings a second datastore to operate, secure,
back up, keep consistent and pay for — before the product has a single customer.

## Decision

1. All search goes through a **`SearchPort`**.
2. The first implementation is **PostgreSQL**: a `search_index_entry` read model with a weighted
   `tsvector`, a GIN index, typed filter columns, and materialised ACL subject arrays.
3. The index is **projected asynchronously** from domain events through the outbox, and is
   **rebuildable from source at any time** — it is never authoritative.
4. Permission filtering is **inside the query** (`acl_subjects && $subjects`), never
   fetch-then-filter, and every result is re-checked at open time.
5. Migration triggers are defined up front: p95 > 800 ms at expected concurrency, index lag > 60 s
   sustained, or a requirement Postgres cannot serve (semantic search, per-field multilingual
   analyzers). Meeting one means writing `OpenSearchAdapter`, backfilling, comparing on a sample and
   flipping a configuration value.

## Alternatives considered

1. **OpenSearch/Elasticsearch from day one** — better text search, but a second store to secure and
   keep permission-consistent from the first line of code, plus the classic "search says it exists,
   the API says 404" class of bug. Deferred, not rejected.
2. **Meilisearch/Typesense** — excellent developer experience, weaker at the ACL-filtered,
   faceted, multi-tenant shape this product needs.
3. **`LIKE` queries against live tables** — no ranking, no OCR text, and a full scan per search.
   Rejected.
4. **No port, direct Postgres calls in use cases** — would make the eventual migration a rewrite of
   every search caller. Rejected; the port is the entire insurance policy.

## Consequences

- One datastore to operate, back up and secure for the foreseeable phases.
- The ACL fingerprint in the index is computed by the **same pure resolver** the API uses, so index
  and API cannot disagree.
- Arabic needs explicit normalisation (alef/hamza/ya forms, tashkeel) — handled in the projection,
  not left to the default configuration.
- Index maintenance cost (GIN) must be monitored; it is the first thing to degrade.
- The port's method set is deliberately narrow, so a second adapter is a week of work rather than a
  quarter.
