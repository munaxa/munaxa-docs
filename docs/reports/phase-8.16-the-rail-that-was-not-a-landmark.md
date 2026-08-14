# Phase 8.16 — The Rail That Was Not a Landmark

## 1. Status

**COMPLETE.** Released as 1.5.0, verified on the registry, and consumed by Docs from it.

The measurement went looking in three places nothing had ever looked — the writing direction, the
parameterised routes, and a session with different permissions — and all three came back **clean**.
That negative result is what made the fourth finding the objective: with everything else measured
and green, one moderate violation was left, and it was on **100% of the product's pages, in both
themes, for three releases**. Phase 8.12 put it there.

## 2. Objective

Find the next highest-value confirmed problem in the current repository, fix it at the owning layer,
and prove the fix.

## 3. Starting state, verified rather than assumed

| | Reported by 8.15 | Measured here |
| --- | --- | --- |
| Platform `main` | `88b39f1` | `88b39f1` ✓ |
| Docs HEAD | `87c5a6a` | `87c5a6a` ✓ |
| Published / installed | 1.4.3 | 1.4.3 ✓ |
| Dependency range | `^1.4.3` | `^1.4.3` ✓ |
| `@munaxa/ui` | three-line façade → single platform copy | **re-verified**: 3 lines, `export * from '@munaxa/platform'`, resolves to 1.4.3, **1** copy in the store ✓ |
| Stories | 106 | 106 ✓ |
| Contrast · keyboard · overlays | 848 · 848 · 74 | **848/848 · 848/848 · 74, 0 violations, 0 errors** ✓ |
| Both trees | clean | clean ✓ |

## 4. Fresh baseline — including the negatives

### 4.1 Writing direction — never measured, and clean

`preview.tsx` defines a first-class `direction` global (`ltr` / `rtl`, described there as "a global
toolbar control rather than a per-story prop"). The harness builds
`?id=…&globals=brand:B;scheme:S` — **direction is never passed**, so all 848 combinations are LTR.
Munaxa Docs ships Arabic (`TEXT_DIRECTION.ar === 'rtl'`), and the platform source is full of
RTL-specific logic: logical properties, `rtl:-scale-x-100` mirrored transforms, direction-following
flex.

All 106 stories were rendered in both directions with the full ruleset:

| | LTR | RTL |
| --- | --- | --- |
| axe violations | 0 | **0** |
| pages with horizontal scroll | 0 | **0** |
| overflowing elements | 218 | **123** |
| `dir` attribute | `ltr` | `rtl` |

**No defect.** The direction global works and the RTL logic holds. Recorded as a measured negative,
not as a coverage gap to be filled: doubling the matrix to re-assert a clean dimension would buy
runtime and nothing else.

### 4.2 Parameterised routes and role-dependent composition — never measured, and clean

Eleven measurements: three parameterised routes as the signer, and five static plus three
parameterised routes as a **reader** — a genuinely different permission set.

| | Result |
| --- | --- |
| Errors | 0 |
| Unique violations on parameterised routes | **0** |
| Unique violations in the reader session | **0** |
| Evidence the reader composition really differs | body text 330–6003 chars vs the signer's |

Both deferred items are answered on evidence: they are not materially different, and the seven
parameterised routes are not a meaningful coverage gap.

### 4.3 What was left

| Rule | Impact | Nodes | Reach |
| --- | --- | --- | --- |
| `region` | moderate | 1 per page | **every route, both themes, both roles** |

Always the same node: the brand `<img>` in the rail, at `div > div > div > div > img`.

## 5. Candidate findings

| # | Finding | Cat | Evidence | Frequency | Owner | Selected |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Rail is not a landmark; brand outside the landmark tree | **A** | `region` on 100% of pages, 3 releases | universal | platform | **yes** |
| 2 | RTL never measured | C | 0 violations found | — | harness | no — measured clean |
| 3 | Parameterised routes uncovered | C | 0 unique violations | — | harness | no — measured clean |
| 4 | Role-dependent composition uncovered | C | 0 unique violations | — | harness | no — measured clean |
| 5 | Unnamed `<aside>` on `/documents` | B | landmark with `name=null` | 1 route | Docs | no — §15 |
| 6 | ContextMenu / E2E CI / ArrowDown / viewport / `aria-errormessage` | — | unchanged | — | — | no — §15 |

### Why finding 1 was selected

- **It is the only confirmed defect left.** Not chosen by elimination for its own sake: three
  dimensions that could plausibly have hidden something worse were measured first and found clean.
- **Reach**: every page, every route type, both roles, both themes. Nothing else measured this
  phase touches more than one screen.
- **Reproducibility**: deterministic, one node per page, same node every time, located to a single
  element in a single component.
- **Ownership is unambiguous** and the defect is *regression* rather than legacy: Phase 8.12
  introduced it, so leaving it would mean knowingly shipping a defect this audit created.
- **Scope**: one component, one prop, one element — provided the architecture is decided rather
  than guessed, which §16 of the brief requires and §7 below does.

## 6. Root cause

`Sidebar` renders brand, a collapse control, the consumer's `<nav>` and a footer. Phase 8.12 turned
its wrapper from `<aside>` into `<div>` to remove an unnamed `complementary` landmark that collided
with `Split`'s inspector. That removed the duplicate and left the brand — real content, with
`alt="Munaxa Docs"` — outside every landmark on the page.

It survived three releases because the two checks that could have caught it each looked elsewhere,
and **neither was wrong to**:

- the component matrix **disables page-structure rules by design** — a component alone in an iframe
  has no `<main>` and no landmarks, and never should;
- the application sweep **filters to critical and serious**, and `region` is moderate.

Two correct decisions leaving a gap exactly the shape of one defect.

## 7. Ownership and the architecture decision

The landmark tree was mapped before anything was changed:

| Landmark | Name | Verdict |
| --- | --- | --- |
| `header` (top bar) → `banner` | — | correct |
| `main` | — | correct |
| `nav` (rail's primary) | "Main" | correct |
| `section[role=region]` × many | named | correct |
| **rail wrapper** | **none — `<div>`** | **the defect** |

Three shapes were considered:

1. **Back to `<aside>`** — rejected. It re-creates the exact `landmark-unique` defect Phase 8.12
   removed, and the rail is not complementary content.
2. **Move the brand inside the inner `<nav>`** — rejected, and not for taste: `Sidebar` *cannot*.
   That nav is the consumer's `children`.
3. **The rail becomes a named `navigation` landmark** — chosen. It is what the rail is: the
   workspace's navigation column, holding the brand, the primary navigation and a footer. A
   landmark list reads "Workspace › Main" rather than an anonymous `complementary` or nothing.

Nesting a named `navigation` inside a named `navigation` is valid ARIA and is the honest shape:
"everything you navigate the workspace with" contains "the primary links".

**Owner: `@munaxa/platform`.** No Docs-side change was made or needed — an application cannot give a
shared shell component a landmark.

## 8. Implementation

`ui/shell/sidebar.tsx`: the wrapper is `<nav aria-label={railLabel}>`, with `railLabel` defaulting
to `'Workspace'` and overridable — the pattern `InspectorLayout`'s `inspectorLabel` already
established for exactly this situation.

## 9. Regression proof

| | With fix | Reverted to `<div>` |
| --- | --- | --- |
| the rail renders at all *(guard)* | ✓ | ✓ |
| the rail is a landmark containing the brand | ✓ | **✗** |
| "Workspace" contains "Main", and they differ | ✓ | **✗** |
| the label is overridable | ✓ | **✗** |
| no anonymous landmark *(the first shape's defect)* | ✓ | ✓ *(correct — a `<div>` adds none)* |

3 of 5 flip. The two guards stay green in both directions on purpose: one proves the suite is not
asserting against an empty tree, the other proves the fix does not reintroduce what Phase 8.12
removed. A table where everything flips cannot distinguish those.

One harness detail worth recording: the first version of this test asserted against an empty tree.
`useIsMobile` reads `matchMedia`, which happy-dom does not implement, so the rail rendered nothing
and every assertion would have passed vacuously. The `matchMedia` stub and the "renders at all"
guard both exist because of it.

**Differential**: 1 696 canonical rows against 1.4.3 — `removed 0 · added 0 · field differences 0`.

## 10. Coverage

| | 1.4.3 | 1.5.0 |
| --- | --- | --- |
| Contrast / keyboard / overlays | 848/848 · 848/848 · 74 | **unchanged** |
| Accessibility tests | 52 | 52 |
| Platform unit tests | 558 | **563** |
| Docs routes swept | 33 of 40 | 33 of 40 |
| Dimensions measured and cleared | — | **RTL, parameterised routes, reader role** |

## 11. Performance

Not a target. Platform suite 817s against 979s for the baseline run — both inside the noise band
Phase 8.10 measured; nothing was changed that affects runtime.

## 12. CI

Unchanged. Docs E2E still has no CI job; re-measured and still its own objective rather than a
side-effect of this one.

## 13. Release

**1.5.0** — MINOR, because `railLabel` is a new optional prop; the fix alone would have been a
PATCH. Registry `latest` verified, tarball inspected, Docs on `^1.5.0` from a wiped `node_modules`
with `--frozen-lockfile`, clean production build, Docs suites re-run — evidence in §16.

## 14. Deferred findings

- **An unnamed `<aside>` on `/documents`** — surfaced by this phase's landmark map, not by any rule:
  axe reports duplicate unnamed landmarks, not solitary ones. It is the same *class* as the defect
  fixed here and belongs to whichever layer owns that panel; measured and recorded rather than
  bundled.
- **ContextMenu** — unchanged; Docs still uses zero instances.
- **Docs E2E CI** — unchanged; still the larger objective.
- **`Combobox` ArrowDown**, **single viewport**, **`aria-errormessage` unused**, **audit/rbac timing
  flakes**, **Cloudflare Storybook check** — all carried; none selected by this phase's evidence.
- **RTL, parameterised routes, reader role** — measured clean this phase. Not "deferred": answered.

## 15. Corrections

Previous reports are not edited. One correction, and it is to work this audit did:

**Phase 8.12's rail fix introduced the `region` defect**, and Phase 8.15 recorded that as a deferred
finding without yet establishing its reach. It is now measured: **every page of the product, in both
themes, for three releases**. Phase 8.12 was right that two unnamed `complementary` landmarks were a
defect and right to remove one; it was wrong to assume the rail needed no landmark at all. Both
halves of that are recorded here rather than either being quietly dropped.

## 16. Final state

| | |
| --- | --- |
| Platform | merged to `main`, tree clean, pushed |
| Docs | tree clean, pushed |
| Published | `@munaxa/platform@1.5.0`, `latest` |
| Docs consumes | `^1.5.0` from the registry store |
| Canonical matrix | 848/848 · 848/848 · 74 overlays · 0 failures |
| `region` across the product | **0** |
| Hidden failures | none |
