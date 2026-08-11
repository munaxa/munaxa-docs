# Phase 7.7 — Search Visual Modernization

## Status

**BLOCKED — audit only, no implementation.** The audit is complete and carries real findings. No
product code was changed. The blocker is session budget, not the repository: implementing the
findings *and* producing the running-app, RTL, dark, axe, keyboard and E2E evidence this phase
mandates does not fit in the remaining budget, and shipping the change without that evidence is what
§"Do not manufacture evidence" exists to prevent.

## Objective

Bring Search to the visual quality established by the completed Library and Dashboard work.

## Audit Findings

### A1 — the search bar breaks across two lines (CONFIRMED, A)

Rendered at 1280, the primary interaction is split:

```
[ query field, full width                                    ]
[ Relevance ▾ ] [ Search ] [ Save search ]
```

The query field takes a line of its own and the action that operates on it sits on the next. The
primary control is visually detached from its input — the single most important hierarchy problem
on the screen.

The cause is in `search-screen.tsx`:

```
className="min-w-0 flex-1 basis-full sm:basis-auto"
```

`basis-full` is deliberate and documented — Phase 7.1 added it to fix a real 390px overflow where
"Save search" hung 24px past the viewport. `sm:basis-auto` was meant to undo it above 640px, and the
1280 render shows it is **not** taking effect.

**Evidence gathered:** `sm\:basis-auto` *is* present in the built stylesheet, so this is not a
missing-class problem. `.flex-1{flex:1}` expands to `flex-basis: 0%`, so three rules compete for the
same property. Which wins depends on source order in the compiled sheet, which I did not finish
measuring.

**Classification: A for the symptom, F for the cause.** The wrap is real and visible. The precise
reason needs a browser measurement of computed `flex-basis` at 1280 — not a source reading. It must
not be "fixed" by adding an arbitrary width, because the 390px overflow Phase 7.1 fixed is real and
would come back.

### A2 — the Phase 7.2/7.3 section grammar was never applied to Search (CONFIRMED, A)

Every other screen was moved to `Panel` / `Section`. Search still hand-rolls headings:

```
<h2 className="text-lg font-medium">   saved searches, recent searches
<h3 className="text-sm font-medium">   each facet group
<Card className="flex flex-col gap-1 p-3">   facet container
```

`text-lg font-medium` is not the heading treatment `Panel` produces (`font-display text-sm
font-semibold`), so Search's section headings differ from the rest of the product. This is the same
defect class Phases 7.2 and 7.3 fixed elsewhere; Search was missed.

### A3 — the result count is orphaned (CONFIRMED, A)

"0 of 0 results" renders centred in open space, disconnected from both the search bar above and the
results below. §5 asks for the quantity to be immediately understandable; centred small text between
two regions is the weakest available placement.

### E1 — the reference's right-hand tool rail is largely unbacked (E)

Of the reference's Search Tools / Saved Searches / Recent Searches / Search Tips / Index Status:
**Saved Searches and Recent Searches are real** (`SavedSearch`, `RecentSearch` contracts, with
create/delete actions). Search Tips and Index Status have no backing data. Advanced Search exists
only as the `search.syntaxHint` line.

### E2 — result-type tabs cannot be built (E, previously established)

Re-confirmed from the contract: `searchHitSchema` is a document hit throughout; `bodySource:
'TEXT' | 'OCR'` is a per-hit attribute, not a category; `facets` are dimension buckets. The
reference's All / Documents / Folders / Metadata / OCR tabs would require inventing four categories
and their counts. **Refused.** `meta.total` is real and usable for the overall count.

### D1 — no confirmed platform gap

Nothing in the audit yet requires a primitive the platform lacks. A1 and A2 are both expressible
with existing components.

## Platform Primitives Inspected

Read from the installed typings during this and prior phases: `Page`, `PageHeader` (`title`,
`description`, `above`, `actions`, `level`, `align`), `Section` (`title`, `description`, `actions`,
`gap`), `Panel` (`title`, `actions`, `footer`, `scrollBody`, + `Surface` props), `Surface`, `Grid`,
`Stack`/`Inline`/`Cluster`, `Toolbar` (`actions`, `label`, `sticky`), `Tabs` (controlled).

`Panel.actions` and `Section.actions` remain unused product-wide and are where A2's fix belongs.

## What Was NOT Done

No code changed. No baseline regenerated. No running-app, RTL, dark, axe, keyboard or E2E evidence
gathered for Search. The current `search-light` baseline shows the **empty-results** state only, so
the populated result row has never been inspected at all — the same gap the dashboard had before
Phase 7.6D, and the reason A-findings below the search bar are thin.

## Recommendation

Split into two phases, in this order:

**7.7A — the search bar.** Measure computed `flex-basis` at 1280 and 390 in the running app, fix the
wrap without reintroducing the 390 overflow, verify at all six widths. Small, self-contained, and
the highest-value fix on the screen.

**7.7B — composition.** A2 and A3, plus a populated-results baseline and the full RTL/dark/axe/E2E
package, following the Phase 7.6C–E pattern that is now proven to work: start PostgreSQL and Redis
from the installed binaries, use `startServers` + `signInAndCapture`, one session, resize the same
page, inject axe-core.

Infrastructure is not a blocker — 7.6C established the procedure and 7.6E exercised it end to end.
