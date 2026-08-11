# Phase 7.6 — Priority Screen Visual Modernization

**Verdict: PARTIALLY COMPLETE.** One of five priority screens materially changed. The Step 0
reconnaissance is complete for all five and is the larger deliverable here. Do not read this as a
finished modernization.

---

## 1. Executive summary

The phase asked for five screens plus Chromium driving, six widths each, RTL in both themes, axe and
E2E. What is delivered is the complete reference-to-product mapping (§5), one shipped and fully
inspected change, and an honest account of what was not reached.

The decision to stop short was deliberate. Producing five shallow screen edits and asserting
verification I had not performed would have violated "do not manufacture evidence" — the one
instruction in this brief that cannot be traded against the others.

---

## 2. Screens changed

### 2.1 Document Library — the primary action promoted to the page header

`ResourceList` renders `onCreate` as the last control in its `Toolbar`, beside the search box, the
deleted filter, the "Include subfolders" switch, "Scan documents" and the column menu. That is the
right place for a *list* control and the wrong place for the screen's primary action: the one thing
a reader comes to the library to do sat in a row of six things that change what they are looking at,
at identical weight.

`PageHeader` has carried an `actions` slot since the platform shipped it, and `WorkspacePage` has
passed it through since Phase 7 — four screens used it and the library, which has the strongest
claim on it, was not one of them.

**Before / after, both inspected as rendered images:**

| | Before | After |
| --- | --- | --- |
| Primary action | last item in a six-control toolbar row | top-right of the page header, aligned with the title |
| Toolbar | six controls, wrapping "Columns" onto a second line | five, cleaner wrap |
| 390px | inside the wrapping toolbar | stacked under the description by `PageHeader` itself |

No new label was added: the button reuses `admin.actions.create`, the exact key `ResourceList` used,
so the wording and its reviewed Arabic are byte-identical to before.

**Platform components reused:** `PageHeader.actions` (via `WorkspacePage`), `Button`, `Plus` from
`@munaxa/icons`. **New components:** none. **New tokens, colours, radii, shadows, font sizes,
breakpoint values:** none.

### 2.2 Screens not changed

Dashboard, Global Search, Document Record, Upload/Add Document. §5 records what each would need.

---

## 3. Step 0 — platform capability, verified by reading the installed types

Not assumed. Read from `node_modules/.pnpm/@munaxa+platform@1.0.0/.../dist`.

| Component | Relevant API |
| --- | --- |
| `PageHeader` | `title`, `description`, `above`, `actions`, `level`, `align` |
| `Section` | `title`, `description`, `actions`, `gap` |
| `Panel` | `title`, `actions`, `footer`, `scrollBody`, + all `Surface` props |
| `Surface` | `tone` (card/muted/transparent), `elevation`, `bordered`, `padding`, `radius`, `as` |
| `Grid` | `cols` (responsive), `gap`, `gapX`, `gapY` |
| `Stack` / `Inline` / `Cluster` | `direction`, `gap`, `align`, `justify`, `wrap` |
| `Toolbar` | `children`, `actions`, `label`, `sticky` |
| `Tabs` | controlled: `value`, `onValueChange`, + `TabsList` / `TabsTrigger` / `TabsContent` |

`Panel.actions` and `Section.actions` are both unused by the product and are the two slots most of
the remaining work would use.

---

## 4. The search-tabs question, answered from the contract

Step 3 asked whether platform `Tabs` should carry All / Documents / Folders / Metadata / OCR.

**It should not, because the data does not exist.** `searchResultsSchema` returns `data:
SearchHit[]`, and `searchHitSchema` is a *document* hit throughout — `documentId`, `documentNumber`,
`revisionOrdinal`. There is no folder result, no metadata result and no OCR result. `bodySource:
'TEXT' | 'OCR'` is a per-hit attribute, not a result category, and `facets` is
`Record<string, FacetBucket[]>` — dimension buckets such as status and library, not result types.

Rendering those five tabs would mean inventing four categories and their counts. Refused under §7
and the step's own instruction.

**What is real and unused:** `meta.total` is an exact count, so the reference's prominent "1,256
results found for …" line is fully backed and remains available work.

---

## 5. Reference-to-product mapping

| Reference element | Current | Platform available? | Real data? | Verdict |
| --- | --- | --- | --- | --- |
| Library primary action in header | toolbar | `PageHeader.actions` | n/a | **DONE** |
| Header bell + count | — | `TopBar.actions` | yes | done in 7.5 |
| Search result-count hierarchy | small | `PageHeader`/`Section` | `meta.total` | remaining |
| Search result-type tabs | — | `Tabs` | **no** | **refused — §4** |
| Search facet composition | bespoke `Card` rail | `Panel`, `Section.actions` | facets real | remaining |
| Dashboard KPI grouping | flat 7-tile `Grid` | `Section`, `Grid`, `StatCard` | counts real | remaining |
| Dashboard status donut | definition list | charts family | breakdown real | deferred — replaces reasoned work |
| Dashboard KPI deltas | — | `StatCard.delta` | **no** | **refused** |
| Dashboard storage quota bar | — | `Progress` | **no quota** | **refused** |
| Library folder info panel | — | `Panel` | identity only | partly blocked |
| Library folder totals / size / permissions | — | — | **no** | **refused** |
| Library file-type marks | `FormatBadge` | — | yes | already exists |
| Upload two-column fields | single column | `Grid` | n/a | remaining |
| Upload prominent dropzone | `Dropzone` | `Dropzone` | n/a | remaining |
| Record composition | Phase 7.2/7.3 grammar | `Panel` | yes | remaining |
| Entity / Branch switcher | — | — | **no session entity** | **refused** |
| Rail badges (Approvals/Tasks) | — | `NavigationItem.badge` | **13 queries/nav** | **blocked** |
| Rail section headings | off | — | — | **blocked — contrast 2.78:1** |
| Person's name in account chip | UUID | `UserMenu` | **no name on /auth/me** | **blocked** |

---

## 6. Performance

No request was added. The one change moves an existing button between two containers in the same
component tree. Page-load fan-out is unchanged for the workspace layout, the dashboard and the
record page. §12 satisfied by not spending anything.

---

## 7. Verification actually performed

| Check | Result |
| --- | --- |
| `pnpm format:check` | pass |
| `pnpm lint` | pass 13/13 |
| `pnpm typecheck` | pass 13/13 |
| `pnpm test` | pass 13/13 |
| `pnpm test:visual` | 88 pass, 10 fail — all ten the pre-existing Arabic-font surfaces |
| Library light 1280 | **inspected before and after** as images |
| Library dark 1280 | **inspected** — action and toolbar correct |
| Library 390 | **inspected** — action stacks under the description, reachable, no overflow |
| Library tablet | baseline regenerated and accepted |

Baselines changed: `document-list-light`, `document-list-dark`, `document-list-tablet`,
`document-list-mobile`. Each was diffed, rendered and looked at before acceptance — not accepted
because a number moved.

### What was NOT verified — do not read past this

- **The running application was never driven in Chromium** (§10). Verification is the static-render
  harness. None of the five workflows were exercised end to end.
- **1440 / 1024 / 768 / 640 were not inspected** (§7). Only 1280, tablet and 390 have baselines.
- **RTL was not visually checked for this change** (§8). The classes are logical and `PageHeader`
  owns the placement, but no Arabic baseline covers the library header.
- **axe was not run against the library screen specifically.** The suite-wide a11y tests pass and
  nothing in this change adds an interactive element — the button existed already — but that is an
  argument, not a measurement.
- **No new test was added.** The change is a composition move with no new behaviour; the honest
  consequence is that nothing would catch the button silently reverting to the toolbar except the
  four baselines, which would.

---

## 8. Findings by severity

**High — blocked, needs a decision outside this phase**

1. Rail badges need a cheap approval count endpoint (`GET /dashboard` = ~13 round-trips across 8
   modules; unusable from a layout).
2. `SidebarNav` group headings measure 2.78:1 — the product's section headings stay off, and the
   reference's visible headings are unreachable until fixed upstream.
3. `/auth/me` exposes no display name, so the account chip shows a raw UUID.

**Medium — platform gaps**

4. No overlay-count primitive (from 7.5).
5. `DataGrid` has no responsive strategy — the library compensates by dropping columns via
   `useMediaQuery`, recorded since Phase 7.1.

**Refused — would require fabricating data**

6. KPI deltas · storage quota bar · entity/branch switcher · Expiring Soon tile · search result-type
   tabs and their counts.

---

## 9. Verification commands

```
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm --filter @edms/web build
pnpm --filter @edms/web test:visual
```

---

## 10. Acceptance criteria

| Criterion | Status |
| --- | --- |
| Dashboard materially improved | **NO** |
| Documents/Library materially improved | YES |
| Search materially improved | **NO** |
| Document Record materially improved | **NO** |
| Upload materially improved | **NO** |
| No local design system | YES |
| Shared platform components used | YES |
| No fabricated business data | YES |
| No API/schema/permission/workflow change | YES |
| No performance regression | YES — nothing added |
| All five verified in real Chromium | **NO** |
| All five verified at 390px | **NO** — library only |
| Required desktop widths checked | **NO** — 1280 only |
| Arabic/RTL verified | **NO** |
| Light and dark verified | library only |
| Accessibility verified | **NO** — not for this screen specifically |
| Baselines inspected manually | YES |
| No tests weakened | YES |
| Report written and indexed | YES |
| Committed and pushed, no PR | YES |

**Verdict: PARTIALLY COMPLETE.** Four of the five priority screens are untouched and most
verification criteria are unmet. The remaining work is well-specified by §5 and unblocked except
where marked.
