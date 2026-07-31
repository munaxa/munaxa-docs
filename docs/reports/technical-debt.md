# Technical Debt Report — Phase 0

**Purpose:** issues found while analysing the repository for Phase 0, and what to do about them.
**Audience:** repository owner, Phase 0.5 engineers.
**Status:** point-in-time report, 2026-07-31. Not edited afterwards.

Phase 0 changed no code. Everything here is a finding, with a recommendation and an owner. Items
marked **Docs** are for this product to handle in Phase 0.5; items marked **Repo** need an owner
outside this product.

## Findings

### D1 — The root `prisma` configuration is School-specific · Repo · Medium

`package.json` sets `"prisma": { "schema": "school/prisma/schema.prisma" }` and defines
`prisma:generate` / `prisma:migrate` / root-level `prisma` and `@prisma/client` dependencies. With a
second Prisma-backed product, `pnpm prisma:generate` becomes ambiguous — it will silently mean
"School" while reading as "the repository".

**Recommendation:** move Prisma dependencies and scripts into each product's API package, and make
root scripts explicit (`prisma:generate:school`, `prisma:generate:docs`) or drop them in favour of
`pnpm --filter <app> prisma:generate`. Munaxa Docs will own its schema and scripts inside
`@edms/api` regardless, so the root shortcut is the only thing to fix.

### D2 — Stray tracked file at `ui/components/files/index.ts` · Repo · Low

A tracked file sits at the repository root outside every workspace member, re-exporting `Dropzone`
and `FileManager` from `./dropzone.js` / `./file-manager.js` — files that do not exist there. The
real components are in `platform/ui/components/files/`. It came in with commit `f608f38`
("Phase 9b: files, flow editors and query builders").

**Recommendation:** delete `ui/` at the root. It resolves to nothing, and a second `files` barrel is
precisely the duplication signal the standards exist to catch. **Munaxa Docs must not import it.**

### D3 — Root `README.md` product table will be stale after Phase 0 · Repo · Low

The table says Docs has "Theme authored, no product root yet". Phase 0 creates `edms/` with the
design set.

**Recommendation:** update the row in the same commit as this phase. (Done — see the Phase 0
commit.)

### D4 — Repository documentation index does not yet list this product · Repo · Low

`docs/README.md` states that a document not linked from it is invisible.

**Recommendation:** add a Munaxa Docs section. (Done — see the Phase 0 commit.)

### D5 — `docs/` means two things · Repo · Medium

`docs/` is the repository documentation index, but the product is called Docs and its theme is
`docs`. Phase 0 works around this by naming the product root `edms/`
([ADR-0001](../architecture/adr/0001-product-root-placement.md)).

**Recommendation:** the owner decides before Phase 0.5 whether to keep `edms/` or move the index and
free `docs/`. Renaming a documentation tree now is cheap; renaming it after `@edms/*` packages, a
Prisma schema and migrations exist is not.

### D6 — No shared queue, storage, search or mail abstraction exists in the repository · Repo · Informational

School calls the S3 SDK directly and has no queue, search or mail port. Redis is in
`docker-compose.yml` but nothing consumes it.

**Recommendation:** none for School. Munaxa Docs builds ports for all four
([02](../architecture/02-backend-architecture.md)). If a third product later needs the same, the
*pattern* is shared by reading — the code is not, and promotion to the platform is not an option,
since these are backend concerns and the platform is a UI layer.

### D7 — School's `documents` module shares a name with this product · Repo · Low

`school/apps/api/src/documents` generates PDFs from templates. The word "documents" now means two
unrelated things across the repository, which is a live source of confusion for engineers and for
AI agents searching the codebase.

**Recommendation:** no rename (it is School's established name and a rename is churn), but the
distinction is stated in [the domain model](../architecture/03-domain-model.md) and in the
repository index entry added by this phase.

## Debt this phase deliberately accepts

| Accepted | Why | When to revisit |
| --- | --- | --- |
| Postgres-based search rather than a search engine | One datastore to operate; triggers for migration are defined | Search p95 > 800 ms or index lag > 60 s ([ADR-0008](../architecture/adr/0008-postgres-first-search.md)) |
| Modular monolith rather than services | One transaction per user action; module boundaries make extraction mechanical | One module's load profile diverges sharply |
| Tenancy, API scaffolding and permission catalogue re-implemented rather than shared with School | Products may never import one another — a deliberate, documented cost | Never; the rule is the architecture |
| Preview and OCR behind ports with a single implementation each | Solves today's problem without a speculative plugin framework | A second real implementation of either |
| No workflow designer UI | The engine already takes definitions as data | Phase 16 |

## What is explicitly not debt

The absence of code under `edms/apps` and `edms/packages` is not debt — Phase 0's brief is design
only, and Phase 0.5 builds the skeleton. The absence of migrations is likewise deliberate: the
brief says design the schema and do not generate migrations yet.
