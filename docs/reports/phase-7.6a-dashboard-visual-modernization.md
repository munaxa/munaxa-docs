# Phase 7.6A — Dashboard Visual Modernization

**Verdict: PARTIALLY COMPLETE.** The dashboard is materially improved and a real defect was found
and fixed, but the running application was not driven in Chromium and four of the six required
widths were not inspected. §12 lists every unmet criterion.

---

## 1. Objective

Make the dashboard more modern, premium and intentional using only data the product already
returns, and only components the platform already ships.

---

## 2. The audit found its findings by *looking*, not by reading

The single most useful step was rendering the existing baseline and opening the image. Three
problems were visible immediately that source inspection across two prior phases had not surfaced:

1. **Raw translation keys on screen.** The Users tile read `dashboard.admin.userState.DRAFT` and the
   Workflow tile `approvals.instanceDRAFT` — internal key paths printed on a dashboard.
2. **A ragged KPI row.** Seven tiles in a four-column grid is 4 + 3, so "My work" ended in a gap the
   width of a card. The screen opened on something that read as unfinished.
3. **A second ragged row.** Five Organisation counts in a four-column grid is 4 + 1, leaving a lone
   tile that reads as a card that failed to load.

None of these are subtle. All three had survived Phases 7, 7.1, 7.2, 7.3 and 7.5.

---

## 3. Changes implemented

### 3.1 The translation-key leak — a real defect, fixed and tested

The three breakdown tiles build their keys from values the API returned:

```
documents.status.${key}   approvals.instance${key}   dashboard.admin.userState.${key}
```

`MessageKey` there is a **cast, not a guarantee** — this is the only place in the product where a
key is computed from data rather than written as a literal, so the compiler cannot help. And
`translate` answers a miss with the key itself (`translate.ts`, `return key`), which is right for a
literal a developer sees in review and wrong for a value arriving at runtime.

The catalogue holds `userState.ACTIVE|INVITED|DISABLED` and
`instanceRUNNING|PAUSED|COMPLETED|REJECTED|CANCELLED`. Any value outside those sets — a status
shipped before the catalogue learns it — reached the reader as an internal path.

Fixed with a `labelled(key, fallback)` helper that returns the enum value when the lookup misses.
`SUSPENDED` is not English and does not pretend to be, but it names the thing being counted rather
than describing how the product failed to name it. The catalogue remains the real fix.

**Scope note:** this is a product defect, not a visual one, but it manifests *only* as text on the
dashboard, and the fix is four lines inside the dashboard feature. No i18n package change, no
contract change.

### 3.2 KPI grouping — two complete rows instead of one ragged one

"My work" split by whether a number is a claim on the reader's time:

| Row | Tiles | Columns |
| --- | --- | --- |
| Waiting on you | Awaiting my decision · Overdue · Rejected | `{base:2, md:3, xl:3}` |
| What you hold | Drafts · Checked out · Favourites · Unread | `{base:2, md:4, xl:4}` |

Both rows divide evenly at every breakpoint, so the gap is gone as a *consequence of the grouping*
rather than by padding the row with a tile that had no reason to exist. The three actionable figures
are now wider and read first.

**Deliberately one `Section` and no second heading.** A heading needs a translated string, and
inventing Arabic for it is what Phase 7.4C established must not happen. The grouping is carried by
the gap between the rows, which `Section`'s own rhythm already provides.

### 3.3 Organisation counts — five columns for five tiles

`Columns` includes `5` (checked in `scales.d.ts`), so `{base:2, md:3, xl:5}` simply fits. Nothing
padded, no tile invented.

**Measured effect:** the dashboard is **1070 → 988px tall**, 82px shorter, with nothing removed.

---

## 4. Platform components used

`Page`, `PageHeader`, `Section`, `Grid`, `StatCard` (via `CountStat`), `Card`, and `@munaxa/icons`.
**No new component. No new token, colour, radius, shadow, font size or breakpoint value.** The only
values touched are `Grid.cols`, using members of the platform's own `Columns` union.

---

## 5. Reference-to-product mapping

| Reference element | Real data? | Verdict |
| --- | --- | --- |
| KPI row of five | counts real | **DONE** — regrouped 3 + 4 by urgency |
| KPI percentage deltas | **no** | refused — no period-on-period figure exists |
| Storage quota bar / % | **no quota** | refused — `storageTileSchema` has no denominator |
| Expiring Soon | **not exposed** | refused |
| Entity / Branch switcher | **no session entity** | refused |
| Status donut | breakdown real | **not implemented** — see §6 |
| Recent Documents as primary table | real | **not implemented** — see §10 |
| Favorite Folders | folders not on the payload | refused — dashboard returns favourite *documents* |
| My Tasks panel | counts real | partly — the three attention tiles are this |

---

## 6. The donut, deliberately not built

Step 4 asked me to evaluate rather than assume. The data is real (`breakdownTileSchema`) and the
platform ships a chart family. I did not build it.

The existing definition list gives an exact number per status, aligned and scannable, and translates
cleanly. A five-slice donut of enum counts adds a shape but takes away the numbers' alignment, and
Phase 7.5 already reasoned this through and left a comment saying so. Replacing working, explicitly
argued composition with a different valid one is what "do not chase perfection" warns against.

What the list *did* need was the key-leak fix in §3.1 — which is what was actually wrong with it.

---

## 7. Performance

**No request added. No request changed.** The dashboard's data comes from one `GET /dashboard` call
made by the route, exactly as before; every change is arrangement of props already in hand. Nothing
moved into the workspace layout. §12's fan-out constraint is satisfied by spending nothing.

---

## 8. Tests

New: `apps/web/src/features/dashboard/status-labels.spec.tsx`, 3 tests —
translates a known status · falls back to the value for an unknown one · **never renders a key path**
(asserted on the dotted-namespace *shape*, so it catches any of the three key families).

**The test was proved to fail.** With the fix reverted, 2 of 3 fail; restored, 3 of 3 pass. A
regression test that has never failed is not evidence, and this one was checked rather than assumed.

**A second thing worth recording:** the test passed under vitest while `tsc` rejected it —
`BreakdownTile` requires `total`, which the fixture omitted. The same suite-is-not-the-gate lesson
Phase 7.4C recorded, hit again in this phase.

No test weakened, skipped, or given a wait.

---

## 9. Verification — RUN / PASS / FAIL / NOT RUN

| Gate | Status |
| --- | --- |
| `pnpm format:check` | RUN — PASS |
| `pnpm lint` | RUN — PASS 13/13 |
| `pnpm typecheck` | RUN — PASS 13/13 (**failed first**, see §8) |
| `pnpm test` | RUN — PASS 13/13, including the 3 new tests |
| `pnpm verify:styles` | RUN — PASS 10/10 |
| `pnpm test:visual` | RUN — 88 pass / 10 fail, all ten the **pre-existing** Arabic-font surfaces |
| `responsive.spec.tsx` | RUN — PASS 24/24 |
| axe (dashboard) | RUN — PASS, via `screens.a11y.spec.tsx` in `pnpm test` |
| Dashboard E2E | **NOT RUN** |
| Chromium running app | **NOT RUN** |

Baselines changed: `dashboard-light`, `dashboard-dark`. Both **opened and inspected**, plus a
zoomed crop of the Organisation section to confirm the five-column row. Accepted on what they show,
not on a diff count.

---

## 10. What was NOT done — read this before believing the phase

- **The running application was never driven in Chromium** (Step 13, an explicit *MUST* of this
  brief). Evidence is the static-render harness only. Dashboard load, real data, interactions and
  console/server errors are **unverified**.
- **Widths 1440, 1024, 768 and 640 were not inspected** (Step 9). Only 1280 has a dashboard
  baseline. The `responsive.spec.tsx` suite passes but does not cover the dashboard at those widths.
- **390px was not inspected for the dashboard.** There is no mobile dashboard baseline; I did not
  add one.
- **Arabic/RTL was not verified for the dashboard** (Step 10). No Arabic dashboard baseline exists.
  The change adds no physical direction — `Grid.cols` is logical — but that is an argument, not a
  measurement.
- **Recent Documents was not improved** (Step 3). It remains two short `ListCard`s with one row each,
  which is the weakest area of the screen and the largest remaining opportunity.

---

## 11. Findings and remaining work

**Defect fixed:** translation key paths rendered to the reader (§3.1).

**Product gap, unchanged:** the dashboard exposes favourite *documents*, not favourite *folders*, so
the reference's folder panel has no data.

**Platform gaps, unchanged from 7.5:** no overlay-count primitive; `SidebarNav` heading contrast
2.78:1; no cheap approval-count endpoint; `/auth/me` carries no display name.

**Remaining dashboard work:** Recent Documents prominence · a mobile baseline · an Arabic baseline ·
Chromium verification · the four unchecked widths.

---

## 12. Completion criteria

Met: materially improved · real data only · platform components only · no local design system · no
fabricated metric, quota, delta or switcher · no API fan-out · axe passes · behaviour intact · tests
added and proved to fail · baselines inspected manually · no tests weakened · report written and
indexed · tree clean · committed · pushed · no PR.

**Not met:** Chromium verification · 1440 · 1024 · 768 · 640 · 390 · Arabic RTL.

**Verdict: PARTIALLY COMPLETE.**

---

## 13. Commands executed

```
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm verify:styles
pnpm --filter @edms/web build
pnpm --filter @edms/web test:visual
pnpm --filter @edms/web exec vitest run --project browser src/test/responsive.spec.tsx
pnpm --filter @edms/web exec vitest run --project a11y src/features/dashboard/status-labels.spec.tsx
```
