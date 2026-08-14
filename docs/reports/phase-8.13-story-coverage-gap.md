# Phase 8.13 — The Components the Matrix Could Not See

## 1. Status

**COMPLETE.** Released as 1.4.1, verified on the registry, and consumed by Docs from it.

The accessibility matrix has reported **100 stories, 0 excluded** since Phase 8.5. That number is
honest about every question except the one that matters most: it counts *stories*. **Eighteen public
components had none** — and nothing else rendered them either — so zero of the 800 combinations had
ever laid one out. Rendering them found **two real defects**, both `critical`/naming failures in
shared components, both fixed here.

The matrix is now **106 stories, 848/848 contrast, 848/848 keyboard, 0 excluded**, and the 800
pre-existing rows are **identical field by field** to the 1.4.0 oracle.

## 2. Objective

Find the next highest-value confirmed issue after Phase 8.12 by measuring the repository, and fix it
at the layer that owns it.

## 3. Starting state, verified rather than assumed

| | Measured |
| --- | --- |
| Platform branch / HEAD | `claude/sidebar-nav-contrast-fix-nhpu3b` · `28603da`, clean |
| Docs branch / HEAD | same branch · `0492e9c`, clean |
| Published version | **1.4.0**, `latest` |
| Docs consumes | `^1.4.0`, resolved from the registry store |
| Matrix | 100 stories · 4 brands · 2 schemes · 800 + 800 · 0 excluded · 0 failures |
| Interactive / static | 528 / 272 |
| Suite | 49 accessibility tests, 14 proofs |
| axe ruleset | full, less three page-structure rules Docs enforces on real routes |

## 4. Measurement methodology

Phase 8.12 closed the last obvious question about *what* is checked: the ruleset is now the full one.
The question this phase asked instead was **what is checked against**, which is a different thing and
had never been measured.

The audit that produced the finding is a static scan of the package, deliberately made reproducible
and then checked in as a test rather than left as a one-off script:

1. Collect every PascalCase value exported from a `.tsx` file — the things that can actually be put
   on a page.
2. Keep those re-exported from an `index.ts` barrel: the surface an application can import, and
   therefore the surface the platform is on the hook for.
3. Mark a component **rendered** if a story renders it (as a JSX tag, or as `Meta.component`), or if
   another source component renders it.
4. Anything in neither set has never been on a page under any check the repository runs.

The remaining candidate audits were run and are recorded in §15, not folded into this scope.

## 5. Baseline measurements

| | Measured |
| --- | --- |
| Renderable public exports | **172** |
| Story files | 33 |
| Exports with no story of their own | 31 |
| Exports **rendered nowhere at all** | **18** |
| Combinations touching those 18 | **0 of 800** |

The 18, by shape:

| Group | Components | Why it went unnoticed |
| --- | --- | --- |
| Patterns with no story | `Progress`, `ReadinessRing`, `Stepper`, `CountUp`, `Reveal` | Nothing composes them; a product does |
| Form parts with no story | `Label`, `RadioGroup` | Composed by `Field`-based forms, not by these |
| Semantic table | `Table`, `THead`, `TBody`, `TR`, `TH`, `TD` | `DataGrid` has stories and is a different component |
| Open-layer parts | `DropdownMenuGroup`, `DropdownMenuRadioGroup`, `DropdownMenuRadioItem`, `PopoverClose`, `CommandSeparator` | Exist only while their layer is open, and no story opened one containing them |

## 6. Findings

### Finding 1 — `Progress` shipped a progressbar with no accessible name

```html
<div role="progressbar" aria-valuenow="40" aria-valuemin="0" aria-valuemax="100"
     aria-label={undefined}>
```

- **Component**: `@munaxa/platform` · `ui/patterns/progress.tsx`
- **Reproduction**: render `<Progress value={40} />` — i.e. omit the optional `label`
- **Measured**: axe `aria-progressbar-name`; announced as "progress bar, 40 percent"
- **Expected**: a name saying *what* is at forty percent
- **Frequency**: every call site that omits `label`, in all four brands and both schemes
- **Severity**: WCAG 4.1.2 — serious
- **Category**: **A**, genuine platform defect

The component's own doc comment said "Accessible (role=progressbar)". It had the role and not the
name, which is the half that a screen-reader user can hear.

### Finding 2 — `CommandSeparator` made every palette that used it an invalid listbox

```html
<div cmdk-list role="listbox" aria-label="Suggestions">
  <div cmdk-group role="presentation">…</div>
  <div cmdk-separator role="separator"></div>   <!-- not allowed here -->
  <div cmdk-group role="presentation">…</div>
</div>
```

- **Component**: `@munaxa/platform` · `ui/components/forms/command.tsx`
- **Reproduction**: any `CommandList` containing a `CommandSeparator`, while the palette is open
- **Measured**: axe `aria-required-children`, impact **critical**, on 8/8 combinations of the story
  that first rendered it
- **Expected**: ARIA lets a `listbox` own `option` and `group`, and nothing else
- **Frequency**: every product palette with a rule between two groups
- **Severity**: critical — a screen reader is entitled to disregard options it cannot account for
- **Category**: **A**, genuine platform defect

### Finding 3 — a defect in this phase's own story, not in the product

The first version of the new `OpenLayerParts` story used Radix's `open` prop to render the layers
open. `open` is the *controlled* prop; with no `onOpenChange` it pins the layer open, so Escape
genuinely does nothing. The matrix failed all eight combinations with `K5 Escape did not close`.

- **Category**: **C**, story/test fixture problem
- **Fix**: `defaultOpen` — uncontrolled, open on arrival, and closable

Recorded because the tempting move was the wrong one. Three components would have been reported as
having broken Escape handling, and the "fix" would have been a change to `DropdownMenu` and `Popover`
to work around a mistake in a story. A harness defect must not become a product defect.

The same first version also rendered an inline `Command` to cover `CommandSeparator`, which the
classifier read as a `combobox` — correctly, since `cmdk` gives its input `role="combobox"` — and
then required Escape to close something with no closed state to return to. That story shape does not
exist in any product. `CommandSeparator` is now covered where it actually lives: in the palette,
which `Selection/Palette` already opens under the matrix.

## 7. Root cause

Discovery reads `storybook-static/index.json` and iterates its entries. That is the right source for
"which stories exist" and it structurally cannot answer "which components exist". A component nobody
wrote a story for is not excluded and not skipped — the matrix never learns it is there, and reports
green because it was never asked.

`EXCLUDED` being empty and asserted empty since Phase 8.5 made this harder to see, not easier. The
suite could prove that nothing had been *removed* from its coverage while never being able to notice
what had never been *added*.

Both defects are the ordinary consequence: `Progress` and `CommandSeparator` are public, documented,
covered by the semver contract, and were exercised by nothing.

## 8. Ownership decision

| Layer | Owns | Decision |
| --- | --- | --- |
| `@munaxa/platform` component | `Progress`'s name, `CommandSeparator`'s role | **Fixed here.** Both are wrong for every consumer, so no application can be the right place |
| Story | Whether a component is ever rendered | **Fixed here.** New stories, plus a separator added to the existing palette story |
| Test harness | Whether the gap can reopen | **Fixed here.** `ui/story-coverage.test.ts` |
| `cmdk` | Writes `role="separator"` after the prop spread | **Not modified**; worked around inside our own wrapper — see §9 |

A Docs-side fix was never a candidate for either defect: an application cannot give a progressbar a
name it was not offered, and cannot reach inside a palette's list.

## 9. Implementation

### `Progress` — a defaulted label

```ts
export function Progress({ value, tone = 'default', size = 'md', label = 'Progress', … })
```

Defaulted rather than made required. Making `label` required would be a breaking change for a fix,
and the package already has this exact shape twice — `Breadcrumb`'s `label = 'Breadcrumb'` and
`InspectorLayout`'s `inspectorLabel = 'Inspector'`. The prop's documentation now says why it is
defaulted and asks for something specific.

### `CommandSeparator` — out of the accessibility tree

```ts
<CommandPrimitive.Separator className={…} aria-hidden="true" {...props} />
```

`role="presentation"` says it more directly and **cannot be used**: `cmdk` writes
`role="separator"` *after* its own prop spread, so the role is not overridable from here. That was
measured, not assumed — the first attempt passed `role="presentation"` and the regression test still
reported `role=separator`.

Replacing the primitive with our own `<div>` was the alternative and was rejected: `cmdk`'s separator
hides itself while a search is active, which is real behaviour that would have been lost to work
around an attribute. `aria-hidden` passes through untouched and takes the divider out of the
accessibility tree, which is the same outcome by the only route the dependency leaves open. The
divider carries no information a listener needs — the groups it sits between are already named.

### Coverage — `ui/patterns/uncovered.stories.tsx`

Six stories bringing seventeen of the eighteen onto the page, in the states a product uses rather
than one happy default: `Progress` in four tones plus the unlabelled default, three `ReadinessRing`s, a
`Stepper` mid-flow, `Label` bound to a real `Input`, a `RadioGroup`, the six table primitives with
both `scope="col"` and `scope="row"` headers, and the dropdown and popover open on arrival.

The eighteenth, `CommandSeparator`, sits in `Selection/Palette` instead — the matrix already opens
that palette, and a separator belongs in one.

### The ratchet — `ui/story-coverage.test.ts`

Three assertions:

1. Every renderable public export is rendered by a story or by another component.
2. The scan actually found the surface it is guarding — a regex that silently matched nothing would
   pass assertion 1 vacuously.
3. Nothing in the exemption list is stale: an entry that becomes rendered, or stops being public,
   fails the test.

The exemption list is seven `ContextMenu` sub-parts. Radix's `ContextMenu` root has no `open` prop —
it opens on the browser's `contextmenu` event and nothing else — so unlike `DropdownMenu` and
`Popover` its sub-parts cannot be brought onto the page from a story at all. Covering them needs the
matrix to dispatch the event, which is a change to the harness rather than to a story; §15 carries
it. The exemption buys those seven no accessibility relief whatsoever, and assertion 3 means it
cannot quietly become a place to hide a real gap.

## 10. Regression proof

Each fix has a discriminating proof, run in both directions:

| Proof | With fix | Fix reverted | Restored |
| --- | --- | --- | --- |
| `Progress` names the bar with no label passed | ✓ | ✗ | ✓ |
| `Progress` + axe on the rendered component | ✓ | ✗ | ✓ |
| `CommandSeparator` is `aria-hidden`, so the listbox does not own it | ✓ | ✗ | ✓ |
| A palette with a separator has no violations | ✓ | ✗ | ✓ |
| `story-coverage` — every public component is rendered | ✓ | ✗ (25 reported) | ✓ |

The `story-coverage` revert is the new stories being removed, which is the change that would reopen
the gap; it reports all 18 plus the 7 exemptions.

Two proofs earned their place by failing first:

- The `CommandSeparator` proof rejected the **first** version of the fix. `role="presentation"` looked
  correct, typechecked, and did nothing, because `cmdk` overrides it. Without a test asserting the
  rendered attribute this would have shipped as a fix that fixed nothing.
- The matrix rejected the first version of the new story, which is how Finding 3 exists at all.

### Category-A verification at the matrix level

The `aria-required-children` violation was reported on **8/8 combinations** of the story that
rendered a separator, before the fix, by the same pipeline that now reports zero. The rule
demonstrably reaches the matrix rather than being nominally enabled.

## 11. Coverage

| | 1.4.0 | 1.4.1 |
| --- | --- | --- |
| Stories | 100 | **106** |
| Excluded | 0 | **0** |
| Contrast combinations | 800/800 | **848/848** |
| Keyboard combinations | 800/800 | **848/848** |
| Interactive / static | 528 / 272 | **544 / 304** |
| Public components rendered nowhere | 18 | **0**, less 7 recorded exemptions |
| Accessibility tests / proofs | 49 / 14 | 49 / 14 |
| Unit test files / tests | 24 / 528 | **27 / 538** |

### Row-level differential against the 1.4.0 oracle

Totals are not equivalence, and this phase changed discovery input, so the 1.4.0 tree was checked
out, Storybook rebuilt at 100 stories, and the matrix re-run to produce an oracle. Every
`(story, brand, scheme)` row was then compared field by field:

```
=== contrast ===
  before 800 rows · after 848 rows · shared 800
  only in before (removed): 0
  only in after  (added):   48
  field differences on shared rows: 0
=== keyboard ===
  before 800 rows · after 848 rows · shared 800
  only in before (removed): 0
  only in after  (added):   48
  field differences on shared rows: 0
EQUIVALENT ON SHARED ROWS
```

1,600 pre-existing rows, **zero** differences in violations, detected kinds, executed contracts,
failures or errors. **96 rows added, none removed** — the whole inventory change is the six new
stories, which is what §10 of the brief asks be explained rather than merely reported.

Concurrency makes a single differential worth little, so the fixed matrix was run **twice**
end to end and the two runs compared to each other:

```
=== contrast ===  shared 848 · removed 0 · added 0 · field differences 0
=== keyboard ===  shared 848 · removed 0 · added 0 · field differences 0
EQUIVALENT
```

Two independent 848-combination runs, identical row for row.

The added rows classify as: `progress-and-rings`, `steps`, `table-primitives` and `motion` as
`static`; `labels-and-radios` as `input, radio`; `open-layer-parts` as `button, dialog, menu`. The
new radio coverage is worth naming — `forms-overview--toggles` was the *only* story with a radio
group before this phase.

## 12. Performance

Not a target of this phase and not optimised. Recorded for continuity: the matrix runs 848 + 848
combinations in **690s** wall-clock against 800 + 800 in **659s** on the same machine — 6% more
combinations for 5% more wall-clock, within the noise band Phase 8.10 measured (294/362/441s for
identical code). No worker count, timeout or stabilisation delay was changed.

## 13. Gates

| Gate | Result |
| --- | --- |
| `format:check` | clean |
| `lint` | 32/32 |
| `typecheck` | 32/32 |
| `test` | 26/26 tasks — platform 27 files, **538 tests** |
| `check:faded` | no faded foreground text in `ui` |
| `validate:contract` · `validate:tokens` | 66 roles × 4 themes × 2 schemes · 49 values |
| `build` | 20/20 |
| `build-storybook` | success, 106 stories |
| `release:check` | all checks passed |
| `test:a11y` | **49/49**, contrast 848/848, keyboard 848/848, 0 excluded |

## 14. Release evidence

**Version 1.4.1** — PATCH. Both changes are accessibility corrections with no API change:
`Progress.label` was already an optional prop and only its default changed, and `CommandSeparator`
gained an ARIA attribute. `VERSIONING.md` names "an accessibility correction, with no API change" as
PATCH explicitly.

| Step | Evidence |
| --- | --- |
| CI on PR [#11](https://github.com/munaxa/munaxa-platform/pull/11) | Lint/Typecheck/Test/Build ✓, Façades ✓, **Accessibility matrix ✓** |
| Merged to `main` | `4edf8e1` |
| Release workflow | run #10, dispatched from `main`, `dry_run=false`, **success** |
| Registry | `npm view` → versions include **1.4.1**, `latest` → **1.4.1** |
| Published tarball | 503 files, **zero** test/spec/story/storybook/harness entries |
| Fixes in the artifact | `label = 'Progress'` in `progress.js`, `"aria-hidden": "true", ...props` in `command.js` |
| Docs dependency | `^1.4.1` |
| Lockfile | registry tarball + `sha512` integrity; no `file:`, `link:`, `workspace:` or local tarball |
| Clean frozen install | `node_modules` wiped, `pnpm install --frozen-lockfile` → resolves `@munaxa+platform@1.4.1` |
| Installed artifact | version 1.4.1, both fixes present in `apps/web/node_modules` |
| Clean production build | `.next` and Turbo caches removed; 9/9 tasks, compiled successfully |

### Docs verification against the installed 1.4.1

| Suite | Result |
| --- | --- |
| `format:check` · `lint` · `typecheck` | clean · 13/13 · 13/13 |
| `test` (logic + a11y) | 13/13 tasks — web 176, api 649 (+1 skipped), domain 164 |
| `build` | 9/9 from a wiped cache |
| `test:e2e` | **130/130**, nine suites — see below |

The full `e2e` project, which drives the built application in a real browser against a real
PostgreSQL and Redis — **130/130, nine suites, zero skipped**:

| Suite | Result |
| --- | --- |
| `consistency.e2e` | **12/12** |
| `shell.e2e` | **8/8** |
| `search.e2e` | **23/23** |
| `dashboard.e2e` | **19/19** |
| `recent-empty.e2e` | **15/15** |
| `faded-text.e2e` | **4/4** |
| `datagrid-keyboard.e2e` | **3/3** |
| `signing.e2e` | **27/27** |
| `recovery.e2e` | **19/19** |

Two of those needed local infrastructure to run at all rather than to pass, which is worth recording
because both first reported as **skipped** and a skipped suite is not evidence of anything.
`signing.e2e` launches Playwright's headless-shell build and this container has
`chromium_headless_shell-1194` where the pinned client wanted `-1234`; it passes with `CHROMIUM_PATH`
set. `recovery.e2e` restores *beside* the source cluster and needs an empty destination, so a second
PostgreSQL cluster was started for it. Neither is a platform matter and neither assertion was
changed.

**No Docs test needed changing this release.** The `datagrid-keyboard.e2e` version assertion is the
floor introduced in Phase 8.12 rather than a pin, so 1.4.1 satisfied it without an edit — which is
the behaviour that change was made for.

## 15. Deferred findings

- **Seven `ContextMenu` sub-parts remain unrendered**, recorded in `NOT_RENDERED` with the reason.
  Covering them needs the matrix to dispatch a `contextmenu` event before axe — a harness change of
  the same shape as the existing `INTERACTIONS` entry for the palette. Scoped out here to keep this
  phase to one coherent objective; it is the natural next accessibility increment.
- **Thirteen components have no story of their own but are rendered by a parent** (`ScrollBar`,
  `TooltipTrigger`, `AvatarImage`, `FieldProvider`, `PopoverAnchor` and others). They are measured,
  but only in whatever state their parent happens to render. Lower value than the eighteen, and not
  free of risk.
- **The `e2e` project does not run in CI.** It needs PostgreSQL, Redis and a browser, and
  `.github/workflows/ci.yml` has no job for it — the integration job covers a different suite. It
  therefore runs only where somebody stands the infrastructure up, which this phase did. That is a
  reliability finding in its own right and a candidate objective for a later phase; it was measured
  here, not fixed.
- **One viewport** (1280×900), unchanged since Phase 8.4.
- **`Combobox` still does not open on ArrowDown** — an ARIA authoring-practice enhancement, not an
  operability defect. Carried since Phase 8.9.
- **`@munaxa/audit` and `@munaxa/rbac` wall-clock assertions** remain flaky in CI. Named out of scope
  by §17 of this brief and not touched.
- **Cloudflare `Workers Builds: platform-storybook`** remains red, as since before Phase 8.8. It is a
  deployment check outside the release chain.

## 16. Corrections to earlier assumptions

Recorded rather than quietly fixed, per the standing rule. No previous report has been edited.

1. **My own first scan of this phase was wrong and its numbers should not be used.** It walked only
   `ui/` and reported 7 components rendered nowhere, having missed the `brand/` story file entirely
   and produced false positives for `ProductLogo`, `ProductSwitcher` and `BrandProvider`. The
   corrected scan covers the whole package and is the one checked in as
   `ui/story-coverage.test.ts`; it reports **18**. Everything in §5 onwards is from the corrected
   scan.
2. **A regex detail that would have produced a false positive.** Matching JSX as
   `<([A-Z][A-Za-z0-9]*)[\s/>]` silently misses `<OrgChart<Person>`, so a generic component would
   have been reported as never rendered while `board.stories.tsx` renders it twice. The trailing
   class admits `<`, and the reason is commented at the constant.
3. **Phase 8.12's report gives the unit-test count as "421 component tests".** The platform package's
   own `vitest run` reported 528 immediately before this phase's changes. The two numbers are not
   reconciled here and 8.12's has not been edited; §11 and §13 use the directly measured 528 → 538.

## 17. Final state

| | |
| --- | --- |
| Platform | `claude/sidebar-nav-contrast-fix-nhpu3b`, merged to `main` as `4edf8e1`, tree clean, pushed |
| Docs | same branch, tree clean, pushed |
| Published | `@munaxa/platform@1.4.1`, `latest` |
| Docs consumes | `^1.4.1`, resolved from the registry store |
| Matrix | 106 stories · 848 contrast · 848 keyboard · **0 excluded · 0 failures** |
| Public components rendered nowhere | **0**, less 7 recorded and re-checked exemptions |
| Hidden failures | none — the two the matrix found are §6 Findings 1 and 2, both fixed; the one it found in this phase's own story is §6 Finding 3 |
