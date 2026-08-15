# Phase 8.21 — The Last Tolerated Overflow

## 1. Status

**COMPLETE.** Docs only: one commit. No Platform change, no release, no published version.

The measurement went wide — 35 pages unfiltered, 132 route × dimension combinations, 56 application
overlays, the full component matrix — and almost all of it came back clean. What it found was the
one screen the suite had been told to ignore: `/delegations` overflowed its viewport by **112px at
320** and **42px at 390**, in violation of WCAG 2.1 AA 1.4.10, and had done since Phase 8 recorded
it as a tolerated exception. The exception is gone, the defect is fixed, and 320 is now enforced on
all thirty-three routes rather than three.

One gate is red and is **not** this phase's: the Arabic visual baselines cannot be verified in this
container, which has no Arabic font (§14). Proven pre-existing on a clean tree.

## 2. Objective

Find the next highest-value confirmed problem in the current repository, fix it at the owning layer,
prove it. The authentication-budget candidate carried from 8.20 was measured rather than assumed,
and deliberately **not** selected (§6).

## 3. Starting state, verified rather than assumed

| | Reported by 8.20 | Measured here |
| --- | --- | --- |
| Platform HEAD | `fc6a8e2` | `fc6a8e2`, equal to `origin/main` ✓ |
| Docs HEAD | `874a1f2` | `874a1f2`, equal to its remote ✓ |
| Published / installed | 1.5.0 | 1.5.0, from the registry tarball ✓ |
| `@munaxa/ui` façade | 3 lines → one platform copy | **re-verified**: 3 lines, `export * from '@munaxa/platform'`, **1** copy in the store ✓ |
| `file:` / `link:` / `workspace:` for `@munaxa/*` | none | **none** ✓ |
| Phase 8.18 `countsSql` | present | present ✓ |
| Phase 8.20 teardown | present | present ✓ |
| 320 enforcement (`shell`, `search`, `recent-empty`) | present | present ✓ |
| Stale fixture tenants | 0 | **0 / 0** ✓ |
| Both trees | clean | clean ✓ |

## 4. Fresh baseline — including the negatives

### 4.1 The component layer is clean

Storybook rebuilt from HEAD, then the full matrix: **106 stories**, 4 brands × 2 schemes = **848
combinations**, contrast and keyboard and overlays. **52/52 tests, 0 violations**, 607s.

### 4.2 The application layer, unfiltered — and this is the first time it was unfiltered

The route sweep has always filtered to critical and serious. This phase ran the full axe ruleset
with **no impact filter at all**, across every static route plus the two nobody had ever swept:

| | Pages | Violations, any impact |
| --- | --- | --- |
| Authenticated static routes | 33 | **0** |
| `/login`, `/mfa` — never swept before | 2 | **0** |

`/login` and `/mfa` are outside `AXE_ROUTES` because the sweep runs signed in. They are the only
screens every user must pass through, and they had never been measured as *pages* — only as
components, where page-structure rules are disabled. Measured now: clean. Recorded as a closed
question rather than a coverage gap to fill.

### 4.3 Four dimensions × every route

132 measurements — 33 routes at 320, at 390, in dark, and in Arabic:

| Dimension | axe violations | Routes overflowing |
| --- | --- | --- |
| 320px | 0 | **1 — `/delegations`, by 112px** |
| 390px | 0 | **1 — `/delegations`, by 42px** |
| Dark | 0 | 0 |
| Arabic (RTL, real `edms_locale` cookie) | 0 | 0 |

### 4.4 Application overlays — measured for the first time

Phase 8.14 opened 74 overlays **in Storybook**. This phase opened every layer the running product
offers: **56 triggers across 28 routes, 56 opened, 0 failures to open**. Every one of them reports
`aria-hidden-focus` (serious). §5 finding 2 explains why that is measured and deferred rather than
fixed, and §4.5 explains why the story-level pass could never have seen it.

### 4.5 Reliability

| | Measured |
| --- | --- |
| Fixture tenants before / after | 0 / 0 |
| `recovery.e2e` | **19/19**, 50.9s |
| Docs E2E, all nine files | **161/161** |
| Unit suites | api 649 + 1 skipped, web 176 — green |
| `auth.login` budget | 10 per 300s, keyed by ip **and** identity |
| Logins per full suite | **≈19** — recovery 7, signing 5, one each for the other seven |
| Visual | 93 pass, **14 fail** — Arabic only, pre-existing, environmental (§14) |

## 5. Candidate findings

| # | Finding | Class | Evidence | Frequency | Owner | Selected |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `/delegations` overflows at 320 and 390 | **B** | 112px / 42px, one off-screen control | every load of that route, every session | **Docs** | **yes** |
| 2 | Every open application menu reports `aria-hidden-focus` | B / C | 56 of 56 triggers, all routes | every menu | app composition + Radix | no — §5.2 |
| 3 | E2E exceeds `auth.login`'s budget | R2 | ≈19 logins vs 10 per 300s | every full run | E2E harness | no — §6 |
| 4 | Arabic visual baselines unverifiable here | R3 | 14 failures on a **clean tree**, no Arabic font installed | this container | environment | no — §14 |
| 5 | Docs E2E CI | R4 | unchanged | — | CI | no |
| 6 | Unnamed `/documents` `<aside>`, ContextMenu, ArrowDown, `aria-errormessage`, doc-kit ×12, audit/RBAC flakes, Cloudflare check | — | unchanged | — | — | no |

### 5.1 Why finding 1 was selected

- **It is a confirmed WCAG 2.1 AA failure on a shipped screen.** 1.4.10 Reflow names 320 CSS px
  exactly. At 320 the "Declare an emergency delegation" button sits **112px past the viewport**, so
  reaching it needs a second scroll direction — the precise thing the criterion forbids.
- **The suite was hiding it.** `RECORDED_FINDINGS.overflows: ['delegations']` exempted this route
  from the containment assertion. This audit's own standing rule, written into that file in Phase
  8.3: *a tolerated failure that outlives the reason for tolerating it is indistinguishable from a
  defect nobody can see.* It has outlived it by thirteen phases.
- **Reproducibility**: deterministic, same two elements every time, measured to the pixel.
- **Ownership is unambiguous** and the change is three words of layout in one file.
- **The fix pays for more than itself**: removing the exception lets 320 be enforced across all
  thirty-three routes, where Phase 8.17 could only enforce it on three.
- It was selected **against** two larger-looking candidates, on evidence rather than size.

### 5.2 Why finding 2 was not selected — and what was measured before deciding

`aria-hidden-focus` on 56 of 56 open menus looks bigger than one screen. It was investigated before
being ranked, because the brief's own discipline says not to treat an enhancement as a defect
without evidence.

With a menu open, Radix marks the rest of the page `aria-hidden="true"`. The measurement:

| Question | Measured |
| --- | --- |
| Is the outside content hidden from assistive technology? | **yes** — `aria-hidden="true"` |
| Does it still contain focusable elements? | **yes** — 25 of them |
| Is it `inert`? | **no** — 0 elements |
| Can pointer input reach it? | **no** — `pointer-events: none` |
| **Can focus reach it?** | **no** — 14 consecutive Tab presses stayed inside the menu, every time |

So the harm the rule exists to prevent — focus landing on something a screen reader cannot see — does
not occur through the keyboard, and the content is genuinely hidden from AT. What axe reports is the
static shape (`aria-hidden` + focusable descendants); it cannot see a focus scope. The honest
description is "a real report of a state whose harm is contained", and the two available remedies
each change behaviour: dropping modality removes the focus trap, and applying `inert` means
overriding attributes a third-party library owns at runtime. That is a phase's work with a real
regression risk, not a rider on this one.

It is recorded with its full evidence and deferred. **What is not deferred is the lesson**: Phase
8.14's overlay pass runs in Storybook, where a component has no page chrome, so a violation caused by
*the rest of the page* is structurally invisible to it — the same shape as Phase 8.16's finding that
the component matrix disables page-structure rules. §17 records the correction to what "74 overlays,
0 violations" may be taken to mean.

## 6. The authentication candidate, measured and deferred

Phase 8.20 raised it; the brief required measuring it before adopting the hypothesis of "one sign-in
per person shared across specs". Measured:

| Question | Answer |
| --- | --- |
| Logins per full run | **≈19** (recovery 7, signing 5, seven files 1 each) |
| Duplicate logins *within* a spec | **0** — `signInAndCapture` already captures once and every test reuses the storage state |
| Own browser context per spec | yes, own cookies/storage |
| Do specs share a fixture? | **no — each file seeds its own tenant and its own users** |
| Is the rate limit the cause? | **yes** — the ip counter reaches 15 against a limit of 10 |
| Minimum legitimate logins | **≥9**, one per file at least; recovery legitimately re-authenticates after the restore, because that *is* its assertion |

The hypothesis does not survive that fourth row. Sessions cannot be shared across spec files because
there is nothing to share: each file's tenant, users and servers are its own, deliberately, and two
files run against different API environments. Even a perfectly deduplicated suite needs ~9–12 logins
and would still exceed 10-per-300s whenever the suite finishes inside five minutes.

So the real choice is between changing the *isolation architecture* (one fixture and one server for
all nine files) and accepting a scheduling constraint. That is an architectural decision with real
cost to test independence, and the brief is explicit that a harness should adapt to the application's
security boundaries rather than weaken them. Deferred with the evidence, not with a guess. **No
production limiter, timeout, counter or authentication path was touched.**

## 7. Root cause

```
<div class="flex flex-wrap items-center gap-3">     ← the row wraps
  <Select …>                                        ← fine
  <div class="ms-auto flex gap-2">                   ← the group does NOT wrap
    <Button>Request a delegation</Button>            ← whitespace-nowrap
    <Button variant="outline">Declare an emergency delegation</Button>   ← 243px on its own
```

The row around the action group wraps. The group itself does not, and platform `Button` is
`whitespace-nowrap` — correctly, since a control that breaks mid-label is worse. So the group's
min-content width is the **sum** of both labels, 416px, and a flex item never shrinks below its
min-content. At 320 the page is 112px too wide; at 390, 42px.

`/notifications` has the identical container and does not overflow, because its labels are shorter.
That is why this screen and no other reached the edge — and why the container, not the button, is the
defect.

## 8. Ownership

**Docs, the application layer.** The overflowing element is a `div` written in
`delegations-screen.tsx`; the platform's contribution (`whitespace-nowrap`, `WorkspacePage`'s frame)
is correct and unchanged. No platform release was required, and none was published.

## 9. Implementation

One class list, in one file: `ms-auto flex gap-2` → `ms-auto flex flex-wrap justify-end gap-2`.
Wrapping makes the group's min-content the *widest single button* (243px) instead of the pair, which
fits inside 320 minus the page frame; `justify-end` keeps the wrapped rows aligned where `ms-auto`
had put the group.

And the guard, in `consistency.e2e.spec.ts`:

- `RECORDED_FINDINGS.overflows` is now `[]` — the exception is deleted, not widened;
- every route is measured at **320** as well as 1280 and 390, by a resize rather than a page load, so
  the sweep costs no extra navigation and spends nothing more of the login budget.

## 10. Regression proof

The fix was reverted with `git stash` and the application **rebuilt** each time, so the measurement
is of shipped output rather than of source (Phase 8.14's vacuous revert-proof is not repeated):

| | `/delegations` 320 | `/delegations` 390 | `/notifications` | `/approvals` |
| --- | --- | --- | --- | --- |
| Fix present | **0px**, 0 off-screen controls | **0px** | 0px | 0px |
| **Reverted** | **112px, 1 off-screen control** | **42px** | 0px *(control)* | 0px *(control)* |
| Restored | **0px** | **0px** | 0px | 0px |

The two control routes stay at zero in every direction on purpose: a table where everything moves
cannot tell a fix from a broken instrument.

And the standing guard reports the truth in both directions: with the exception deleted, the
consistency suite measures `delegations` at `overflow1280: false, overflow390: false, overflow320:
false` — the same suite that would have failed on the reverted build, since the assertion is now
unconditional.

## 11. Coverage

| | Before | After |
| --- | --- | --- |
| Routes with 320 enforced | 3 reference screens | **33 + 3** |
| Overflow widths asserted by the sweep | 1280, 390 | **1280, 390, 320** |
| Tolerated overflow exceptions | 1 | **0** |
| Routes ever swept by axe as pages | 33 | **35** (`/login`, `/mfa` measured) |
| Application overlays ever opened and checked | 0 | **56** (measured, deferred) |
| Component matrix | 848 · 848 · 74 | unchanged |

## 12. Performance

Not a target and not affected. The added 320 measurement is one `setViewportSize` per route inside an
existing loop; the consistency suite ran 64.3s against 63.6–63.8s in the previous phase's runs — inside
the noise band. No page loads and no logins were added.

## 13. Reliability

| | |
| --- | --- |
| `recovery.e2e` | **19/19** |
| Fixture tenants after the full run | **0 / 0** |
| Docs E2E | **161/161** across all nine files |
| Retries used | none |
| Timeouts | none |

## 14. CI

Unchanged; Docs E2E still has no CI job, still deferred.

**Docs E2E discipline.** Every file passed on its first attempt this phase. The suite was run in
three batches with the login budget allowed to drain between them, for the reason measured in §6 —
not to make anything pass: no individual failure was skipped, retried or reclassified.

| Batch | Files | Result |
| --- | --- | --- |
| 1 — consistency, shell, search, recent-empty | 4 | **89/89** |
| 2 — recovery, dashboard, datagrid-keyboard | 3 | **41/41** |
| 3 — signing, faded-text | 2 | **31/31** |

**The one red gate, disclosed rather than hidden.** `pnpm test:visual` fails 14 of 107 checks. All
fourteen are Arabic screens (`ar-document-list-*`, `ar-dashboard*`). Classification: **environment**,
on evidence.

- The identical 14 failures reproduce on a **clean tree at HEAD** with both of this phase's files
  stashed, so they are not caused by this change.
- The diff images show glyph-level differences on Arabic text only. Latin text, numbers, boxes and
  positions are pixel-identical — so it is not a layout or CSS change.
- `fc-list` finds **zero** Arabic fonts in this container; `Noto Sans Arabic` resolves to DejaVu Sans.
  The baselines were recorded (`ade62c5`, for platform 1.3.0) in an environment that had one.

The baselines were **not** re-recorded. Doing so would bake this container's font fallback into the
repository and destroy the gate's ability to detect a real Arabic rendering change — the opposite of
what a baseline is for. Recorded as a candidate (§5, finding 4) whose fix is environmental: install
the font the product asks for, then re-verify.

## 15. Release

**None.** Docs application and test infrastructure only. Platform is untouched at `fc6a8e2` and
`@munaxa/platform@1.5.0` remains what Docs consumes, from the registry.

## 16. Deferred findings

- **`aria-hidden-focus` on every open application menu** — §5.2, with the focus-containment evidence.
- **The E2E login budget** — §6; the "share one session" hypothesis is refuted as stated.
- **Arabic visual baselines** — §14; environmental, fix is a font, not a re-record.
- **Docs E2E CI**, **unnamed `/documents` `<aside>`**, **ContextMenu**, **`Combobox` ArrowDown**,
  **single viewport**, **`aria-errormessage`**, **audit/RBAC timing flakes**, **Cloudflare Storybook
  check**, **doc-kit `scrollable-region-focusable` ×12** — all carried unchanged; none selected by
  this phase's evidence.

## 17. Corrections

Previous reports are not edited. Three corrections, all to this audit's own work.

**Phase 8 §6.2 named the wrong element.** The finding was recorded as *"the delegations table
overflows the viewport at 390px"*, and that wording survived into the suite's exception comment. The
table never overflowed — it scrolls inside its own container, like every table in the product. The
page's **action group** overflowed, and at 320 as well as at 390. A finding that names the wrong
element is a finding nobody can fix.

**Phase 8.17's headline was broader than its measurement.** It reported *"twelve routes, two narrow
widths, both themes — zero horizontal overflow"* and concluded that *"Munaxa Docs turned out to
already satisfy [1.4.10]"*. The product did not satisfy 1.4.10: `/delegations` failed it at 320 by
112px, while the consistency suite's own `RECORDED_FINDINGS.overflows` recorded the 390px half of the
same defect. The correct statement is that the routes 8.17 enforced 320 on were clean at 320 — which
is a smaller claim, and the one its evidence supported. The instrument was right; the generalisation
was not.

**Phase 8.14's "74 overlays, 0 violations" is a statement about Storybook.** It is true and it was
measured. It does not mean the product's overlays are clean, and this phase's application-level pass
shows why it cannot: a story has no page chrome, so a violation caused by the rest of the page has
nothing to be caused by. 56 of 56 application overlays report a serious violation that the story-level
pass is structurally unable to see.

## 18. Final state

| | |
| --- | --- |
| Platform | unchanged, tree clean, `fc6a8e2` |
| Docs | one commit, tree clean, pushed |
| Published | nothing — no release warranted |
| Tolerated overflow exceptions | **0** |
| `/delegations` at 320 / 390 | **0px / 0px** |
| Routes with 320 enforced | **36** |
| Docs E2E | **161/161** |
| `recovery.e2e` | **19/19** |
| Fixture tenants | **0 / 0** |
| Red gates | one — the Arabic visual baselines, proven pre-existing and environmental (§14) |
| Hidden failures | none |
