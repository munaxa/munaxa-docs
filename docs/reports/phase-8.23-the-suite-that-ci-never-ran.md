# Phase 8.23 — The Suite That CI Never Ran

## 1. Status

**COMPLETE.** Docs only: two commits. No Platform change, no release, no published version.

The measurement went looking for a product defect and did not find one: 33 static routes, two
parameterised routes and a reader session came back **clean at every impact**, 132 route × dimension
measurements came back **clean**, and a landmark map of 271 elements across 34 routes found exactly
two unnamed structural elements on one route. What it found instead was that the nine end-to-end
files — the only thing in either repository that exercises the product *as a product* — had never
run in CI. They do now, and the first run they ever had found a race in the suite itself.

## 2. Objective

Find the next highest-value confirmed problem, fix it at the owning layer, prove it. No candidate
was preselected; §5 ranks nine of them against fresh evidence.

## 3. Starting state, verified rather than assumed

| | Reported by 8.22 | Measured here |
| --- | --- | --- |
| Platform HEAD | `61810a6` | `61810a6` = `origin/main` ✓ |
| Docs HEAD | `a54709d` | `a54709d`, equal to its remote ✓ |
| Published / installed | 1.5.1 | 1.5.1, from the registry tarball ✓ |
| `@munaxa/ui` façade | 3 lines → one platform copy | **re-verified**: 3 lines, **1** copy ✓ |
| `file:` / `link:` / `workspace:` for `@munaxa/*` | none | **0** ✓ |
| `countsSql` (8.18) · teardown (8.20) · 320 enforcement (8.21) | present | all present ✓ |
| Delegations exception | deleted | `overflows: []` ✓ |
| Menu `modal` default (8.22) | `false` | `modal = false` in the installed tarball ✓ |
| Stale fixture tenants | 0 | **0 / 0** ✓ |
| Both trees | clean | clean ✓ |

## 4. Fresh baseline

### 4.1 The component layer

Full matrix re-run against 1.5.1: **106 stories × 4 brands × 2 schemes**, contrast, keyboard and
overlays — **52/52, 0 violations**, 667s.

### 4.2 The application, unfiltered, including scopes rarely measured

| Scope | Pages | Violations, any impact |
| --- | --- | --- |
| Signer, static routes | 33 | **0** |
| Signer, parameterised routes (`/documents/:id`, `…/permissions`) | 2 | **0** |
| **Reader session** — a genuinely different permission set | 6 | **0** |

### 4.3 Four dimensions × every route

132 measurements — 33 routes at 320, at 390, in dark, and in Arabic: **0 overflow, 0 violations**.
The Phase 8.21 delegations fix holds at both narrow widths, and 1.5.1 introduced no regression.

### 4.4 The landmark tree, mapped rather than sampled

271 landmark-capable elements across 34 routes:

| | Count |
| --- | --- |
| Named `nav` | 95 |
| `main` | 34 |
| Named `div[role=region]` / `section[role=region]` | 69 |
| `header` (nested, not banner landmarks) | 68 |
| **Anonymous `nav`** | **0** |
| **Anonymous `aside`** | **1** — `/documents` |
| **Nameless `section` / `region`** | **1** — `/documents` |

The architecture is otherwise complete and named. Both exceptions are Docs-owned layout in the same
flex row on one route.

### 4.5 Overlays, rechecked

The families the product actually renders: menus (56, measured clean since 8.22), dialogues (19,
contract-clean), native `select` elements, and two date inputs on `/audit`. **No** application route
renders a combobox, listbox, tooltip or command surface — those exist in the platform and are
covered by the component matrix, and the application does not reach them. Recorded as a measured
negative rather than an untested surface.

### 4.6 Reliability and verification

| | Measured |
| --- | --- |
| Docs E2E, all nine files | **161/161** |
| `recovery.e2e` | **19/19** |
| Fixture tenants after | **0 / 0** |
| Unit: api / web / contracts | 649 (+1 skipped) / 176 / 26 |
| lint · typecheck · build · `verify:styles` | green |
| Visual | 93 pass, 14 Arabic fail (environmental, §15) |
| **CI jobs running the E2E suite** | **0 of 9 files** |

## 5. Candidate findings

| # | Finding | Class | Evidence | Frequency | Owner | Selected |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | The E2E suite runs in no CI job | **E / R4** | 9 files, 161 tests, incl. the DR rehearsal — zero CI coverage | every commit, forever | Docs CI | **yes** |
| 2 | Unnamed `<aside>` + nameless `<section>` on `/documents` | B | 2 of 271 landmarks, 1 route | 1 route | Docs | no — §16 |
| 3 | `region` on the menu portal wrapper | B/D | 1 node per open menu; the wrapper is Radix's, has no role, and sits at `body` | every menu | Radix/platform | no — §16 |
| 4 | `heading-order` in two dialogues | B | 2 moderate nodes | 2 of 19 | Docs | no — §16 |
| 5 | CI wall-clock headroom | R4 | 8.22's three attempts; local headroom ≈92% | occasional | CI infra | no — §16 |
| 6 | Arabic visual baselines | R3 | 14/107, no Arabic font in container | this container | environment | no — §15 |
| 7 | E2E login budget | R2 | ≈19 logins vs 10/300s | every full run | harness | **absorbed by finding 1** |
| 8 | doc-kit ×12, ContextMenu, ArrowDown, viewport, `aria-errormessage` | — | unchanged | — | — | no |

### Why finding 1 was selected

- **It is the largest hole in the verification architecture, and the only one that compounds.**
  Every defect this audit has fixed — the fixture teardown that never deleted, the 320px reflow
  failure, the menus that hid the product — is guarded by exactly one thing: the E2E suite. Nothing
  ran it except a person deciding to. CI ran unit tests, integration tests, visual tests and three
  container image builds, and not one of the nine files that starts the real API, serves the real
  build and drives a real browser.
- **Reach**: every future commit to the repository, indefinitely.
- **The alternative candidates are two-node findings on one route.** Finding 2 is real and cheap,
  but it protects nothing; finding 1 protects everything already fixed.
- **It was measurable before it was implemented**, which is what made it a candidate rather than a
  wish: the runtime, the services, the fixture lifecycle and the login cost of every file were all
  measured first (§7), and the design follows from those numbers.
- **It absorbed candidate 7 honestly.** The login budget is not a separate problem to solve later;
  it is a constraint the CI contract has to satisfy, and satisfying it is what the shard split does.

## 6. Root cause

There was never a job. `ci.yml` had `node` (lint, typecheck, unit, build, visual), `integration`
(real PostgreSQL, two tenants), `images` and `boundaries`. The E2E suite needs four things none of
those provide at once — a built API artefact, a production web build, a browser, and *two*
PostgreSQL clusters — and it needs to fit inside a rate limit the product enforces on itself.

That last constraint is why the job did not exist by accident. `auth.login` allows **ten attempts
per five minutes per IP**. The nine files need about **nineteen** sign-ins, because each file seeds
its own tenant and its own users — there is no session any two of them could share, which Phase 8.21
established and this phase did not revisit. The whole suite finishes inside one five-minute window,
so a single job spends the budget on itself and fails on `429`s that present as "the page never
navigated".

## 7. Ownership

**Docs CI.** Nothing in the platform participates, and the product's rate limiter is correct — the
harness has to fit inside it. No limiter, timeout, counter or authentication path was touched.

## 8. Implementation

A matrix `e2e` job in `.github/workflows/ci.yml`, sharded **by login cost** rather than by file
count, because login cost is the binding constraint:

| Shard | Files | Logins | Budget |
| --- | --- | --- | --- |
| signing, faded text and search | 3 | **7** | 10 |
| recovery and the data grid | 2 | **8** | 10 |
| the screens | 4 | **4** | 10 |

Each shard is a separate job with its own Redis and its own API instance, so each gets its own
budget. Also in the job, and each for a measured reason:

- **A second PostgreSQL service** on 5433, standing in for the empty destination cluster the restore
  rehearsal restores *beside* the source into — plus a step that asserts it is reachable and empty
  before the suite spends four minutes discovering otherwise.
- **The same database creation and migration steps the integration job uses**, unmodified, so the
  job proves the documented procedure rather than a CI-only shortcut.
- **`pnpm build`**, because the suite runs the artefacts the image ships rather than compiling its
  own.
- **Chromium only** — one browser, installed per shard.
- **Server logs uploaded on failure**, because a route error boundary shows a correlation id and the
  exception behind it lives in the API log alone.

And one fix to the suite itself, which the job's first run earned — §9.

## 9. Regression proof

**The CI job, on the environment that exhibits the difference.** Two runs of the same workflow on
consecutive commits, differing only in the suite fix:

| | `e0f34e3` — job added | `d835a27` — hydration wait added |
| --- | --- | --- |
| signing, faded text and search | **success** | success |
| recovery and the data grid | **success** | success |
| the screens | **failure** — `no way to reach navigation on search at 640px: expected 0 to be greater than 0` | **success** |
| Whole workflow | failure | **success** |

Two of three shards passed the first time they had ever run, including the one that takes a backup,
restores it into a second cluster and verifies the audit chain across the restore.

**The failure, diagnosed rather than retried.** The measured values name the mechanism exactly:

| Width | CI, before | This container |
| --- | --- | --- |
| 1440 / 1280 / 1024 / 768 | 10 ways | 10 ways |
| **640** | **0 ways** | **1 way** |

Below `md` the way into the navigation is the drawer trigger, and `TopBar` renders it only when
`isMobile` is true — `matchMedia`, read in an effect. Before the client hydrates there is no trigger
at any width, and `networkidle` and `readyState === 'complete'` are both satisfied long before
hydration. The product offers a way; the measurement was taken before the product could say so.

The suite now waits for two facts, and deliberately for neither of the facts it asserts: that the
client has hydrated — `ThemeToggle`'s label resolving, a signal `theme.ts` already documented and
now exports — and that the viewport has reached the requested width and been painted. Waiting for
"a way exists" would have made the assertion unable to fail.

**What could not be proven, stated plainly.** CPU throttling to 20× and 60× on this container did
**not** reproduce the race — five runs at each rate measured `ways: 1` every time, with and without
the wait. So the local reproduction is absent and the discriminating evidence is the pair of CI runs
above. That is weaker than a local before/after and is recorded as such rather than dressed up.

## 10. Coverage

| | Before | After |
| --- | --- | --- |
| E2E files run by CI | **0 of 9** | **9 of 9** |
| E2E tests run by CI | 0 | **161** |
| DR restore rehearsal in CI | no | **yes** |
| CI jobs | 4 | **7** (three shards) |
| Application scopes swept unfiltered | signer | signer + **parameterised** + **reader** |
| Landmark tree mapped | sampled | **271 elements, 34 routes** |

## 11. Performance

The E2E shards run in parallel with the rest of CI and finish inside it, so the pipeline's
wall-clock is unchanged:

| Job | Duration |
| --- | --- |
| Lint · Typecheck · Test · Build | 5m 11s |
| End-to-end · the screens | 4m 43s |
| End-to-end · signing, faded text and search | 4m 58s |
| End-to-end · recovery and the data grid | **3m 40s** |
| Integration | 2m 55s |

Sharding is why: run as one job the suite would take longer than the pipeline's longest existing job
*and* fail on the login budget.

## 12. Reliability

| | |
| --- | --- |
| Docs E2E locally, all nine files | **161/161** |
| Docs E2E in CI | **161/161** |
| `recovery.e2e` | **19/19**, locally and in CI |
| Fixture tenants after every run | **0 / 0** |
| Retries used | **none** — the one failure was fixed, not re-run |

## 13. CI

This phase's subject. The E2E job is described in §8; the first-run failure and its fix are §9. Both
runs are recorded above rather than only the green one.

Unchanged and still red: **Cloudflare `Workers Builds: platform-storybook`** on the platform
repository, failing identically since PR #8.

## 14. Visual verification

`pnpm test:visual`: **93 pass, 14 fail** — the same Arabic screens, for the same reason, unchanged
across three phases now. Baselines were **not** re-recorded, and the canonical-font question stays
open as candidate 6. The count being unchanged is again the differential result: this phase's
changes moved no pixels.

## 15. Release

**None.** Docs CI and test-harness only. Platform is untouched at `61810a6`, and Docs still consumes
`@munaxa/platform@1.5.1` from the registry — re-verified from a fresh store this phase.

## 16. Deferred findings

- **Unnamed `<aside>` and nameless `<section>` on `/documents`** — now measured precisely (2 of 271
  landmarks, both Docs-owned, both in one flex row) rather than merely recalled. The `<aside>` is an
  anonymous `complementary` landmark; the `<section>` is not a landmark at all, since a section
  without a name is not one. Naming them is a semantic decision about what that panel *is*, which is
  a phase's work, not a rider on a CI change.
- **`region` on the menu portal wrapper** — investigated this phase (§19 of the brief): the wrapper
  is Radix's `div[data-radix-popper-content-wrapper]`, has **no role**, is a direct child of `body`,
  and exists only while a layer is open. It is not a landmark and does not claim to be; axe counts
  the menu's content as content outside any landmark. Fixing it means owning where a portal renders,
  which is a platform architecture decision.
- **CI wall-clock headroom**, **Arabic visual environment**, **doc-kit ×12**, **ContextMenu**,
  **`Combobox` ArrowDown**, **single viewport**, **`aria-errormessage`**, **Cloudflare check** —
  carried unchanged.

## 17. Corrections

Previous reports are not edited. Two corrections, both to this audit's own work.

**Phase 8.20 misclassified a `shell.e2e` failure.** It saw "no way to reach navigation on search at
640px" during a contended local run and classified it as CPU contention causing a sign-in timeout —
the sign-in timeouts in that run were real, but this assertion is a *different* failure with a
different cause, and it has now been traced: the drawer trigger does not exist until the client
hydrates. Two failures in one run were read as one.

**Phase 8.21 recorded the portal `region` finding as "56 moderate nodes"** and this phase's
measurement shows the shape more precisely: it is **one** node — the popper wrapper — reported once
per open menu, on 56 opens. The reach is the same; the defect is one element, not fifty-six.

## 18. Final state

| | |
| --- | --- |
| Platform | unchanged, tree clean, `61810a6` |
| Docs | two commits, tree clean, pushed |
| Published | nothing — no release warranted |
| **E2E in CI** | **9 files, 161 tests, three shards, all green** |
| Whole Docs CI workflow | **green** — 7 of 7 jobs |
| `recovery.e2e` | **19/19** |
| Fixture tenants | **0 / 0** |
| Application axe, all scopes and dimensions | **0 violations** |
| Red gates | one, not this repository's — the platform's Cloudflare Storybook check |
| Hidden failures | none |
