# Phase 7.7A — Search Bar Responsive Composition

## 1. Objective

Fix the confirmed Search bar defect: at every desktop width the query field took a row of its own
while the sort control, "Search" and "Save search" wrapped beneath it — so the primary action sat
apart from the field it submits. Preserve the mobile behaviour Phase 7.1 deliberately introduced.

Scope is the search bar alone. Nothing else on the screen was touched.

## 2. Initial measured layout

Measured in the running application — real PostgreSQL 16.13, real Redis, real API, real production
web build, real login — on one authenticated session resized six times.

| width | form width | field width | field top | submit top | computed `flex-basis` | wrapped |
| --- | --- | --- | --- | --- | --- | --- |
| 1440 | 1120 | **1120** | 171 | 215 | `auto` | yes |
| 1280 | 960 | **960** | 171 | 215 | `auto` | yes |
| 1024 | 704 | **704** | 171 | 215 | `auto` | yes |
| 768 | 464 | **464** | 171 | 215 | `auto` | yes |
| 640 | 592 | **592** | 171 | 215 | `auto` | yes |
| 390 | 358 | 358 | 191 | 279 | `100%` | yes |

`flex-grow: 1`, `flex-shrink: 1`, `min-width: 0px` at every width.

## 3. Root cause — and the Phase 7.7 hypothesis was wrong

Phase 7.7 suspected a specificity fight between `flex-1`, `basis-full` and `sm:basis-auto`, and said
the cause was unestablished. The measurement disproves it: **computed `flex-basis` is `auto` at
1440, 1280, 1024, 768 and 640** — `sm:basis-auto` was applying correctly the whole time.

The real cause is one line above, in the platform:

```
Input → "w-full rounded-md border border-input bg-transparent px-3 …"
```

`flex-basis: auto` resolves the flex base size from the `width` property, and `width` is `100%`. So
the field's base size *was* the entire form. It filled the flex line on its own and every sibling
wrapped beneath it. The measurement shows this exactly: **field width equals form width to the
pixel** at all five desktop widths — 1120/1120, 960/960, 704/704, 464/464, 592/592.

`basis-full` was never the problem, and neither was specificity.

## 4. The minimal fix

One class:

```diff
- className="min-w-0 flex-1 basis-full sm:basis-auto"
+ className="min-w-0 flex-1 basis-full sm:basis-0"
```

`basis-0` gives the field a flex base size of zero, so the sort control and buttons are laid out at
their natural widths and the field grows into the remainder — the ordinary flex idiom for "fill the
rest of the row".

No pixel value, no new breakpoint, no new token, no component, no JS viewport detection, and no
override of the platform's `w-full`. `sm:basis-0` is generated into the built stylesheet by Tailwind
on use (verified present after the rebuild).

## 5. Why the 390px behaviour is preserved

`basis-full` is untouched and still governs below `sm` (640px). The variant only replaces what
happens *above* it. Measured after the fix: at 390 the field's computed basis is still `100%`, it
still takes its own line (`fieldTop` 191 vs `submitTop` 279), and no control leaves the viewport.

That is the state Phase 7.1 created to stop "Save search" hanging 24px past a 390px viewport, and
the regression test now asserts it explicitly rather than leaving it to chance.

## 6. Six-width evidence, after the fix

| width | form width | field width | field top | submit top | `flex-basis` | wrapped |
| --- | --- | --- | --- | --- | --- | --- |
| 1440 | 1120 | 851.6 | 171 | **171** | `0px` | **no** |
| 1280 | 960 | 691.6 | 171 | **171** | `0px` | **no** |
| 1024 | 704 | 435.6 | 171 | **171** | `0px` | **no** |
| 768 | 464 | 195.6 | 171 | **171** | `0px` | **no** |
| 640 | 592 | 323.6 | 171 | **171** | `0px` | **no** |
| 390 | 358 | 358 | 191 | 279 | `100%` | **yes** (intended) |

`scrollWidth <= clientWidth` asserted and passing at every width. Every form control asserted inside
the viewport horizontally at every width.

The 1280 screenshot was **inspected at 2×**: query field, `Relevance ▾` and `Search` on one line,
the field taking the space the others do not need. ("Save search" is `searched`-gated and correctly
absent from the initial state.)

## 7. Regression test

`apps/web/src/test/e2e/search.e2e.spec.ts` — new, 7 tests, against the real stack.

It measures the field and the submit button at all six widths and asserts:

- **`wrapped === (width < 640)`** — one row above `sm`, its own row below it. Sharing a top edge is
  what "one coherent search interaction" means as a number rather than an impression, and the 390
  case asserts the *opposite* on purpose, so a future desktop fix that quietly undid Phase 7.1 is
  caught.
- every form control sits within the viewport horizontally.
- `scrollWidth <= clientWidth`.

## 8. Test-proof

`sm:basis-0` was reverted to `sm:basis-auto`, the web app rebuilt, and the suite re-run:

```
× measures the search bar at 1440px → the query field should share a row with Search at 1440px: expected true to be false
× measures the search bar at 1280px → … at 1280px
× measures the search bar at 1024px → … at 1024px
× measures the search bar at  768px → … at 768px
× measures the search bar at  640px → … at 640px
```

Five desktop widths failed with the exact defect message; **390 correctly continued to pass**, which
is the discriminating result — a test that failed there too would be asserting the wrong thing.

The fix was restored, the app rebuilt, and the suite re-run: **7/7 pass**. No assertion was weakened.

## 9. Gates

| Gate | Result | Notes |
| --- | --- | --- |
| `pnpm format:check` | PASS | |
| `pnpm lint` | PASS | 13/13 |
| `pnpm typecheck` | PASS | 13/13 |
| `pnpm --filter @edms/web build` | PASS | rebuilt three times (fix, revert, restore) |
| **Search E2E** | **PASS** | **7/7** against the real stack |
| `pnpm test` | PASS | 13/13 |
| `pnpm verify:styles` | PASS | 10/10 |
| `pnpm test:visual` | PASS | 93 pass / 10 fail — all ten the **pre-existing** Arabic-font surfaces |

## 10. Found but intentionally not fixed

Per §6, recorded and left for Phase 7.7B:

- **A2** — Search still hand-rolls `<h2 class="text-lg font-medium">` and `<h3 class="text-sm
  font-medium">` where the rest of the product uses `Panel`/`Section`.
- **A3** — the result count renders orphaned and centred between the bar and the results.
- **New, D** — `Input`'s `w-full` making `basis-auto` unusable inside a flex row is a sharp edge any
  product composing a search bar will hit. Not a defect (the class is right for the common case),
  but worth a note upstream: a documented recipe, or an `Input` that does not assume full width,
  would save the next team this measurement.
- The `search-light` baseline still shows only the **empty-results** state; the populated result row
  has never been inspected.

## 11. Baselines changed

`search-light` and `search-dark`. The visual suite first reported **12** failures — the ten known
Arabic-font surfaces plus these two, which is the change this phase intended. Both were **opened and
inspected** before acceptance: the static baseline now shows
`[ manual … ] [Relevance ▾] [Search] [Save search]` on one line, the full target composition
including the save affordance the running-app screenshot could not show (it is `searched`-gated and
absent from the initial state). Accepted on what they show. After acceptance the suite returned to
the expected ten.

## 12. Status

**COMPLETE.**

Everything the phase's completion criteria name about the defect itself is met: the desktop wrap is
fixed at 1440/1280/1024, 768/640/390 remain usable, there is no horizontal overflow at any width,
Search and Save search remain reachable, the regression test detects the defect, and the fix passes
in the real running application.
