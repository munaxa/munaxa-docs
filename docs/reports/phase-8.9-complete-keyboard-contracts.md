# Phase 8.9 — Complete Keyboard Interaction Contracts

## 1. Status

**COMPLETE.** All five limitations carried forward from Phase 8.7/8.8 are closed, and the matrix
holds at **800 of 800** combinations — 100 stories × 4 brands × 2 schemes, 528 interactive, 272
static, 0 excluded, 0 failing.

**No platform component was changed.** Every one of the five limitations turned out to be a gap in
the instrument's coverage, not a defect in a component — which is what measuring first was for.

## 2. What the measurement found

Before touching anything, a survey drove all 100 stories and recorded what each limitation actually
covers. The answers, per limitation:

| # | Limitation | Measured |
| --- | --- | --- |
| 1 | `input` typing not checked | Typing works everywhere it is meaningful. The two apparent failures are `<input type="file">`, hidden behind a Browse button — **a classifier defect** |
| 2 | `link` activation not checked | Every anchor in every story already carries an `href` |
| 3 | `combobox` not checked | Both implementations open and dismiss correctly, and restore focus to the trigger |
| 4 | `radio` not checked | ArrowDown moves the selection: `true,false,false → false,true,false` |
| 5 | Tab walk capped at four | An uncapped walk reaches **every** stop: 35/35, 6/6, 7/7, 20/20 |

So the components were already right. What was missing was the machinery to notice if they stopped
being right.

**A correction to this phase's own first measurement.** The survey initially reported alarming reach
numbers — `forms-overview--states: 1/6`, `foundations-themes--munaxa-docs: 8/35`. That was a defect
in the survey: it identified each landing by tag and label, so a story with several identically
labelled controls collided on the first repeat and broke the loop early. Re-measured with a marker
written to the element itself, every story reaches every stop. The corrected numbers are the ones
above; the first ones are recorded here because they were the reason to look closer, not evidence of
anything about the platform.

## 3. The two comboboxes

The platform ships two, and they open differently:

| Component | Backed by | Opens | Escape | Focus after |
| --- | --- | --- | --- | --- |
| `Combobox` | Radix `Popover` + `cmdk` | on **Enter** (ArrowDown does nothing) | closes | returns to the trigger |
| `Autocomplete` / `EntityPicker` | its own state machine | already open **once focused**; Enter *commits* the highlighted option | closes | stays on the input |

The contract is therefore written around what they share — it opens, Escape dismisses it, focus is
restored — rather than around either one. Demanding that both open on Enter would have reported
`EntityPicker` as broken for behaving correctly for its pattern.

**Deferred, deliberately: ArrowDown does not open the select-only `Combobox`.** The ARIA authoring
practices recommend it. It is an enhancement rather than a defect: the control is fully operable
from the keyboard without it, so asserting it here would have meant redesigning a shared component
during a coverage phase. Recorded in `CONTRACT` and in §8.

## 4. What changed in the harness

**The walk visits everything.** `tabThroughStory` now marks every stop a person is entitled to
reach, walks until it has visited them all, and reports by name whatever it never reached. The
bound follows the story — twice its stops plus a margin — because a fixed 40 could not traverse the
largest ones, which have 60.

What counts as a stop is deliberately narrow, because the alternative manufactures failures:

- `tabindex="-1"` is excluded — a roving composite owns **one** Tab stop, and a `DataGrid` with
  forty cells is one stop, not forty.
- disabled and `aria-disabled` controls are excluded — WCAG exempts inactive controls.
- hidden controls are excluded.
- a radio group counts once, because that is how the browser's roving works.

**`input` means typable.** The Phase 8.7 selector was "an input that is not a checkbox or a radio",
which swept in `<input type="file">`. The classifier and the typing contract now share one
definition of typable, so they cannot disagree about what a story contains — a disagreement of
exactly that shape cost Phase 8.7 a whole failure family.

**Four contracts join the matrix**: typing enters text (K8), every link exposes an activation target
(K9), arrows move a radio selection (K3), and a combobox opens, dismisses and restores focus
(K4/K5/K7).

## 5. Four new proofs

`keyboard-proof.a11y.spec.ts` grows from four proofs to eight. Each damages a rendered story in one
specific way and requires the instrument to notice:

| Proof | Damage | Required response |
| --- | --- | --- |
| **E** | one control of a 35-stop story removed from the tab order | expected stops drop by one **and** reached drops by one |
| **F** | the field made read-only | typing changes nothing |
| **G** | a link's `href` removed | exactly one orphan reported |
| **H** | arrow keys swallowed by a capturing listener | the radio selection does not move |

**Proof E caught its own first version.** It picked the seventh button on the page as the victim and
landed on a *disabled* one — already excluded from the expected stops, so removing it changed
nothing, the walk still reached 35 of 35, and the proof reported a working instrument as broken. It
now selects through the same filter the walk uses and asserts the expected count drops too.

## 6. Three matrix runs, and what each taught

Nothing was excluded, tolerated or weakened at any point; each round was classified before anything
changed.

| Run | Failed | Cause |
| --- | --- | --- |
| 1 | **92** | contracts interfering with each other |
| 2 | **16** | the overlay contract pressing Enter on an already-open combobox |
| 3 | **0**, 3 errored | a classification flicker |
| 4 | **0**, 0 errored | — |

**Run 1 — 80 × K3 + 12 combobox.** The contracts run one after another on a single page, and some
leave the component in a different state than they found it. Typing `kb` into `DataGrid`'s search
box filters the grid — correctly — from **96 cells to none**, and the arrow contract that ran next
found nothing to move between. The entity pickers did the same to the combobox contract, leaving a
listbox open with no matches. Confirmed by counting gridcells before and after the typing contract,
rather than reasoned about. Each contract that changes the story now gets a fresh render, paid only
where the story has that kind.

**Run 2 — 16 × K4 on the two entity-picker stories.** `openAndDismiss` pressed Enter
unconditionally; on a combobox that is already open, Enter commits the highlighted option and closes
the list, so the instrument closed what was open and then reported that it never opened. It now
presses Enter only when the surface is not already showing.

**Run 3 — 3 errored.** Three combinations classified a `dialog` trigger that a repeat render never
produced; an `AppShell` at this viewport has none in five runs out of five, so something transient
was caught mid-mount. Driving a contract for a control that is no longer there timed the locator out
and reported the story as unrenderable, which it is not. Each contract now re-detects its kind on
the render it is about to drive, and a kind that does not survive is counted in the summary
(`reclassifiedOnReload`) rather than asserted — visible, and neither a failure nor a silent pass.

## 7. Final coverage

```
stories 100 · brands 4 · schemes 2 · combinations 800
interactive 528 · static 272 · excluded 0 · failed 0 · reclassifiedOnReload []

button 504   input 200   grid 120   menu 104   link 96   dialog 80
checkbox 64  tabs 40     switch 40  combobox 40  radio 8   static 272
```

Every kind in that list is now driven by a contract. Phase 8.7 drove five of them.

## 8. Gates

| Gate | Result |
| --- | --- |
| `eslint` | 32/32 tasks |
| `tsc --noEmit` | 32/32 tasks |
| `pnpm test` | 26/26 tasks — 522 platform tests |
| `check:faded` | clean |
| `validate:contract` / `validate:tokens` | 66 roles × 4 themes × 2 schemes · 49 values |
| `test:a11y` | contrast **800/800**, keyboard **800/800**, **8** proofs |

## 9. Preserved from earlier phases

Automatic discovery from `storybook-static/index.json`; no hand-maintained story list; `EXCLUDED`
still empty and still asserted empty; DOM-derived classification; the four-brand × two-scheme
matrix; the pinned Chromium; the failure artefacts; and the single CI accessibility job, which needs
no change because it runs the `test/a11y/` glob.

## 10. Deferred

- **ArrowDown does not open the select-only `Combobox`** (§3) — an ARIA authoring-practice
  enhancement, not an operability defect.
- **`link` activation is asserted as a target, not as a navigation.** Pressing Enter on a link
  navigates the story away and proves less than checking the `href` the browser actually acts on.
- Widening axe beyond `color-contrast`; a second viewport. Both unchanged from Phase 8.7.

## 11. Cost

The matrix now reloads a story once per applicable contract, so a run takes about **11 minutes**
against roughly 5 before. That is the price of contracts that cannot poison each other, and it is
paid only where a story has the kind in question.
