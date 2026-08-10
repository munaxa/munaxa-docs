# Phase 7.7B — Search Visual Composition & Populated Results

## 1. Status

**BLOCKED on the phase's own precondition.** The item the brief marks IMPORTANT NEW REQUIREMENT —
real populated Search results — cannot be produced from the existing E2E fixture, and the cause is
established with evidence rather than assumed. No Search product code was changed, so **Phase 7.7A
is intact**.

A2 and A3 were not implemented. Doing them without populated results would mean recomposing a
results hierarchy that has still never been seen with results in it.

## 2. Commit

Docs only. `apps/web/src/test/e2e/search.e2e.spec.ts` was restored byte-for-byte to its Phase 7.7A
state after the investigation — `git status` clean before commit.

## 3. Objective

Bring Search into the shared section grammar (A2), reattach the result count to the results (A3),
and produce the first real populated-results evidence.

## 4. What was attempted, and what happened

A real search was driven through the running product — real PostgreSQL 16.13, real Redis, real API,
real production web build, real login. The document number was typed into the real search field and
the real form submitted:

```
page.getByRole('searchbox').fill(fixture.documentNumber)
page.getByRole('button', { name: 'Search' }).click()
```

The screen returned **"Nothing matches that search"**.

That is a genuine result, not a flake, and Step 13's failure discipline says to diagnose it rather
than retry or relax it.

## 5. Root cause — the fixture's documents are invisible to Search by construction

Measured against the live database during and after the run:

```
select count(*) from search_index_entry;   →  0
```

And the reason, from the seeding script itself:

```
grep -nE "search_index_entry|searchIndex" scripts/e2e-signature-fixture.mjs   →  no matches
```

`seedFixture()` shells out to `scripts/e2e-signature-fixture.mjs`, which inserts the document rows
directly. It never writes `search_index_entry`, and indexing is not a database trigger — it is
application work in `postgres-index.adapter.ts`. So a fixture document exists, is listable, is
openable, appears on the dashboard's recent-documents row (Phase 7.6D proved that), and is
**structurally unfindable by Search**.

This is not a defect in the Search screen. It is a property of the fixture, and it is why the Search
baseline has only ever shown the empty state.

## 6. The two legitimate ways forward

Both are real product paths. Neither is a fixture hack, and neither fits the remaining budget of this
session:

1. **Create the document through the product's own create/upload workflow** rather than by direct
   insert, so the indexer runs as it does in production. This is the same principle Phase 7.6D used
   for recent-documents: `open()` was the real mechanism, so the test opened a document. Here the
   real mechanism is document creation.
2. **Invoke the product's search-rebuild capability.** A `search_rebuild` table exists, so the
   product owns a reindex path; driving it after seeding would make existing fixture documents
   findable. This needs its API surface checked first — I did not verify it.

Route 1 is the more faithful and the more reusable; route 2 is smaller. Either is ordinary
engineering, not research.

## 7. What was NOT done

- **A2** (Search still hand-rolls `<h2 class="text-lg font-medium">` / `<h3 class="text-sm
  font-medium">` where the product uses `Panel`/`Section`) — not implemented.
- **A3** (result count orphaned between the bar and the results) — not implemented.
- Populated result row, facets composition, saved/recent search composition — not implemented.
- Dark, RTL, live axe, keyboard traversal **for a populated Search** — not run, because there is
  nothing populated to run them against.

The empty-state Search screen retains the light and dark baselines accepted in Phase 7.7A.

## 8. Preserved

Phase 7.7A's `sm:basis-0` fix is untouched, and its regression suite still passes **7/7** against
the real stack in this session — the six-width `wrapped === (width < 640)` assertion included. The
Search E2E spec is byte-identical to its committed state.

No Arabic string, API contract, permission, facet or search semantic was altered.

## 9. Gates

| Gate | Result | Notes |
| --- | --- | --- |
| **Search E2E (7.7A suite)** | **PASS** | 7/7 against the real stack, re-run this phase |
| `pnpm format:check` | PASS | docs only |
| Everything else | NOT RUN | no product code changed; running them would report Phase 7.7A's results as this phase's |

## 10. Verified / not verified

**Verified this phase:** the real search path executes end to end against the real stack; the query
reaches the API; the response is a legitimate empty result; `search_index_entry` is empty; the
fixture script never populates it; Phase 7.7A's fix and suite still pass.

**Not verified:** anything about a populated Search screen — composition, dark, RTL, axe, keyboard,
result navigation. None of it was claimed.

## 11. Recommendation

The remaining work is ordinary engineering, and it should be one phase rather than three: make the
E2E fixture create its document through the product's real creation path (or drive the real reindex),
then implement A2 and A3 against a screen that actually has results in it, and verify with the
Phase 7.6C–E pattern that is now routine here.

Splitting further would add ceremony without adding evidence. The blocker is a fixture that predates
Search, not a design question.
