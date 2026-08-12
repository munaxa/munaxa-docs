
# Phase 8.6 — Composed Surface Accessibility & Semantic Palette Model

## 1. Status

**COMPLETE.** 768 of 768 combinations pass. 96 stories × 4 brands × 2 schemes, 0 excluded.

All 25 failures Phase 8.5 surfaced are resolved, none by exclusion, tolerance, suppression or a
story-specific override. They collapsed into three families with a single architectural cause: the
palette generator modelled only **solid, un-composed** surfaces, and the components compose them.

Released as `@munaxa/platform` **1.2.0**, consumed by Docs from the registry and verified there.

## 2. Phase 8.5 baseline — reproduced, with one correction

| | 8.5 report | Reproduced |
| --- | --- | --- |
| Stories / eligible / excluded | 96 / 96 / 0 | 96 / 96 / 0 |
| Combinations | 768 | 768 |
| Rendered | 768 | 768 |
| Passed | 744 | **743** |
| Failed | 24 | **25** |

**Correction.** The Phase 8.5 report said 24 failing combinations; the actual number is **25**. The
failure sets from the 8.5 run and this reproduction are byte-identical — diffed, empty both ways — so
this is a miscount in that report, not a change in behaviour. Phase 8.5's history is left as written
and the correction recorded here, as instructed.

The duplicate-axe problem did not return: 0 errored combinations, and `axeOn` still reuses the
instance `@storybook/addon-a11y` puts on the page rather than injecting a competing one.

## 3. The 25 failures, classified

| Family | Combinations | Composition | Measured |
| --- | --- | --- | --- |
| **A** tint on tint | 15 | `bg-<tone>/15` badge inside a `bg-primary/5` selected row | **4.48:1** |
| **B** fill + text | 5 | `bg-warning` / `bg-destructive` with `text-background` | **2.14:1** / 3.76:1 |
| **C** washed fill | 5 | `bg-primary` under `Gantt`'s `bg-background/30` progress overlay | **3.63:1** |

Full inventory by story and brand:

- **A** — `foundations-themes--munaxa-{docs,group,work}` × 4 brands (12, light) and
  `data-datagrid--selection-and-actions` × {docs, group, work} (3, light).
- **B** — `workspace-boards-hierarchies--schedule` × {docs light, docs dark, group light,
  school light, work light}.
- **C** — `workspace-boards-hierarchies--schedule` × {group dark, work dark} and
  `--schedule-in-another-locale` × {docs dark, group dark, work dark}.

Measurements are axe's own `contrastRatio`/`fgColor`/`bgColor`, not a selector I guessed at — an
earlier attempt to measure Family C by CSS selector found a *different* element that passed at 6.37:1
and would have contradicted the failure for no good reason.

## 4. Root cause

One sentence: **a token generated against one surface was assumed valid on every surface built from
it.**

- The generator held `-strong` against *tint over page* and *tint over muted*. A selected row adds a
  third layer, and the badge that passes at 4.50:1 on the page composites to `#d9e7da` and measures
  4.48:1 inside one.
- `bestFg` returned the better of white and ink, which is not the same as one that passes — the
  defect Phase 8.5 found at `#E53935` + white 4.23:1, still present for every other fill.
- `--warning` and `--success` had no `-foreground` token at all, so `Gantt` borrowed
  `text-background`: the page colour used as a label, white on amber.

## 5. The composed-surface model

`tintedSurfaces` gains a third surface — a tone tint over the brand's selection wash over the page —
composited in sRGB by the same helper the palette test uses, with no correction factor anywhere:

```
composite(fill, composite(brandTint, page, 0.05), 0.15)
```

`fillForeground` replaces `bestFg` for fill/label pairings and **returns `null` rather than a failing
colour**, so nothing ships below AA silently. Where neither white nor ink clears a fill, the fill is
darkened only as far as needed for one of them to.

A fourth defect surfaced from the model itself: `-strong` was computed from the brand's **raw input**
while `Badge` tints the fill the palette actually **ships**. Where a fill is darkened, those differ —
leaving `--info-strong` at 4.48:1 on a badge in a selected row. Caught by the palette test, on a
composition **no story renders**, which is the clearest evidence that the static model and the
rendered matrix cover different ground.

### What the model deliberately does not promise

Requiring one foreground to clear both a fill *and* its washed form drove every status colour to
near-black — `--success` `#2E7D32` → `#004D00`. That is a brand redesign wearing an accessibility
fix's clothes. The palette promises a legible label on a **solid** fill; a component that paints
something else over that fill owns the result. That is the ownership line, and Family C sits on the
component's side of it.

## 6. Semantic token changes

**Added** — `--success-foreground`, `--warning-foreground`, `--info-foreground`, completing the fill
family beside `primary` and `destructive`, in all four brands and both schemes, with matching
`--color-*` contract entries. Justified by Part 10: multiple components pair text with these fills,
and the alternative was every consumer inventing its own.

**Changed** — `--info` `#0284C7` → `#007CBF` (docs), the minimum for a foreground to clear it, plus
small `-strong` adjustments from the tint-on-tint surface. `--success`, `--warning` and
`--destructive` fills are unchanged.

## 7. Component changes

`gantt.tsx` — the tone map uses each fill's own `-foreground` instead of `text-background`, and the
progress overlay moves from a full-height `bg-background/30` wash to a bottom strip. It still shows
progress and no longer puts two different backgrounds under one run of text.

## 8. Direct measurements

| Composition | Before | After |
| --- | --- | --- |
| A · `success/15` over page | 4.50 | 4.5+ |
| A · `success/15` over `primary/5` over page | **4.48** | ≥4.5 |
| A · `info/15` over `primary/5` over page | **4.48** | ≥4.5 |
| B · white on `#F59E0B` warning fill | **2.14** | ink, ≥4.5 |
| B · white on `#EF4444` danger fill | **3.76** | ≥4.5 |
| C · label on `#607760` washed primary, dark | **3.63** | wash no longer under the label |

Verified in all four brands and both schemes by the 768-combination matrix; the palette suite asserts
the same properties statically for compositions no story yet renders.

## 9. Test-proofs

**Proof A — generator.** Reverting only the tint-on-tint surface fails **11** palette assertions,
each naming the token, the composed surface and the ratio.

**Proof C — architectural layer.** The same revert, with **every component and story untouched**,
turns exactly Family A's **15** combinations red in the browser. Restored → 768/768. This is the
proof that matters: the fix lives where the defect lives.

**Proof B — instrument.** Phase 8.4's control case is intact and re-run: injected ~1.6:1 element is
reported by axe; removed, clean.

No assertion was weakened after any failure.

## 10. Preserved from earlier phases

- **Automatic discovery** — inventory from `storybook-static/index.json`, no story list, floor of 90
  with the removal proof intact.
- **`check:faded`** — unchanged and passing; it and the browser matrix protect different classes.
- **Calendar's disabled day** — still exempt, still passing the guard by its disabled condition, and
  reported by axe in none of the 768 combinations.
- **CI** — the accessibility job is unchanged: pinned Chromium, guard, Storybook build, full matrix,
  artefact on failure.

## 11. Gates

**Platform** — format · lint 32/32 · typecheck 32/32 · test 26/26 · **palette 81/81** (was 41) ·
build 20/20 · validate · `build-storybook` · **`test:a11y` 31/31, 768/768** · `check:faded` ·
`verify-release.mjs` all checks passed.

**Docs** — format · lint 13/13 · typecheck 13/13 · test 13/13 · verify:styles 10/10 · web build ·
`consistency.e2e` **12/12** with `[axe /documents] []` · `faded-text.e2e` **4/4** ·
`shell.e2e` **8/8**.

## 12. Release and consumption

| | |
| --- | --- |
| Version | **1.2.0** (MINOR — three new tokens) |
| Platform | `30ed588`, merged to `main` as `1e227a3` |
| Release run | `31630665081`, ref `main`, **attempt 2** — see §13 |
| Registry | `latest` → `1.2.0` |
| Tarball | **0** harness/test/story files; all three new tokens present |
| Docs | `^1.2.0`, lockfile resolves the registry tarball with integrity hash |
| Frozen install | `node_modules` wiped → `--frozen-lockfile` → exit 0 |

Order kept: fix → gates → matrix → proofs → package inspection → release → registry → Docs.

## 13. Unrelated blocker, recorded not fixed

The release gate runs `pnpm test`, which includes wall-clock performance assertions. **Three of five
release attempts in this sequence have been blocked by them**, in packages the change never touched:

| Package | Budget | Observed |
| --- | --- | --- |
| `@munaxa/audit` | `< 14ms` | 20.02 |
| `@munaxa/rbac` | `< 7500` | 8047.68, then 7754.97 |

All pass locally. Every release now effectively needs a re-run, and the failure is indistinguishable
from a real regression until the assertion is read. Out of scope by instruction and left alone.

## 14. Remaining limitations

- **Contrast is the only axe rule run.** Widening to the full ruleset is a separate decision.
- **One viewport** (1280×900); responsive states are not in the matrix.
- **Keyboard is not yet per-kind across the matrix** — `kindOf()` classifies, but only the two
  Phase 8.4 assertions run.
- **Storybook is not the product**; a component composed differently in an application has a
  different background stack. This phase is itself the evidence for that caveat.
- The model covers the compositions the platform declares today. A new one — a third tint layer, a
  different wash — needs adding to `tintedSurfaces` deliberately.

## 15. Recommended next phase

**Phase 8.7 — generalise keyboard coverage across the matrix** using the existing `kindOf()`
classification, so every interactive story is exercised rather than the two established in 8.4.

Then, cheaply: widen axe beyond `color-contrast` on the same matrix, and add a second viewport.

Separately, and owned elsewhere: the wall-clock release-gate assertions in §13.
