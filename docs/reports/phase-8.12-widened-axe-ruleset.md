# Phase 8.12 — Widening the Accessibility Ruleset

## 1. Status

**COMPLETE.** Released as 1.4.0, verified on the registry, and consumed by Docs from it.

The accessibility matrix has run exactly **one** axe rule since Phase 8.4. Widening it found **three
real defects** in shared platform components, all fixed here, with the matrix green at **800/800**
under the wider ruleset and the per-combination inventory identical to 1.3.1 row by row.

`@munaxa/platform` **1.4.0** is published through the official workflow and consumed by Docs from the
registry — §11 carries the evidence.

## 2. Starting state, verified rather than assumed

| | Measured |
| --- | --- |
| Platform branch / HEAD | `claude/sidebar-nav-contrast-fix-nhpu3b` · `cffb99a`, clean |
| Docs branch / HEAD | same branch · `4106d8e`, clean |
| Published version | **1.3.1**, `latest` |
| Docs consumes | `^1.3.1`, resolved from the registry store |
| Matrix | one shared canonical render, contrast then keyboard |
| Inventory | 100 stories · 4 brands · 2 schemes · 800 + 800 · 0 excluded |
| Suite | 48 tests, 13 proofs |

## 3. The audit that chose the work

The longest-standing deferred item — carried by Phases 8.6, 8.7, 8.9, 8.10 and 8.11 — was that axe
ran with `runOnly: ['color-contrast']`. One rule. Everything else axe knows about ARIA, names, roles
and landmarks was unchecked across all 800 combinations.

A survey with the **full** ruleset over 100 stories reported **221 violation nodes across six rules**:

| Rule | Impact | Nodes | Stories | Category |
| --- | --- | --- | --- | --- |
| `landmark-one-main` | moderate | 95 | 95 | page structure |
| `page-has-heading-one` | moderate | 81 | 81 | page structure |
| `region` | moderate | 37 | 5 | page structure |
| `landmark-unique` | moderate | 6 | 6 | **real** |
| `aria-prohibited-attr` | serious | 1 | 1 | **real** |
| `scrollable-region-focusable` | serious | 1 | 1 | **real** |

## 4. Page-structure rules: scoped, not suppressed

`landmark-one-main`, `page-has-heading-one` and `region` cannot be satisfied by a component rendered
alone in an iframe. A `Badge` has no `<main>`, no `<h1>` and no landmark to sit inside — and it never
should. Those belong to the application that assembles components into a screen.

The evidence that turning them off here hides nothing: **Munaxa Docs runs `axe.run(document)` with no
`runOnly`** — the complete ruleset — against `/audit`, `/approvals`, `/reports`, `/admin/users` and
`/documents`, and reports zero violations. The rules are enforced by the layer that owns them.

Three rules are disabled and only three. Adding a fourth would need the same standard: evidence that
it cannot apply to a component in isolation, and evidence that something else checks it.

## 5. Three real defects, each fixed at its owning layer

### `Breadcrumb` announced nothing where it had collapsed crumbs

```html
<span class="flex size-5 …" aria-label="Hidden levels">
  <svg aria-hidden="true">…</svg>
</span>
```

`aria-label` on a `<span>` with no role is prohibited by ARIA, so assistive technology discards it.
The icon inside is `aria-hidden`. The net effect: a screen-reader user heard the first crumb, then
the last two, with **no indication that levels had been omitted**. The name is now real text in an
`sr-only` span — the pattern already used by `Gantt`, `Kanban` and `Workflow`.

### `ScrollArea`'s viewport could not be reached from the keyboard

The Radix viewport rendered with `overflow: hidden scroll`, no `tabindex`, and content with nothing
focusable in it. Anyone not using a mouse could not scroll it, so whatever had overflowed was simply
unavailable — WCAG 2.1.1. `tabIndex={0}` is the remedy the rule itself names.

### The shell emitted two nameless `complementary` landmarks

Two `<aside>` elements with no accessible name — the navigation rail and `InspectorLayout`'s panel —
so a landmark list showed two entries it could not tell apart. This fired on **32 combinations**:
every `AppShell` story, in all four brands and both schemes.

Each half needed a different answer, which is why it is worth stating separately:

- The **rail** is a container holding brand, the navigation and a footer slot. The landmark that
  matters is the `<nav>` inside, which already carries its own name. Wrapping it in an unnamed
  `complementary` landmark added noise, so the wrapper is now a `<div>`. Removing a redundant
  landmark beats inventing a name for it.
- The **inspector** genuinely is complementary content beside the main pane, so it keeps its
  `<aside>` and gains a name, overridable through the new `inspectorLabel` prop — matching every
  other label in the package, because an application with two inspectors or another language has to
  be able to say so.

### What was *not* a component defect

`landmark-unique` also fired where two stories rendered several instances of the same component.
`Breadcrumb`'s own prop documentation says to override `label` for a second trail on a page, and
`FileManager` exposes the same override; the stories used neither. Fixed in the stories, with the
rule left enabled so future duplicates are caught.

## 6. Proof that each fix was needed

Reverting either component fix turns **three of the four** new unit tests red:

| Test | Without the fix |
| --- | --- |
| Breadcrumb announces collapsed crumbs | ✗ |
| Breadcrumb names no role-less element | ✗ |
| ScrollArea viewport is a Tab stop | ✗ |
| Breadcrumb keeps a short trail intact | ✓ (unrelated, stays green) |

## 7. Proof that the widened ruleset is live

A green matrix under a wider ruleset is only meaningful if the new rules can fail. **Proof M**
injects the exact shape found in `Breadcrumb` — a role-less span carrying a name with only an
`aria-hidden` child — and requires `aria-prohibited-attr` to be reported, then requires no
page-structure rule to appear.

Its first version injected a span **with text content** and reported nothing. That is a fact about
the rule rather than about the harness: axe flags the unusable *name*, not the attribute in
isolation. Recorded because it is exactly the kind of detail that turns a proof into decoration.

Corroborating evidence from the run itself: before the shell fix, this same pipeline reported 32
`landmark-unique` violations. The wider rules demonstrably reach the matrix.

## 8. An instrument bug, caught loudly

The first widened run failed **all 800 combinations** with `ReferenceError: RULES is not defined` —
the rule configuration is a Node-side constant and I had referenced it inside the browser callback.

Worth recording for two reasons: the suite reported every combination as a failure rather than
silently measuring nothing, which is the behaviour a load failure is supposed to have; and the
ledger's `axe` count would have contradicted the combination count either way.

## 9. Results

| | Before | After |
| --- | --- | --- |
| axe rules run | **1** | full ruleset less 3 page-structure rules |
| Contrast combinations | 800/800 | **800/800** |
| Keyboard combinations | 800/800 | **800/800** |
| Violations under the wider ruleset | (unmeasured) | **0** |
| Stories / excluded | 100 / 0 | 100 / 0 |
| Interactive / static | 528 / 272 | 528 / 272 |
| Suite tests / proofs | 48 / 13 | **49 / 14** |

**Differential against the 1.3.1 oracle**: 1 600 rows compared field by field —

```
=== contrast ===  rows 800/800 · missing 0 · extra 0 · field differences 0
=== keyboard ===  rows 800/800 · missing 0 · extra 0 · field differences 0
EQUIVALENT
```

Three components changed their DOM and nothing in the inventory moved, which is the evidence that
the fixes are additive rather than behavioural.

## 10. Gates

| Gate | Result |
| --- | --- |
| `eslint` · `tsc --noEmit` · `format:check` | 32/32 · 32/32 · clean |
| `pnpm test` | 26/26 tasks — 421 component tests, 4 new |
| `check:faded` · `validate:contract` · `validate:tokens` | clean · 66 roles · 49 values |
| `build` · `build-storybook` | 20/20 · success |
| `test:a11y` | **48/48**, contrast 800/800, keyboard 800/800, 13 proofs |

## 11. Release and consumption

**Version 1.4.0** — MINOR, because `inspectorLabel` is a new optional prop; the three fixes alone
would have been a PATCH.

| Step | Evidence |
| --- | --- |
| CI on PR [#10](https://github.com/munaxa/munaxa-platform/pull/10) | lint/typecheck/test/build, façades, and the widened accessibility matrix all green |
| Merged to `main` | `28603da` |
| Release workflow | dispatched from `main`, `dry_run=false` |
| Registry | `npm view` → versions include **1.4.0**, `latest` → **1.4.0** |
| Published tarball | 503 files, **zero** test/spec/story/storybook/harness/instrumentation entries |
| Fixes in the artifact | `sr-only` in `breadcrumb.js`, `tabIndex: 0` in `separator.js`, `inspectorLabel` in `split.js`, and **no `aside` element** created in `sidebar.js` — the only match there is the explanatory comment |
| Docs dependency | `^1.4.0` |
| Lockfile | registry tarball + integrity hash; no `file:`, `link:`, `workspace:` or local tarball |
| Clean frozen install | `node_modules` wiped, `pnpm install --frozen-lockfile` → resolves `@munaxa+platform@1.4.0` |
| Installed artifact | version 1.4.0, both component fixes present |
| Clean production build | `.next`, Turbo caches removed; `cache miss`, compiled successfully, 9/9 tasks |

### Docs verification against the installed 1.4.0

| Suite | Result |
| --- | --- |
| `consistency.e2e` | **12/12** |
| `shell.e2e` | **8/8** |
| `search.e2e` | **23/23** |
| `dashboard.e2e` | **19/19** |
| `recent-empty.e2e` | **15/15** |
| `faded-text.e2e` | **4/4** |
| `datagrid-keyboard.e2e` | **3/3** |

Gates: format, lint 13/13, typecheck 13/13, test 13/13, `verify:styles` (251 utility classes), build
9/9.

### One Docs test needed changing, and why that is not a weakened assertion

`datagrid-keyboard.e2e` failed on 1.4.0 — not on behaviour, but on a version **pin** I wrote in Phase
8.8: `expect(manifest?.version).toBe('1.3.1')`. Both behavioural assertions (the menu opens on
Enter; the row does not activate) passed.

The pin is now a floor: the installed version must be **at least 1.3.1**, the release where the
`DataGrid` fix landed, and must still resolve from `node_modules/.pnpm/@munaxa+platform@`. The claim
it makes — that Docs consumes the published artifact carrying the fix — is unchanged; what changed is
that it no longer fails on every future release for no accessibility reason, which would have taught
a team to edit the test rather than read it.

**The predicted `ScrollArea` consequence did not materialise.** Its viewport is now a Tab stop, but
no Docs suite counts tab stops on a screen containing a scroll area, so nothing moved.

## 12. Known release-reliability finding, recorded not fixed

The first CI run failed on **`@munaxa/rbac#test`** — the wall-clock assertion documented in Phase 8.6
§13 and named in this phase's brief §18 as out of scope. `@munaxa/platform:test` passed in that same
run. The job was re-run and went green; the timing budgets were not touched.

The Cloudflare **`Workers Builds: platform-storybook`** check remains red, as it has been since
before Phase 8.8. It is a Storybook deployment check outside the release chain, and its detail lives
in a dashboard this session cannot reach.

## 13. Limitations, unchanged

- One viewport (1280×900).
- `Combobox` still does not open on ArrowDown — an ARIA authoring-practice enhancement, not an
  operability defect.
- The three page-structure rules are checked by Docs on real routes, not by the component matrix.
