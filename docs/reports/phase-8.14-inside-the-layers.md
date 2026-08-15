# Phase 8.14 — What Is Inside the Layers

## 1. Status

**COMPLETE.** Released as 1.4.2, verified on the registry, and consumed by Docs from it.

The contrast matrix measures the **canonical** render — the story as a person meets it on arrival —
and exactly **one** story out of 106 was opened before axe ran. A runtime census counted **79
collapsed** disclosure nodes against **9 expanded**: the *contents* of almost every menu, popover,
select and time list had never been through a single rule. Opening them found **four defects in
shared components**, one of which made a control completely unusable from the keyboard.

The canonical matrix is unchanged at **848/848 contrast and 848/848 keyboard**, identical to 1.4.1
row for row, and a new overlay pass now checks **74 opened layers** on every run.

## 2. Objective

Find the next highest-value confirmed problem in the platform or its verification architecture,
establish ownership, fix only the appropriate scope, and prove the result.

## 3. Starting state, verified rather than assumed

Every figure below was re-measured rather than read from the Phase 8.13 report; all of them matched.

| | Reported by 8.13 | Measured here |
| --- | --- | --- |
| Platform `main` | `4edf8e1` | `4edf8e1` ✓ |
| Published version | 1.4.1 | 1.4.1 ✓ |
| Docs dependency / installed | `^1.4.1` | `^1.4.1`, installed 1.4.1 ✓ |
| Stories | 106 | 106 ✓ |
| Story files | 33 | 33 ✓ |
| Contrast / keyboard | 848/848 | **848/848, 0 errors, 0 violations** ✓ |
| Accessibility tests | 49 | 49 ✓ |
| Coverage ratchet | passing | 3/3 ✓ |
| Platform CI jobs | — | 3: verify, accessibility, façades |

One correction to my own process, not to the report: I began by checking out `main`, which was a
stale local branch at `28603da`, and briefly measured a 1.4.0 tree. Caught immediately by the
version check and re-based on `origin/main`. Nothing measured in this report comes from that state.

## 4. Baseline measurement

### A. Component coverage

The 8.13 ratchet passes: every renderable public export is rendered by a story or another component,
less the seven recorded `ContextMenu` exemptions.

### B. Story quality — the states a component actually reaches

This is the area §5C names and nothing had ever measured. A source scan of state props reported 23
components with an unexercised state, and **it is not trustworthy**: it reported `TabsTrigger.selected`
(an internal variable, not a prop) and `CommandSeparator.open` (bled from a neighbouring interface).
Recorded because it nearly became the finding.

So the states were counted at **runtime** instead, across all 106 stories:

| State | Nodes | Stories |
| --- | --- | --- |
| `aria-expanded="false"` | **79** | **27** |
| `aria-expanded="true"` | **9** | **5** |
| `aria-describedby` | 71 | 24 |
| skeleton / pulse | 69 | 4 |
| `aria-live` / status / alert | 39 | 28 |
| `aria-current` | 28 | 17 |
| disabled | 19 | 13 |
| `aria-invalid` | 7 | 7 |
| `aria-busy` | 3 | 3 |
| `aria-errormessage` | **0** | 0 |

The first two rows are the finding. Almost every disclosure widget in the matrix is measured only
while it is shut.

### C. Verification infrastructure

`INTERACTIONS` — the map of stories opened before axe — contains exactly **one** entry.

### D. What the closed layers were hiding

Each of the 79 collapsed triggers was opened from a fresh render and axe run on the result.

**The first attempt was wrong and its numbers are void.** It used `element.click()`, and Radix opens
on `pointerdown`, so only **26 of 79** triggers actually opened; it reported 5 findings and would
have called the other 53 clean. Rerun with real pointer events, **74 of 79** open. This is recorded
because the failure mode is silent: a probe that cannot reach what it measures reports good news.

| Rule | Nodes | Triggers |
| --- | --- | --- |
| `aria-hidden-focus` | 119 | 44 |
| `aria-required-children` (critical) | 4 | 3 |
| `scrollable-region-focusable` (serious) | 2 | 1 |

## 5. Candidate findings

| # | Finding | Category | Frequency | Owner | Selected |
| --- | --- | --- | --- | --- | --- |
| 1 | Overlay contents never measured — 1 of 106 stories opened before axe | infrastructure | 78 of 79 triggers | test harness | **yes** |
| 2 | `TimePicker` popup keyboard-inoperable | **A** | every use of the component | platform | **yes** |
| 3 | Shell menus own no menu items | **A** | 2 of 3 shell menus | platform | **yes** |
| 4 | Combobox family put non-options in a `listbox` | **A** | 3 components, busy + empty states | platform | **yes** |
| 5 | `aria-hidden-focus` ×119 | **D**, proven | modal overlays | — | exempted, §7 |
| 6 | 7 `ContextMenu` sub-parts unrendered | low | **Docs uses zero `ContextMenu`** | platform | no — §14 |
| 7 | Docs E2E has no CI job | infrastructure | — | CI | no — §14 |
| 8 | `Combobox` ArrowDown | enhancement | — | platform | no — §14 |
| 9 | Single viewport | limitation | — | harness | no — §14 |

Findings 1–4 are one causal chain: the harness never opened a layer, so four defects lived inside
them. That is the coherent scope, and it is the same shape as Phase 8.12 — widen what is measured,
fix what that finds.

## 6. Selected finding, in detail

### 6.1 `TimePicker` — a control a mouse could use and a keyboard could not

- **Component**: `ui/components/date/time-picker.tsx`
- **Reproduction**: open the time list, press ArrowDown
- **Measured**: popup contains **0** tabbable elements; focus lands on a `tabindex="-1"` container;
  after **85** ArrowDown presses `scrollTop` is still `0`, the selection is still the first option,
  and `aria-activedescendant` is `null`. The list scrolls **1 544px inside 224px**.
- **Consequence**: a person not using a mouse can open the times and then choose nothing but the one
  already chosen — WCAG 2.1.1, **more severe than the `scrollable-region-focusable` axe reported**
- **Category**: **A**

### 6.2 Shell menus — `role="menu"` owning no menu items

```html
<div role="menu">
  <div class="px-2 py-1.5 …">Switch organisation</div>
  <div role="separator"></div>
  <div dir="ltr" class="relative overflow-hidden max-h-72">   <!-- ScrollArea; items are in here -->
```

- **Component**: `ui/shell/menus.tsx` — `OrganizationSwitcher`, `NotificationMenu`
- **Measured**: `aria-required-children`, **critical**, on both. `UserMenu` has no `ScrollArea` and
  was clean, which is the control case.
- **Category**: **A** — the component renders this structure; no application could avoid it

### 6.3 The combobox family — non-options inside a `listbox`

- **Components**: `Combobox`, `MultiSelect` (`combobox.tsx`), `Autocomplete` (`autocomplete.tsx`)
- **Measured**: `aria-required-children`, **critical**, on the busy state; and again on the *empty*
  state, which is the subtler half — `cmdk` renders its empty message `role="presentation"`, and a
  listbox whose only child is presentational has, as far as ARIA is concerned, **no required
  children at all**. A listbox with nothing in it passes; a listbox holding only a message does not.
- **Category**: **A**

## 7. `aria-hidden-focus`: Category D, and the measurement that earns it

119 nodes, and every one of them is the page *behind* an open modal menu — Radix hides the siblings,
axe reports the focusable elements inside them. "Known false positive" is an assertion, so it was
measured: with a menu open, across **three separate stories**, **0 of 30** Tab presses landed inside
the hidden region. Focus is genuinely trapped, which is the condition the rule protects.

The exemption is scoped to the overlay pass and to this one rule. It stays enabled in the canonical
matrix, where nothing is `aria-hidden`, and `test/setup.ts` already documents the same exemption for
portalled layers in the unit suite.

## 8. Ownership

| Layer | Owns | Decision |
| --- | --- | --- |
| `@munaxa/platform` component | the three ARIA structures and the inert popup | **fixed here** — wrong for every consumer |
| Test harness | whether a layer is ever opened | **fixed here** — `test/a11y/overlays.a11y.spec.ts` |
| `cmdk` / Radix | third-party internals | **not modified** |
| Docs | — | nothing to fix; an application cannot reach inside a component's popup |

## 9. Implementation

- **`TimePicker`** gains a visually hidden `CommandInput` — the element `cmdk` binds its keys to and
  the element Radix hands focus to. Arrow keys now move the active option, the list follows, Enter
  commits. No visible change.
- **`menus.tsx`** drops the `ScrollArea` and puts `max-h-* overflow-y-auto` on the menu content, so
  the menu owns its items directly.
- **`combobox.tsx` / `autocomplete.tsx`** move the busy text, the empty text and the footer outside
  the listbox, and add `aria-busy` plus a polite live region so arriving results are announced.
- **The overlay pass** opens every collapsed trigger from a fresh render — per-trigger isolation,
  the same discipline the keyboard contracts have needed since 8.9 — and asserts two things: the
  layer is valid, and a layer that *offers choices* can be operated.

### A contract of mine that was wrong

The operability check first required **every** opened layer to contain something focusable, and
promptly reported a prose disclosure panel and an empty notification menu as defects. Neither is
one: a panel of text is read, not operated, and an empty menu has nothing to offer. Narrowed to
layers containing options or menu items — which is the `TimePicker` case exactly — and derived from
rendered DOM rather than a list of story names.

### One brand, one scheme, deliberately

The overlay pass runs `docs`/`light`. What it measures is **markup** — which roles own which
children, and what can take focus — and neither varies with a palette. Colour in those same layers
is still measured by the canonical matrix across all eight combinations. Running it eight times
would multiply its cost by eight to re-assert identical DOM. Recorded here rather than discovered
later.

## 10. Regression proof

| Proof | With fix | Reverted | Restored |
| --- | --- | --- | --- |
| `TimePicker` popup has something focusable | ✓ | ✗ | ✓ |
| Combobox keeps busy text out of the listbox | ✓ | ✗ | ✓ |
| MultiSelect the same | ✓ | ✗ | ✓ |
| Autocomplete, busy | ✓ | ✗ | ✓ |
| Autocomplete, empty | ✓ | ✗ | ✓ |
| `OrganizationSwitcher` menu owns its items | ✓ | ✗ | ✓ |
| `NotificationMenu` the same | ✓ | ✗ | ✓ |
| **The overlay pass itself** | ✓ | **✗ (both menus named)** | ✓ |

### A proof of mine that was vacuous, and how it was caught

The first attempt to prove the overlay pass protective reported **green with the fix reverted** — a
result that should be impossible. The cause was mine: I had copied the backup file *after* applying
the fix, so "reverting" restored the fixed version over itself. Redone through `git checkout`, the
pass fails and names both menus.

Worth recording plainly. A regression proof that cannot fail is indistinguishable from one that
passes, and this phase exists because of a check that was never asked the question.

## 11. Coverage

| | 1.4.1 | 1.4.2 |
| --- | --- | --- |
| Stories / excluded | 106 / 0 | **106 / 0** |
| Contrast combinations | 848/848 | **848/848** |
| Keyboard combinations | 848/848 | **848/848** |
| **Opened layers measured** | **1** | **74** |
| Layers offering choices, checked operable | 0 | **54** |
| Accessibility tests | 49 | **52** |
| Unit test files / tests | 27 / 538 | **28 / 545** |

### Row-level differential against the 1.4.1 oracle

Five components changed their DOM. The canonical matrix was re-run and compared field by field:

```
=== contrast ===  shared 848 · removed 0 · added 0 · field differences 0
=== keyboard ===  shared 848 · removed 0 · added 0 · field differences 0
EQUIVALENT
```

1 696 rows, **zero** differences in violations, detected kinds, executed contracts, failures or
errors. The fixes are additive to the canonical state and everything new is in the new pass.

## 12. Performance

The overlay pass adds **176s** to the suite — 689s → 865s wall-clock on the same 4-CPU machine, for
74 layers that were previously unmeasured. No worker count, timeout or stabilisation delay was
changed. Restricting the pass to one brand and scheme is what keeps it at 176s rather than ~23
minutes; §9 records the reasoning.

## 13. Gates

| Gate | Result |
| --- | --- |
| `format:check` | clean |
| `lint` · `typecheck` | 32/32 · 32/32 |
| `test` | 26/26 tasks — platform 28 files, **545 tests** |
| `build` · `validate` · `check:faded` | 20/20 · clean · clean |
| `release:check` | all checks passed |
| `test:a11y` | **52/52** — contrast 848/848, keyboard 848/848, overlays 74/74 |

## 14. Deferred findings, each measured before deferring

- **7 `ContextMenu` sub-parts** remain unrendered. Measured before deferring again: **Docs uses zero
  `ContextMenu` anywhere**, and the five parts that a story does render are covered. The risk is
  low and the harness work is real, so it stays deferred on evidence rather than habit.
- **Docs E2E has no CI job.** Measured: it needs PostgreSQL, Redis and a browser; two of its nine
  suites need more still (an empty destination cluster for the DR rehearsal, a headless-shell
  binary). Docs CI already runs a real-PostgreSQL integration job and a Chromium accessibility job,
  so the uncovered ground is browser-level product flows rather than everything. Genuine gap,
  bigger than this phase's objective, and adding a CI job was not what the measurement pointed at.
- **`Combobox` ArrowDown** — carried since 8.9; still an APG enhancement, not an operability defect,
  and the control remains fully operable.
- **One viewport** (1280×900) — unchanged; no measurement in this phase touched it.
- **`aria-errormessage` is used 0 times** across the matrix. Noted for a future phase; the invalid
  states that exist use `aria-describedby`, which is valid.
- **`@munaxa/audit` / `@munaxa/rbac` timing flakes** — out of scope per §18 and untouched.
- **Cloudflare `Workers Builds: platform-storybook`** — still red, as since before 8.8, outside the
  release chain.

## 15. Corrections to earlier assumptions

No previous report has been edited. Three corrections, all to work done in this phase:

1. **The source scan of state props is not reliable** and its 23-component figure should not be
   quoted. It reported an internal variable and a neighbouring interface's prop as component states.
   Everything in §4B onwards is from the runtime census.
2. **The first overlay measurement reached only 26 of 79 triggers** because `element.click()` does
   not dispatch the `pointerdown` Radix opens on. Its numbers are void; §4D is the rerun.
3. **The first regression proof of the overlay pass was vacuous** — see §10.

## 16. Release and consumption

**Version 1.4.2** — PATCH. All four are accessibility corrections with no public API change;
`VERSIONING.md` states explicitly that the DOM structure a component renders is *not* part of the
contract.

| Step | Evidence |
| --- | --- |
| CI on PR [#12](https://github.com/munaxa/munaxa-platform/pull/12) | Lint/Typecheck/Test/Build ✓, Façades ✓, **Accessibility matrix ✓** |
| Merged to `main` | `c1b0072` |
| Release workflow | dispatched from `main`, `dry_run=false`, success |
| Registry | `npm view` → `latest` = **1.4.2** |
| Published tarball | 503 files, **zero** test/spec/story/storybook/harness entries |
| Fixes in the artifact | `CommandInput` in `time-picker.js`; `aria-busy` in `combobox.js` and `autocomplete.js`; **no `ScrollArea`** in `menus.js` — the single match there is the explanatory comment |
| Docs dependency | `^1.4.2` |
| Lockfile | registry tarball + integrity hash; **no** `file:`, `link:`, `workspace:` or local tarball |
| Clean frozen install | `node_modules` wiped, `pnpm install --frozen-lockfile` → resolves `@munaxa+platform@1.4.2` |
| Installed artifact | version 1.4.2 in `apps/web/node_modules` |
| Clean production build | `.next` and Turbo caches removed; `cache miss`, 9/9 tasks |

### Docs verification against the installed 1.4.2

| Gate | Result |
| --- | --- |
| `format:check` · `lint` · `typecheck` · `test` | clean · 13/13 · 13/13 · 13/13 |
| `build` | 9/9 from a wiped cache |

The `e2e` project — the built application in a real browser against real PostgreSQL and Redis —
**130/130 across nine suites**, but honestly it took two runs and the reason matters:

| Suite | Result |
| --- | --- |
| `consistency` · `shell` · `search` · `dashboard` | 12/12 · 8/8 · 23/23 · 19/19 |
| `recent-empty` · `faded-text` · `datagrid-keyboard` | 15/15 · 4/4 · 3/3 |
| `signing` · `recovery` | **27/27 · 19/19** — on a re-run, see below |

In the first full run `signing` failed twice and `recovery` skipped entirely. Neither is reachable
by a UI package: the signing failures were API-level, `401` where `403` and `429` were expected —
authentication, not markup — and `recovery` refuses to run unless its destination cluster is empty.
Both were artifacts of the local infrastructure I assembled by hand for this phase: Redis had been
restarted underneath a suite, and the DR destination cluster still held the previous phase's
restore. After flushing Redis and re-initialising an empty destination cluster, both pass.

Recorded this way rather than as a clean sweep, because "130/130" and "130/130 after I fixed my own
test rig twice" are different claims and only the second one is true.

**No Docs test needed changing.** The `datagrid-keyboard.e2e` version assertion is the floor
introduced in Phase 8.12, so 1.4.2 satisfied it untouched.

## 17. Final state

| | |
| --- | --- |
| Platform | merged to `main`, tree clean, pushed |
| Docs | same branch, tree clean, pushed |
| Published | `@munaxa/platform@1.4.2`, `latest` |
| Docs consumes | `^1.4.2` from the registry store |
| Canonical matrix | 106 stories · 848 contrast · 848 keyboard · 0 excluded · 0 failures |
| Overlay pass | 74 layers · 0 violations · 54 checked operable |
| Hidden failures | none |
