# Search module

**Answers:** How is it found?

| | |
| --- | --- |
| **Owns** | The index projection, query, permission filtering, saved and recent searches, the rebuild |
| **Depends on** | Document, Preview, Library (through `ACL_RESOLVER`) |
| **Binds in core** | `SEARCH_PORT` and `INDEX_PORT` — PostgreSQL today, an external engine later, behind the same ports. Both are bound in `infrastructure.module.ts`, the search engine underneath `TenantScopedSearch` — the Phase 2.5 isolation wrapper this phase deliberately left alone. |

## Layers

```text
search/
├── search.module.ts   composition for this module
├── domain/                    events, the field-query parser, the audit vocabulary
├── application/               the query service, the projection, the rebuild, saved searches
├── infrastructure/            the lane consumer, the source reader, Prisma repositories
└── presentation/              the /search controller
```

The dependency rule points inward, and it is enforced by `eslint.config.mjs` at the app root,
not merely described here. Other modules call this one through its **application service** or
react to its **events** — never through its repositories or its Prisma models.

## The shape, in five sentences

The **consumer** drains `search.index` — the lane Phase 0.5 declared and Phase 7 filled —
translating every `document.*`, `revision.*` and `preview.*` event into a debounce-bucketed
projection job, so five changes to one document inside the window project once. The
**projection** rebuilds one document's `search_index_entry` row whole from current truth
(idempotent under redelivery by construction), asking `ACL_RESOLVER` for the entry's
`acl_subjects` and Preview's query service for the extracted text. The **query service** pushes
the caller's visibility filter — from the *same* resolver — into the engine before scoring, so
hits, totals and facet counts can never disclose a document a direct read would refuse;
`search:all` widens past the ACL predicate only, never the tenant one, and is audited. The
**rebuild** fills the shadow table batch by batch, resumable through its state row, while
readers keep answering from the live table, then swaps atomically. **Saved and recent
searches** are one person's shortcuts, owned like favourites and audited like favourites — not
at all.

## The recorded exception

`PrismaSearchSourceReader` reads other modules' tables *as rows*: a projection's input is the
join across document, folder, library, organisation, confidentiality, metadata, revision and
approval rows, and six bespoke bulk-read services invented for one consumer would spread the
read model's shape across six modules. The discipline that matters is preserved — the reader
makes **no decision** (the ACL goes through `ACL_RESOLVER`, the text through Preview's own
query service) and writes nothing. See the Phase 8 report's decision record.

## Events published

| Type | Meaning |
| --- | --- |
| `search.document-indexed` | The read model reflects the document as of a point in time. |
| `search.rebuild-completed` | A full projection pass finished; carries the count. |
