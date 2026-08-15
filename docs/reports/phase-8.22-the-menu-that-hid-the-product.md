# Phase 8.22 — The Menu That Hid The Product

## 1. Status

**COMPLETE.** Platform released as **1.5.1** and consumed by Docs from the registry.

Every menu in Munaxa Docs was removing the entire application from the accessibility tree while it
was open — 56 of 56, on every route, hiding between 15 and 117 focusable elements each. Phase 8.21
surfaced the symptom and deliberately deferred it pending an ownership and semantics investigation.
That investigation is §6 and §7 here: the finding is real, the owner is the platform, and the fix is
a default.

Two gates are red and neither is this phase's: the Arabic visual baselines (unchanged from 8.21,
environmental) and the Cloudflare Storybook check (pre-existing since PR #8). Both are proven in §14
and §15.

## 2. Objective

Find the next highest-value confirmed problem, fix it at the owning layer, prove it. The menu
finding was not preselected — it was ranked against a fresh measurement of the overlay surface that
had never been taken (§4.3), and won on evidence.

## 3. Starting state, verified rather than assumed

| | Reported by 8.21 | Measured here |
| --- | --- | --- |
| Platform HEAD | `fc6a8e2` | `fc6a8e2` = `origin/main` ✓ |
| Docs HEAD | `f0a0d06` | `f0a0d06`, equal to its remote ✓ |
| Published / installed | 1.5.0 | 1.5.0 from the registry tarball ✓ |
| `@munaxa/ui` façade | 3 lines → one platform copy | **re-verified**: 3 lines, **1** copy ✓ |
| `file:` / `link:` / `workspace:` for `@munaxa/*` | none | **0** ✓ |
| `countsSql` (8.18) | present | present ✓ |
| Fixture teardown (8.20) | present | present ✓ |
| 320 enforcement (8.21) | present | `overflow320` on all 33 routes ✓ |
| Delegations exception | deleted | `overflows: []` ✓ |
| Stale fixture tenants | 0 | **0 / 0** ✓ |
| Both trees | clean | clean ✓ |

## 4. Fresh baseline

### 4.1 The component layer is clean

Storybook rebuilt from HEAD; full matrix re-run: **106 stories × 4 brands × 2 schemes**, contrast,
keyboard and overlays — **52/52, 0 violations**, 614s.

### 4.2 Dialogues — the dominant overlay, never measured in the running product

Munaxa Docs uses `FormDialog` **127 times** and `Dialog` 23 times against 6 `DropdownMenu`s. Dialogues
are what this product is made of, and no suite had ever opened one in the browser. Nineteen were
opened across eighteen routes and measured against a full contract:

| Contract | Result |
| --- | --- |
| Opens | 19 / 19 |
| Has an accessible name | **19 / 19** |
| Focus enters the layer | 19 / 19 |
| Focus contained (20 Tab presses) | 19 / 19 |
| Escape closes | 19 / 19 |
| Focus restored to the trigger | 19 / 19 |
| `aria-modal="true"` | **19 / 19** |
| Page hidden behind it | **0 / 19** |
| axe violations | 2 nodes — `heading-order` (moderate) on two dialogues |

A negative result worth stating plainly: the dialogue layer is in good order, and it is the
comparison that decides §6.

### 4.3 Menus — 56 of 56, and what they hide

| Measured with a menu open | Before |
| --- | --- |
| Triggers found / opened | 56 / 56 across 28 routes |
| Menus hiding the page | **56** |
| `aria-hidden-focus` nodes (serious) | **321** |
| Focusable elements hidden, per open | 15 – 117 (2 451 in total) |
| `page-has-heading-one` | 56 |
| `landmark-one-main` | 12 |
| Escape closes / focus restored | 56 / 56 |

The last row matters as much as the first: the menus' *behaviour* was already correct. Only what
they told assistive technology was wrong.

## 5. Candidate findings

| # | Finding | Class | Evidence | Frequency | Owner | Selected |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Open menus hide the application from AT | **A** | 56/56, 321 serious nodes, reproduced in a minimal platform composition | every menu, every route | **platform** | **yes** |
| 2 | `heading-order` inside two dialogues | B | 2 nodes, moderate | 2 of 19 dialogues | Docs | no — §16 |
| 3 | `region` on the menu portal wrapper | B/D | 56 moderate, unchanged by the fix | every menu | platform | no — §16 |
| 4 | E2E login budget | R2 | ≈19 logins vs 10/300s | every full run | harness | no — refuted shape, 8.21 §6 |
| 5 | Arabic visual baselines | R3 | 14/107, no Arabic font in container | this container | environment | no — §14 |
| 6 | Wall-clock budgets on CI runners | R4 | **3 failures across 3 packages today**, 13–15× slower than local | today | CI infra | no — §15 |
| 7 | Docs E2E CI, `/documents` `<aside>`, ContextMenu, ArrowDown, viewport, `aria-errormessage`, doc-kit ×12, Cloudflare | — | unchanged | — | — | no |

### Why finding 1 was selected

- **Severity is real, not nominal.** This is not "axe is strict": with a menu open, axe also reported
  `page-has-heading-one` and `landmark-one-main`, because the heading and the `main` landmark were
  genuinely gone. A screen-reader user opening the account menu was handed a document containing
  nothing but menu items.
- **Reach**: every menu, every route, both menu components, since the components were written.
- **Ownership provable** rather than assumed — §7.
- **Scope**: one default, in two files, with the prop left intact.
- **It cost the product nothing to fix**: no behaviour the menus had was lost except the two things
  modality added, both of which a menu should not have.

## 6. Root cause, and why it is a defect rather than a strict rule

`DropdownMenu` and `ContextMenu` were bare re-exports:

```ts
export const DropdownMenu = DropdownMenuPrimitive.Root;   // Radix defaults modal={true}
```

A modal Radix menu marks every other element `aria-hidden="true"`, locks body scroll and traps focus.
Phase 8.21 established that focus never escapes and concluded the harm was contained. This phase
went further, because containment is only half the question. The other half is what the popup
*claims*:

| | `aria-modal` | Page hidden from AT | Coherent? |
| --- | --- | --- | --- |
| `Dialog` (19 measured) | **`true`** | no | yes — declares modality, hides nothing |
| `Popover` (minimal composition) | absent | no | yes — declares nothing, hides nothing |
| `DropdownMenu` / `ContextMenu` | **absent** | **yes** | **no** |

The menus took a dialogue's privilege without a dialogue's declaration. `aria-hidden-focus` is the
rule that catches exactly that mismatch, and its 321 nodes were the visible edge of it — the deeper
evidence is that the page's heading and `main` landmark disappeared too.

The ARIA authoring practices' menu-button pattern agrees: a menu is a popup over a page that is
still there, Escape closes it and returns focus, and Tab moves on rather than being trapped.

## 7. Ownership — proven, not assumed

The brief requires that a platform fix reproduce in a minimal platform composition. It does:

```tsx
<div>
  <a href="/elsewhere">A link outside</a>
  <button type="button">A button outside</button>
  <DropdownMenu>…</DropdownMenu>
</div>
```

| Component | role | `aria-modal` | hidden subtrees with focusables |
| --- | --- | --- | --- |
| `DropdownMenu` | menu | none | **1, holding 3 focusables** |
| `ContextMenu` | menu | none | **1, holding 2 focusables** |
| `Popover` | dialog | none | 0 |

Munaxa Docs composes nothing unusual — it merely has a page. **Owner: `@munaxa/platform`.** Fixing
`DropdownMenu` alone would have left the identical defect shipping in `ContextMenu`, so both changed.

## 8. Implementation

`ui/components/overlays/dropdown-menu.tsx` and `context-menu.tsx`: the bare re-export becomes a
wrapper whose only job is the default.

```tsx
export function DropdownMenu({ modal = false, ...props }: ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Root>) {
  return <DropdownMenuPrimitive.Root modal={modal} {...props} />;
}
```

The `modal` prop is unchanged and still honoured, so a consumer that genuinely wants the old
behaviour asks for it — and a test asserts that path still works, because a "fix" that quietly
removed the capability would be a different change from the one described.

## 9. Regression proof

**Component level** — `ui/components/overlays/menu-modality.test.tsx`, 6 tests, run against both
defaults with nothing else altered:

| | Fix | Reverted |
| --- | --- | --- |
| the menu opens, with its two items *(guard)* | ✓ | ✓ |
| leaves the page in the accessibility tree — dropdown | ✓ | **✗ `expected 3 to be +0`** |
| leaves the page in the accessibility tree — context menu | ✓ | **✗** |
| the context menu opens on the secondary button *(guard)* | ✓ | ✓ |
| Escape closes and returns focus to the trigger | ✓ | ✓ |
| `modal` can still be asked for explicitly | ✓ | ✓ |

Two of six flip. The four that do not are the point: they prove the menus still work, that the
suite is not asserting against a menu that stopped opening, and that the capability was defaulted
rather than deleted.

**Application level** — the same 56 menus, before on 1.5.0 and after on 1.5.1 from the registry:

| | Before | After |
| --- | --- | --- |
| Triggers opened | 56 / 56 | 56 / 56 |
| Menus hiding the page | **56** | **0** |
| `aria-hidden-focus` nodes (serious) | **321** | **0** |
| `page-has-heading-one` | 56 | **0** |
| `landmark-one-main` | 12 | **0** |
| `region` (moderate, portal wrapper) | 56 | 56 |
| Escape closes | 56 | **56** |
| Focus restored to trigger | 56 | **56** |

Serious violations across the product's menus: **321 → 0**, with behaviour identical on both
measurements. The unchanged `region` count is recorded rather than glossed: it is a different
finding (§16), and a fix that had accidentally addressed it would have needed explaining.

## 10. Coverage

| | Before | After |
| --- | --- | --- |
| Application dialogues ever opened and checked | 0 | **19** |
| Application menus measured against a contract | 56 (axe only) | **56, full contract** |
| Overlay families with measured modality semantics | 0 | **4** — dialog, popover, dropdown, context |
| Platform tests | 569 | **575** |
| Component matrix | 848 · 848 · 74 | unchanged |
| Docs E2E | 161 | 161 |

## 11. Performance

Not a target. `modal={false}` removes a focus scope and a scroll lock per open menu, so if anything
it does less work; nothing measurable at this scale. Docs E2E batch timings are within a second of
Phase 8.21's (consistency 64.0s vs 64.3s, signing 46.7s vs 47.1s).

## 12. Reliability

| | |
| --- | --- |
| `recovery.e2e` | **19/19**, 76.7s |
| Fixture tenants after the full run | **0 / 0** |
| Docs E2E | **161/161** across all nine files, every file green on its first attempt |
| Retries used in Docs | none |

## 13. CI

Docs E2E still has no CI job — unchanged, still deferred.

**Platform CI, recorded in full.** Three attempts on the same commit, no code changed between them:

| Attempt | Lint · Typecheck · Test · Build | Accessibility | Façades |
| --- | --- | --- | --- |
| 1 | **failure** — `@munaxa/security`: `0.11212` vs a `0.1` ms budget | success | success |
| 2 | **failure** — `@munaxa/rbac`: `8120` vs a `7500` ms budget | success | success |
| 3 | **success** | success | success |

And the release workflow, whose `Verify` step runs the same suite before publishing:

| Attempt | Verify | Publish |
| --- | --- | --- |
| 1 | **failure** — `@munaxa/security`: `0.11169` vs `0.1` | **skipped** |
| 2 | success | **success** |

Diagnosed rather than retried blindly. Both failing assertions are CPU-bound loops in packages this
change cannot reach — `@munaxa/security` depends only on `types`, `interfaces`, `crypto` and `cache`;
neither package imports React or any UI module, and the diff touches two overlay components. On this
machine the same two assertions measure:

| Assertion | Budget | Local | Headroom | CI today |
| --- | --- | --- | --- | --- |
| `renders the header set in microseconds` | 0.1 ms | **0.0076 ms** | 92.4% | 0.112 |
| `checks against a large grant set in microseconds` | 7 500 ms | **625 ms** | 91.7% | 8 120 |

So the budgets are not marginal — they hold with an order of magnitude to spare — and the runners
were **13–15× slower** than this container for both, in the same ratio. That is an infrastructure
condition, not a defect, and it is why the re-runs are disclosed here as evidence rather than used
as a way of not mentioning the first result. **No wall-clock budget was changed**, in keeping with
the standing constraint. The gate behaved correctly throughout: the release refused to publish while
the suite was red.

Also red and not this phase's: **Cloudflare `Workers Builds: platform-storybook`**, which has failed
identically since PR #8 (recorded in Phase 8.8 §17) and lives in a dashboard this session cannot
reach.

## 14. Visual verification

`pnpm test:visual`: **93 pass, 14 fail** — the identical 14 Arabic screens Phase 8.21 proved
environmental (no Arabic font in this container; glyph-only diffs with pixel-identical layout).
Baselines were **not** re-recorded.

The count is itself a differential result worth stating: had `modal={false}` altered rendering, the
93 non-Arabic baselines would have moved. They did not — 14 before the change, 14 after, the same
14.

## 15. Release

**`@munaxa/platform@1.5.1`** — PATCH, being an accessibility correction with no API change, per
`VERSIONING.md`. `CHANGELOG.md` documents the behaviour change and how to opt back in, because a
patch that changes what a component does must say so even when the types do not move.

Verified from outside the workflow: registry `latest` = **1.5.1**; the published tarball inspected
and carrying `export function DropdownMenu({ modal = false, … })` and the same for `ContextMenu`;
Docs on `^1.5.1` after wiping `node_modules` and installing with `--frozen-lockfile`; the lockfile
resolving to `https://npm.pkg.github.com/download/@munaxa/platform/1.5.1/…`; **one** copy in the
store; the `@munaxa/ui` façade still three lines. No `file:`, `link:`, `workspace:` or local tarball
anywhere in the chain.

## 16. Deferred findings

- **`region` on the menu portal wrapper** — 56 moderate nodes, unchanged by this fix. Radix's
  `div[data-radix-popper-content-wrapper]` sits outside every landmark, so axe counts its contents as
  content outside a landmark. Measured, unchanged in both directions, and a separate question from
  modality.
- **`heading-order` inside two dialogues** (`/admin/roles`, `/admin/workflows`) — 2 moderate nodes;
  Docs-owned, and the smallest finding this phase surfaced.
- **The E2E login budget** — unchanged; the shared-session shape stays refuted (8.21 §6).
- **Arabic visual environment** — §14; the fix is a font in the environment, not a re-record.
- **Wall-clock budgets versus CI runner speed** — new this phase as a *quantified* candidate (§13).
- **Docs E2E CI**, **unnamed `/documents` `<aside>`**, **ContextMenu product usage**, **`Combobox`
  ArrowDown**, **single viewport**, **`aria-errormessage`**, **doc-kit ×12**, **Cloudflare check** —
  carried unchanged.

## 17. Corrections

Previous reports are not edited. One correction, to this audit's own reasoning.

**Phase 8.21 under-read its own evidence on the menus.** It measured that focus stays contained and
that the outside tree is `aria-hidden` with `pointer-events: none`, and concluded "a real report of a
state whose harm is contained", deferring on the grounds that the remedies were behaviour-changing.
Two things were missed. First, the same axe runs were *also* reporting `page-has-heading-one` and
`landmark-one-main` on those screens — direct evidence that the page had genuinely left the
accessibility tree, which is harm, not a technicality. Second, the library already contained the
answer: `Dialog` declares `aria-modal` and hides nothing, so the inconsistency was internal and
decidable without weighing philosophies. The deferral was reasonable on what 8.21 had looked at; it
was not the whole of what 8.21 had measured.

Phase 8.21's count of "25 focusable elements" in the hidden subtree was one sample, not the range.
Measured across all 56: **15 to 117**, 2 451 in total.

## 18. Final state

| | |
| --- | --- |
| Platform | merged to `main` as `61810a6`, tree clean, pushed |
| Docs | one commit, tree clean, pushed |
| Published | **`@munaxa/platform@1.5.1`**, `latest`, verified from the registry |
| Docs consumes | `^1.5.1` from the registry store, one copy |
| Menus hiding the application | **0 of 56** |
| Serious violations on open menus | **321 → 0** |
| Escape / focus restoration | 56 / 56, unchanged |
| Docs E2E | **161/161** |
| `recovery.e2e` | **19/19** |
| Fixture tenants | **0 / 0** |
| Red gates | two, both proven not this phase's — Arabic visual baselines (§14), Cloudflare Storybook (§13) |
| Hidden failures | none |
