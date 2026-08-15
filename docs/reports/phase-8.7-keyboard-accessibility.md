# Phase 8.7 — Keyboard Accessibility Across the Matrix

## 1. Status

**COMPLETE.** 800 of 800 keyboard combinations meet their contract — 100 stories × 4 brands × 2
schemes, 0 excluded, 0 skipped. Phase 8.5's contrast matrix is unchanged beside it at 800/800.

Phase 8.4 asserted two keyboard interactions on two stories chosen by hand. Every story is now held
to a contract derived from **what it renders**, across the same automatic inventory Phase 8.5
established: 100 stories × 4 brands × 2 schemes.

One product defect was found and fixed at its shared owner. Every other failure the matrix reported —
six instrument defects across three rounds — was the measurement being wrong, and four of them
accused components that behave correctly. Each was classified before anything was changed.

## 2. What replaced `kindOf()`

Phase 8.6 recommended reusing `kindOf()`. Reading it first showed it could not carry this phase:

```ts
const title = story.title.toLowerCase();
if (title.includes('appshell') || title.includes('navigation')) return 'navigation';
if (title.includes('datagrid')) return 'grid';
```

It classified by **story title**, returned one kind per story, and knew six of them. A story renaming
changes its contract; a story rendering a grid *and* a menu owes one of them; a component added to an
existing story is invisible to it.

`DETECT_KINDS` replaces it: a browser-side function that reads `#storybook-root` and reports **every**
kind present, from the DOM. Twelve kinds, each with a written contract. `static` is a real answer
rather than a skip — a typography page has no keyboard contract, and asserting one would be theatre.

Disabled controls are excluded from classification. WCAG exempts inactive controls and a correct
disabled `Button` is deliberately out of the tab order.

## 3. What is asserted

| Kind | Contract | Instrument |
| --- | --- | --- |
| any interactive | Tab reaches the story's own controls | Tab pressed from `document.body`, up to 40 times |
| any interactive | focus is visibly marked | focused paint compared against the same element at rest |
| `switch`, `checkbox` | Space changes state | keypress, then the control's state re-read |
| `tabs`, `grid` | roving focus moves on the arrows | Tab into the composite, then the arrow key |
| `menu`, `dialog` | Enter opens, Escape closes, focus returns | the three answers reported separately |

Two rules shape all of it:

- **The keyboard drives.** `element.focus()` proves an element is focusable, not that a person can
  reach it. Reachability is always established by pressing Tab.
- **Focus has to be visible.** `document.activeElement === el` is not evidence anyone can see where
  they are, and neither is a computed `box-shadow` — a card with a resting shadow would report an
  indicator it never grew.

## 4. Baseline

Established before any code was changed, as instructed.

| | Value |
| --- | --- |
| Stories discovered | **100** (96 at Phase 8.6; four added by 1.3.0's brand work, picked up automatically) |
| Excluded | **0** |
| Combinations | **800** |
| Classified interactive | **528** |
| Classified static | **272** |
| Failed | **0** |

Kinds, counted per combination:

| Kind | Combinations | Kind | Combinations |
| --- | --- | --- | --- |
| `button` | 504 | `menu` | 104 |
| `static` | 272 | `link` | 96 |
| `input` | 216 | `dialog` | 80 |
| `grid` | 120 | `checkbox` | 64 |
| `tabs` | 40 | `switch` | 40 |
| `combobox` | 40 | `radio` | 8 |

The first attempt at this baseline reported **800 errored combinations** and no classification at
all. That was instrument defect 1 below, not a platform that cannot be driven.

## 5. Failures, classified before anything was fixed

Three rounds, each classified before anything was changed. Nothing was excluded, tolerated or
weakened at any point.

| Round | Failed | Families |
| --- | --- | --- |
| 1 — reachability, visibility, activation | **8** | K1 × 8, all `primitives-button--disabled` |
| 2 — arrows and overlays added | **48** | K3 × 40 (grids and calendars), K4 × 8 (files browser) |
| 3 — after the product fix | **17** | K3 × 16 (states stories), K5 × 1 |
| final | **0** | — |

Only **one** of those families was a product defect. The rest were the instrument accusing correct
components, which is exactly the risk this phase was warned about:

- **Round 1, K1 × 8** — every control in `primitives-button--disabled` is disabled, so nothing is
  tabbable. Correct behaviour: WCAG exempts inactive controls. Classification defect.
- **Round 2, K3 × 32** — the four `Calendar` stories. The component moves the focused day by a week
  on ArrowDown and does it correctly; the instrument had focused a `<td>`, which is not focusable.
  Instrument defect 3.
- **Round 2, K3 × 8** and **round 3, K3 × 16** — `data-datagrid--states` and `workspace-files--states`
  render several grids, including a loading one with eight skeleton rows and no cells at all. Arrow
  keys with nowhere to go are correct. Classification defect, twice: the second time because the
  page-wide classification and the first-match driver disagreed about *which* grid.
- **Round 3, K5 × 1** — one `Calendar` combination of eight reported Escape as ignored, and the
  other seven passed. A one-in-eight result that varies by brand, where brands only change colour,
  is a stopwatch reading. The fixed 220ms wait was replaced with polling.
- **Round 2, K4 × 8** — `workspace-files--browser`. **A real defect**, §6.

## 6. The product defect

`DataGrid`'s `onKeyDown` sits on the `<table>`, so every keystroke aimed at a control **inside** a
cell bubbles to it — and the grid answered them:

```ts
case 'Enter': {
  const cell = event.target as HTMLElement;
  const inner = cell.matches('[data-cell]') ? cell.querySelector('button, a[href], …') : null;
  if (inner) { event.preventDefault(); inner.focus(); return; }
  const target = row >= 0 ? api.rows[row] : undefined;
  if (target && onRowActivate) { event.preventDefault(); onRowActivate(target); }
}
```

When focus is on the cell, Enter reaches into the cell's control — correct, and covered by an
existing test. When focus is already **on** that control, `matches('[data-cell]')` is false, so it
fell through to row activation and `preventDefault()` stopped the control's own handler.

Measured on `workspace-files--browser`: the row action menu **opens on a click and not on Enter**, in
all four brands and both schemes. The same rule applied to Space (row selection) and the arrows.

The fix is one line at the top of the handler, and it states the rule the component already
documented for Escape:

```ts
if (!(event.target as HTMLElement).matches('[data-cell]') && event.key !== 'Escape') return;
```

Escape stays the grid's, because it is how a person gets back out of a cell's control to the cell —
which is what makes the arrows work again.

**Fixed at the shared owner**, not in the story: `DataGrid` is the platform's grid, and every product
table built on it had the same defect.

## 7. The instrument defects

Phase 8.5 produced 305 spurious failures from an instrument that looked correct. Three were found
here, and two of them accused working components:

| # | Defect | Symptom | Correction |
| --- | --- | --- | --- |
| 1 | `page.evaluate(DETECT_KINDS)` evaluated a function **expression** whose value does not serialise | all 800 combinations errored with `undefined` | invoke it: `` page.evaluate(`(${DETECT_KINDS})()`) `` |
| 2 | the focus indicator was read once, while focused | `outline-color` resolves from `currentColor`, so a colour change on focus read as a ring — a story with **every** ring stripped still passed | compare the focused paint against the same element at rest, and require something actually painted |
| 3 | composites were entered with `focus()` on a guessed descendant | a `<td>` is not focusable, so focus stayed on the body and **every `Calendar` story** was reported as ignoring the arrows — the component is correct and moves by week | enter by Tab, like a person |

Two more were classification errors rather than measurement ones:

- **4 — disabled controls counted as a contract.** `primitives-button--disabled` renders only
  disabled buttons, which are correctly out of the tab order. Classification now ignores
  `:disabled`, `[aria-disabled="true"]` and `[data-disabled]`.
- **5 — a composite with nothing to move between.** A loading `DataGrid` renders eight skeleton rows
  and **no cells**. A grid counts as a grid only once it contains a cell — and the selector that
  decides that is now the same one that picks which grid to drive, because a states story renders
  several and the first is not the populated one. That disagreement is why this family had to be
  fixed twice.

A sixth was a stopwatch rather than a measurement: overlay open and close were waited on with a
fixed 220ms, which one combination in eight missed. Both are now polled to a condition.

Defect 2 was caught by the phase's own proof C, not by inspection — the first version of the walk
passed a story whose focus rings had all been stripped away.

## 8. Test-proofs

`test/a11y/keyboard-proof.a11y.spec.ts` damages a rendered story in one specific way and requires the
instrument to notice. The instrument lives in `keyboard.ts` so the proofs drive **the same code** the
matrix runs — a proof against a re-implementation proves nothing.

- **A — reachability.** Every control in a story is given `tabindex="-1"`. Reported unreachable; the
  same elements are then shown to still respond to `element.focus()`, which is exactly why `focus()`
  is not the test.
- **B — activation.** A capturing listener swallows Space. The toggle stops changing state and K2
  fires; without the listener it toggles.
- **C — focus visibility.** `outline: none !important; box-shadow: none !important` is injected. The
  controls stay reachable and the indicator is reported gone — in **both** schemes, because a ring
  can survive light and vanish in dark.
- **D — classification and coverage.** A toggles story classifies as `switch` + `checkbox`, a badge
  story as nothing to drive, a disabled-only story as nothing to drive, and the proofs read the same
  inventory the matrix does.

**Falsification of the product fix.** Reverting the one-line guard fails the new `DataGrid`
regression test, naming the row activation that should not have happened. Restored → green.

The companion Space assertion is **not** a falsifier and is labelled as such in the test: it passes
with the guard reverted, because reaching that state under happy-dom leaves the grid's own row focus
where Space finds nothing to select. The Enter test carries the proof.

## 9. Preserved from earlier phases

- **Automatic discovery** — inventory from `storybook-static/index.json`, no hand-maintained list,
  no exclusions. The four stories added by 1.3.0's brand work were picked up without anyone adding
  them.
- **Contrast matrix** — Phase 8.5's 800 combinations, unchanged and still zero violations.
- **`check:faded`** — unchanged and passing.
- **Palette suite** — 81 assertions, unchanged.

## 10. CI

The accessibility job runs `test:a11y`, which is a glob over `test/a11y/`. The keyboard matrix and
its proofs are therefore enforced by the existing job with no new step — a suite discovered by glob
cannot be half-wired. The job and step names were corrected to say what they now cover.

## 11. Gates

**Platform** — prettier · eslint clean · `tsc --noEmit` clean · `pnpm test` **522/522** (23 files,
two new `DataGrid` regression tests) · `check:faded` clean · `validate:contract` 66 roles × 4 themes
× 2 schemes · `validate:tokens` 49 values · `build-storybook` · **`test:a11y` 38/38** — contrast
**800/800**, keyboard **800/800**, four proofs, discovery.

The full accessibility suite was run twice end to end after the fixes, green both times.

Package tarball: **486 files, zero** test, story, spec or harness files — the keyboard harness stays
inside the repository.

## 12. Remaining limitations

- **Not every contract is machine-checked.** `input` (typing), `link` (activation), `combobox` and
  `radio` are classified and counted but only held to reachability and focus visibility.
- **First four landings.** The Tab walk stops after four of a story's own controls; it proves the
  order is real, not that every control in a large story is reachable.
- **Contrast is still the only axe rule run**, and still one viewport (1280×900).
- **Storybook is not the product.** A component composed differently in an application can behave
  differently; this phase found its defect in a story, and the product consuming it had the same one.

## 13. Recommended next phase

Extend the per-kind contracts to `input`, `link` and `combobox`; widen axe beyond `color-contrast` on
the same matrix; add a second viewport.

Separately, and owned elsewhere: the wall-clock release-gate assertions recorded in Phase 8.6 §13.
