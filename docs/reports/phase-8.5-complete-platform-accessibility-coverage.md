
# Phase 8.5 — Complete Platform Story Accessibility Coverage & CI Enforcement

## 1. Status

**INFRASTRUCTURE COMPLETE — SUITE RED, 24 combinations failing across 6 stories.**

Not marked COMPLETE, because the completion criteria require the platform gates to pass and the
accessibility matrix does not. That is the mechanism working rather than failing: widening from
twelve hand-picked stories to all ninety-six surfaced defects nobody had looked at, and this phase
fixed four families and ran out of room before the last one.

The architectural outcome asked for is in place and enforcing:

```
New story → Storybook build → automatic discovery → 4 brands × light/dark
          → real Chromium → real generated CSS → axe + interaction → CI
```

No hand-maintained subset sits anywhere in that path.

## 2. Phase 8.4 baseline, verified first

| | |
| --- | --- |
| `main` | `978a544` |
| Version / published | 1.1.0 / 1.1.0 |
| `pnpm test:a11y` | present, 26/26 |
| Storybook build | succeeds |
| `color-contrast` | enabled in the browser suite, disabled in happy-dom |
| Control case | injected bad contrast detected, removal clean |

Nothing from 8.2, 8.3 or 8.4 was modified except where this phase proved a defect in it (§15).

## 3. Story discovery

`test/a11y/stories.ts` reads `storybook-static/index.json` — the index Storybook generates from the
story files it compiled — and returns every `type: 'story'` entry. There is no list of story IDs
anywhere in the suite.

Two assertions keep it honest:

- **A floor.** `MINIMUM_STORIES = 90`. A shrinking index is either a deleted component or a broken
  discovery mechanism, and from a green suite those are indistinguishable.
- **An empty exclusion map**, asserted empty, with any future entry required to carry a reason about
  *why the entry cannot render independently* — never *why it currently fails*.

## 4–8. Coverage numbers

| | |
| --- | --- |
| Stories discovered | **96** |
| Eligible | **96** |
| Excluded | **0** |
| Brands | 4 — docs, group, school, work |
| Schemes | 2 — light, dark |
| **Combinations** | **768** |
| Rendered without error | **768** |
| Passed | **744** |
| Failed | **24** |
| Interactions performed | 8 (the command palette, opened in each brand and scheme) |
| Duration | ~300s at 6 workers |

Phase 8.4 covered 12 stories — **12.5%**. This covers 100%.

## 9. axe configuration

`runOnly: ['color-contrast']`, enabled, against the **whole document** rather than
`#storybook-root`, so portalled layers are included (Phase 8.4 found the command palette clean under
a root-scoped run while direct measurement read 2.79:1). `incomplete` is collected alongside
`violations` because axe defers translucent-background cases rather than judging them.

## 10. Portal coverage

Dialogs, popovers, dropdowns, menus and the command palette all render outside the story root and
are all inside the audited root. The command palette is the case with a test: it is opened by its
own button before axe runs.

## 11. Interaction coverage

`INTERACTIONS` maps a story to actions performed through **real controls** — a click on a named
button, a wait for what it opens. Nothing reaches into React state or edits the DOM, because an
accessibility result obtained by bypassing the component is a result about nothing.

One story needs one today. The mechanism exists so the next one is a data change rather than a
rewrite.

## 12. Keyboard coverage

Retained from Phase 8.4 in `components.a11y.spec.ts`: the command palette (open, ArrowDown, Escape)
and the shell rail (Tab to every link, focus indicator present). `kindOf()` in `stories.ts`
classifies a story as navigation / dialog / grid / combobox / menu / none so an expectation is only
made where the component owes one — a `Badge` has no keyboard contract and asserting one is theatre.

**Limitation, stated plainly:** the classification is defined and used for reporting, but the
matrix suite does not yet require a per-kind keyboard interaction for every discovered story. The
two keyboard assertions are the ones Phase 8.4 established. Generalising them is the first item in
§23.

## 13. Static opacity guard

`scripts/check-faded-foreground.mjs`, wired as `pnpm check:faded` and run in CI **before** the
browser starts.

It targets semantic *foreground text* tokens with an opacity modifier — the one pattern Phases 8.2
and 8.4 each found repeatedly:

| Occurrence | Measured |
| --- | --- |
| SidebarNav group title | 2.79:1 |
| Command group heading | 2.79:1 |
| Calendar week number | 2.79:1 |
| Calendar outside-month day | **1.71:1** |
| Field optional label | 2.79:1 |
| Autocomplete description | 2.68:1 |

It reports file, line, class, token and opacity. It exempts what WCAG 1.4.3 exempts — inactive
controls — matched both as a `disabled:` variant and as the conditional form this codebase actually
writes (`disabled && '… text-muted-foreground/30'` on an `aria-disabled` element). Five tests hold
it to that, including a case proving an ordinary conditional **cannot** borrow the exemption, and
the real `Calendar` pattern, which must pass for the reason WCAG gives rather than for convenience.

Current source: clean.

## 14. Palette verification

Phase 8.4's 41 assertions are intact and unweakened — every `-strong` token, four brands, both
schemes, held against the tints it ships on. Two generator changes this phase (§15) flow through the
same rule rather than around it, and no story-specific override was added anywhere.

## 15. Confirmed defects — found by widening, fixed here

| Defect | Measured | Fix |
| --- | --- | --- |
| `--destructive` `#E53935` + white | **4.23:1** | fill darkened to `#DE312F` until its own foreground clears AA |
| `StatCard` success delta | **2.55:1** | `text-accent-cool` → `text-success-strong` |
| `StatCard` warning delta | **2.58:1** | `text-accent-warm` → `text-warning-strong` |
| `ErrorState` body and reference on the destructive tint | below AA | box carries `text-foreground`; nothing re-muted inside |
| Icons page danger label | below AA | `text-destructive` → `text-destructive-strong` |

`bestFg` returned the *better* of white and ink, which is not the same as a passing one — the same
shape of error as Phase 8.3's white-only rule, one function away.

**A latent generator bug surfaced with it.** The dark block emitted
`--destructive: ${p[300] && t.semantic.error}`, which evaluates to the raw error colour, so the dark
scheme never received the corrected fill. Fixed.

**`ErrorState` is the `Alert` defect from Phase 8.4 in a second component** — `--muted-foreground`
is chosen against the page and both components paint a tone tint behind it. 8.4 fixed the instance
it rendered; this found the other one by rendering more.

## 16. Retracted findings

None. No Phase 8.2/8.3/8.4 conclusion is disproved by this phase.

## 17. Deferred and still failing — 24 combinations, 6 stories

Recorded, not excluded. They are one coherent family the generator's surface model does not cover:

| Story | Selector | Shape |
| --- | --- | --- |
| `foundations-themes--munaxa-{docs,group,work}` | `.bg-primary/5 > gridcell > .bg-success/15` | **tint on tint** — a badge inside a selected row |
| `data-datagrid--selection-and-actions` | same | tint on tint |
| `workspace-boards-hierarchies--schedule` (+ locale) | `.bg-warning > .truncate`, `.bg-destructive > .truncate` | **fill + text**, no `--warning-foreground` token exists |
| `workspace-boards-hierarchies--schedule` | `.bg-primary.text-primary-foreground` (dark) | fill + foreground in dark |

The palette rule holds `-strong` against *tint over page* and *tint over muted*. It does not model a
tint composited over **another tint**, which is what a status badge inside a selected grid row is.
Fixing it is a generator change of the same kind as Phases 8.3 and 8.4, and it should be measured
before it is written.

`Calendar`'s disabled day (`/30`) remains correctly exempt: the static guard passes it by the
disabled condition, and axe does not report it in any of the 768 combinations.

## 18. Test-proofs

**Proof A — the instrument.** Injected ~1.6:1 element → axe reports it; removed → clean. Unchanged
from 8.4 and re-run here.

**Proof B — discovery.** Seven entries removed from the built index → discovery reports 89 against a
floor of 90 and fails with *"discovered 89 eligible stories, below the recorded floor"*. Index
rebuilt → passes. A future return to `const STORIES = [...]` cannot be silent.

**Proof C — implementation.** Carried from 8.4 and still in the suite: reverting `command.tsx` to
`/70` fails exactly two tests at 2.79:1 and 4.04:1, with no unrelated cascade.

## 19. CI integration

A new `accessibility` job in `.github/workflows/ci.yml`: install → **install the pinned Chromium**
(`playwright install --with-deps chromium`, not the runner's browser) → `check:faded` → build
Storybook → run the matrix. On failure it uploads the built Storybook for seven days, so the exact
story can be opened at the commit that broke it; a green run keeps nothing.

The static guard runs first because it costs seconds rather than minutes.

## 20. Package boundary

`npm pack --dry-run`: **0** files matching `a11y`, `storybook`, `playwright`, `.test.`, `.stories.`
or `check-faded`. 452 files, 3.4 MB. `scripts/` is absent from `tsconfig.build.json`'s include, so
the new guard and its test cannot reach `dist`.

Phase 8.4's `files` exclusion for `themes/**/*.test.ts` is intact.

## 21. Gates

| Gate | Result |
| --- | --- |
| `format:check` | clean |
| `lint` | 32/32 |
| `typecheck` | 32/32 |
| `test` (unit + palette + guard) | 26/26 tasks |
| `build` | 20/20 |
| `validate` | pass |
| `build-storybook` | succeeds |
| `check:faded` | clean |
| **`test:a11y`** | **30/31 — the matrix assertion fails on the 24 combinations in §17** |

No release was made: the package's runtime surface changed (three token values and four components),
so a release is warranted, but publishing while the accessibility gate is red would ship the defects
in §17 into Docs. Version, publish and consumption are the first steps once §17 closes.

## 22. Remaining limitations

- **The suite is red.** §17 is the whole of it, and it is a product problem rather than a harness
  problem.
- **Keyboard is not yet per-kind across the matrix** (§12).
- **Contrast is the only axe rule run.** Widening to the full ruleset is a separate decision with a
  different failure surface.
- **One viewport (1280×900).** Responsive states are not in the matrix.
- **Storybook is not the product** — the caveat from 8.4 stands: a component composed differently in
  an application has a different background stack.
- Runtime is ~5 minutes at 6 workers; on a 2-core runner it will be longer.

## 23. Recommended next phase

**Phase 8.6 — model composed surfaces in the palette rule, and close §17.** Every remaining failure
is a surface the generator does not describe: a tint over a tint, and a fill used with text where no
`-foreground` token exists. Measure them in the harness that now exists, then fix the rule rather
than the six stories.

Then: generalise keyboard expectations per `kindOf()` across the matrix, and — once green — release
and consume in Docs.
