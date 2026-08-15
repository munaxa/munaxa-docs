# Phase 8.15 — The Routes Nobody Swept

## 1. Status

**COMPLETE.** Released as 1.4.3, verified on the registry, and consumed by Docs from it.

The measurement moved to the **application** layer. Munaxa Docs runs the full axe ruleset on **5 of
its 40 routes**. Sweeping the other thirty-five, in both themes, found `/admin/settings` — a screen
no accessibility check had ever visited — shipping **twelve controls with no accessible name at
all**, and the cause was an inconsistency inside `@munaxa/platform`: two of its four form controls
ignored the `Field` labelling contract that the other two honoured.

## 2. Objective

Find the next highest-value confirmed problem in the current repository, fix it at the owning layer,
and prove the fix.

## 3. Starting state, verified rather than assumed

| | Reported by 8.14 | Measured here |
| --- | --- | --- |
| Platform `main` | `c1b0072` | `c1b0072` ✓ |
| Docs HEAD | `66534b7` | `66534b7` ✓ |
| Published / installed | 1.4.2 | 1.4.2, resolved from the pnpm store ✓ |
| Stories / story files | 106 / 33 | 106 / 33 ✓ |
| Contrast · keyboard · overlays | 848 · 848 · 74 | **848/848 · 848/848 · 74, 0 violations** ✓ |
| Accessibility tests | 52 | 52 ✓ |
| Both trees | clean | clean ✓ |

One architectural fact worth stating because it had never been verified: Docs imports its UI from
`@munaxa/ui`, not from `@munaxa/platform`. `@munaxa/ui@1.1.1` is a **three-line façade** —
`export * from '@munaxa/platform'` — depending on `^1.3.0`, and pnpm resolves it to the single
installed 1.4.2. So platform fixes do reach product screens. Checked rather than assumed, because if
it had been a fork every accessibility fix since 1.3.1 would have stopped at the package boundary.

## 4. Baseline measurement

The component matrix is now thorough: components (8.13), states (8.14), overlays (8.14). What had
never been measured at comparable depth is the **application** — the composition the components end
up in.

`consistency.e2e` runs axe with the full ruleset on five routes. `apps/web/src/app/**/page.tsx`
defines **forty**. The suite's own comment records what that sample already cost once:

> `Badge` carried a serious `color-contrast` violation from Phase 5.2 until Phase 8.3: axe reported
> it on `/documents`, on a route this suite never visited, so the suite stayed green for three
> phases while the violation shipped.

The response then was to add one route. So the same measurement was run over **all 33 statically
addressable routes, in both themes** — 66 route×theme measurements, 0 errors:

| Rule | Impact | Nodes | Routes |
| --- | --- | --- | --- |
| `region` | moderate | 66 | all 33 |
| `button-name` | **critical** | **24** | `/admin/settings` |
| `color-contrast` | serious | 2 | `/admin/settings` |
| `landmark-unique` | moderate | 2 | `/admin/settings` |

Everything critical or serious was on one screen, and that screen was not in the sample.

## 5. Candidate findings

| # | Finding | Cat | Impact | Frequency | Owner | Selected |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `Switch`/`Checkbox` ignore the `Field` labelling contract → unnamed controls | **A** | **critical** | 24 nodes; every product that puts one in a `Field` | platform | **yes** |
| 2 | `text-muted` used as a text colour | **B** | serious | 2 nodes | Docs | yes — same route |
| 3 | Unknown setting groups all named "System" → duplicate landmark | **B** | moderate | 2 nodes | Docs | yes — same route |
| 4 | The axe sweep covers 5 of 40 routes | **C** | — | — | Docs harness | **yes** — it is what hid 1–3 |
| 5 | `region` on every route: the shell brand has no landmark ancestor | **A** | moderate | 66 nodes | platform | no — §16 |
| 6 | ContextMenu, E2E CI, ArrowDown, viewport, `aria-errormessage` | — | — | — | — | no — §16, re-measured |

### Why finding 1 outranks the others

- **Impact**: the only *critical* finding measured. A `role="switch"` with no accessible name is
  announced as "switch, on" with nothing to say what is on — twelve times on one settings screen.
- **Reach**: not one screen. It is a contract defect in a shared package, so it applies to every
  product that composes a `Switch` or `Checkbox` inside a `Field` — the composition the package's
  own documentation points at.
- **Reproducibility**: deterministic, and reproduced in three independent ways — the browser sweep,
  a DOM-level measurement of which controls the label resolves to, and a unit test.
- **Ownership**: unambiguous, and the evidence is that Docs had *already* worked around it —
  `SwitchField` wires `id`/`htmlFor` by hand. A host-side patch for a platform gap is the signature
  of a defect at the wrong layer.
- **Verification value**: fixing the contract makes an entire class of future call sites correct by
  default, rather than fixing one screen.

Findings 2 and 3 are included not as bundled cleanup but by necessity: finding 4's fix is to make
the sweep cover every route, and a gate that is red on the day it lands is not a gate. They are two
lines each, on the same screen, found by the same measurement.

## 6. Selected finding, in detail

`Field` renders `<label htmlFor={controlId}>` and publishes `controlId` through context.
`useFieldAria` is how a control collects it. Measured directly:

| Control inside a `Field` | `<label for>` resolves to an element? |
| --- | --- |
| `Input` | **yes** |
| `Textarea` | yes |
| `Switch` | **no** |
| `Checkbox` | **no** |

So `<Field label="Value"><Switch … /></Field>` produced a label pointing at nothing and a control
with no accessible name — `button-name`, **critical**.

The asymmetry is the defect rather than either control. Two of four honoured the contract, so the
correct-looking call site silently produced an unusable one. `/admin/settings` uses the bare
composition and shipped twelve of them; `admin-shared/fields.tsx` had independently discovered the
gap and patched around it.

## 7. Root cause

`Field` was built to wire controls it does not own, through context rather than by cloning children
— which is the right design and is documented as such. What was missing is that the contract was
never asserted across the controls. Nothing in the package said "every control that can sit in a
`Field` must take its id", so two did and two did not, and the difference was invisible until a
product rendered one on a screen nothing measured.

## 8. Ownership

| Layer | Owns | Decision |
| --- | --- | --- |
| `@munaxa/platform` | the `Field` contract and its controls | **fixed here** |
| Docs application | its own token use and section naming | **fixed here** — findings 2, 3 |
| Docs test harness | which routes are swept | **fixed here** — finding 4 |
| `@munaxa/ui` | nothing; it is a façade | untouched |

No Docs-side workaround was added for finding 1, and the existing one in `SwitchField` is now
redundant rather than load-bearing.

## 9. Implementation

- **`Switch` and `Checkbox`** call `useFieldAria`, taking the field's `controlId` and
  `aria-describedby`. Standalone use is unchanged — no `Field`, no generated id — which is asserted.
- **Docs `/admin/settings`**: `text-muted` → `text-muted-foreground` (`--muted` is a near-white
  *background* token; painting text in it is what axe measured), and unknown setting groups are now
  named by their own key rather than all collapsing into "System".
- **The sweep** now runs over all 33 statically addressable routes instead of five. The impact
  filter is deliberately **unchanged** — critical and serious, exactly as before — so this widens
  reach without quietly moving the standard.

## 10. Regression proof

The platform test is a table over all five controls, so a control added later that ignores the
context fails there rather than in a product.

| | With fix | Reverted | Restored |
| --- | --- | --- | --- |
| `Input` / `Select` / `Textarea` take the label's id | ✓ | ✓ *(unaffected)* | ✓ |
| `Switch` takes the label's id | ✓ | **✗** | ✓ |
| `Checkbox` takes the label's id | ✓ | **✗** | ✓ |
| `Switch` reachable by label text | ✓ | **✗** | ✓ |
| `Checkbox` reachable by label text | ✓ | **✗** | ✓ |
| switch-in-field has an accessible name, no violations | ✓ | **✗** | ✓ |
| the field hint reaches the control | ✓ | **✗** | ✓ |

**6 of 13 red on revert, and the three already-correct controls stay green** — which is what
distinguishes a discriminating table from one that would pass on anything.

For the sweep: it is red on the pre-fix tree (`button-name` ×12 on `/admin/settings`) and green
after, which is the coverage proof — coverage removed → the defect returns unseen; coverage restored
→ it is caught.

## 11. Coverage

| | 1.4.2 | 1.4.3 |
| --- | --- | --- |
| Contrast / keyboard | 848/848 · 848/848 | **848/848 · 848/848** |
| Overlay layers | 74, 0 violations | **74, 0 violations** |
| Accessibility tests | 52 | 52 |
| Platform unit tests | 545 | **558** |
| **Docs routes swept with the full ruleset** | **5 of 40** | **33 of 40** |

The remaining seven are parameterised (`/documents/[documentId]`, `/admin/workflows/[workflowId]`
and similar) and need a seeded id; they are covered by their own suites and recorded in §16.

### Differential

```
=== contrast ===  shared 848 · removed 0 · added 0 · field differences 0
=== keyboard ===  shared 848 · removed 0 · added 0 · field differences 0
EQUIVALENT
```

Two components changed their rendered attributes and nothing in the canonical inventory moved.

## 12. Performance

Not a target and not optimised. The platform suite is 846s against 865s at 1.4.2 — inside the noise
band Phase 8.10 measured. The Docs sweep grows from 5 to 33 route loads; it runs in the existing
`consistency.e2e` and the whole file remains well inside its budget.

## 13. Gates

| Gate | Result |
| --- | --- |
| Platform: format · lint · typecheck | clean · 32/32 · 32/32 |
| Platform: test · build · validate · check:faded · release:check | 26/26 · 20/20 · clean · clean · passed |
| Platform: `test:a11y` | **52/52** — 848/848, 848/848, 74 overlays |
| Docs: format · lint · typecheck · test · build | clean · 13/13 · 13/13 · 13/13 · 9/9 |

## 14. CI

Unchanged, deliberately. The widened sweep lives in the `e2e` project, which still has no CI job —
re-measured this phase and still the right size for its own objective rather than a side-effect of
this one.

## 15. Release

Recorded in §16 of the final state table below and proven by the same chain as previous phases:
registry `latest` = 1.4.3, tarball inspected, Docs on `^1.4.3` from a wiped `node_modules` with
`--frozen-lockfile`, clean production build, Docs suites re-run.

## 16. Deferred findings

- **`region` on every route — and it is mine.** The shell's brand block has no landmark ancestor
  because **Phase 8.12 turned the rail's `<aside>` into a `<div>`** to remove a duplicate unnamed
  `complementary` landmark. That fix was right about the duplicate and blind to what it left
  outside a landmark. Neither check could see it: the component matrix disables page-structure
  rules by design, and the Docs sweep filters to critical/serious. Moderate impact; the correct fix
  is a landmark-architecture decision across `AppShell` (banner / navigation / main / complementary)
  and is a phase of its own.
- **Seven parameterised routes** are outside the sweep and need seeded ids.
- **ContextMenu** — re-measured: Docs still uses zero instances. Still deferred, on evidence.
- **Docs E2E CI** — re-measured: still no job, still the larger objective.
- **`Combobox` ArrowDown**, **single viewport**, **`aria-errormessage` unused**, **audit/rbac timing
  flakes**, **Cloudflare Storybook check** — all carried unchanged; none was selected by this
  phase's evidence.

## 17. Corrections

Previous reports are not edited. Two corrections, both to my own earlier work:

1. **Phase 8.12's report says Munaxa Docs "runs `axe.run(document)` with no `runOnly` … and reports
   zero violations."** That is imprecise and this phase's sweep shows why: the suite filters to
   `impact === 'critical' || 'serious'`, so moderate findings were never in scope, and `region` was
   firing on every one of those routes at the time. The accurate statement is "zero **critical or
   serious** violations, on five routes".
2. **Phase 8.12 introduced the `region` finding** by removing the rail's `<aside>`, as above. It was
   a real fix to a real defect that created a smaller one, and nothing in the verification system
   was positioned to notice.

Both are the same lesson this phase is about: a check that is green tells you only about what it
looked at.

## 18. Final state

| | |
| --- | --- |
| Platform | merged to `main`, tree clean, pushed |
| Docs | tree clean, pushed |
| Published | `@munaxa/platform@1.4.3`, `latest` |
| Docs consumes | `^1.4.3` from the registry store |
| Canonical matrix | 848/848 contrast · 848/848 keyboard · 74 overlays · 0 failures |
| Docs routes swept | **33 of 40**, both themes |
| Hidden failures | none |
