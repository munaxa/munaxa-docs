# Phase 8.25 — Final Audit Closure

## 1. Status

**COMPLETE — READY TO ENTER PHASE 9.**

No code changed in this phase, and that is the finding rather than an omission: a full re-measurement
of both repositories produced **no release blocker at the code level**. Every remaining item is now
classified with a disposition and an owner. One genuine gap exists and it is **administrative** —
neither repository's `main` branch is protected, so seven green CI jobs currently gate nothing, and
the permission to change that is not held by this session.

**This is not a statement that Munaxa Docs is production-ready.** It is a statement that the Phase 8
audit has nothing left to fix that it can fix, and that Phase 9 can begin.

## 2. Objective

Answer one question on evidence: *is there any remaining confirmed issue that must be fixed before
Munaxa Docs enters Phase 9 certification?* Fix it only if the answer is yes and it belongs here.

## 3. Baseline, verified rather than assumed

| | Expected | Measured |
| --- | --- | --- |
| Platform HEAD | `61810a6` | `61810a6` = `origin/main` ✓ |
| Docs HEAD | `4fe3c0e` | `4fe3c0e`, equal to its remote ✓ |
| Installed platform | 1.5.1 | 1.5.1 ✓ |
| Registry `latest` | 1.5.1 | 1.5.1 ✓ |
| Copies in the store | 1 | **1** ✓ |
| `@munaxa/ui` façade | 3 lines | **3** ✓ |
| `file:` / `link:` / `workspace:` for `@munaxa/*` | none | **0** ✓ |
| Lockfile resolution | registry tarball | `npm.pkg.github.com/download/@munaxa/platform/1.5.1/…` ✓ |
| `countsSql` (8.18) | present | 2 occurrences ✓ |
| Fixture teardown (8.20) | present | present, with its scope guard ✓ |
| 320 enforcement (8.21) | present | 5 references, `overflows: []` ✓ |
| Menu `modal = false` (8.22) | present | **in the installed tarball** ✓ |
| E2E in CI (8.23) | 9 files | **9 of 9**, 3 shards ✓ |
| Heading levels (8.24) | `level={3}` | both components ✓ |
| Fixture tenants | 0 | **0 / 0** ✓ |
| Both trees | clean | clean ✓ |

Environmental note, recorded because it recurs and is not a repository fact: the container's
PostgreSQL and Redis had stopped again between phases and were restarted. No state was lost.

## 4. Full measurement

### 4.1 Platform

| | Result |
| --- | --- |
| Component matrix | **52/52**, 106 stories × 4 brands × 2 schemes, 726s |
| `@munaxa/platform` unit tests | **569** across 31 files, including the 6 menu-modality guards |
| `@munaxa/auth` / `@munaxa/conformance` | 104 / 94 |
| Published tarball | inspected: carries `modal = false` for both menu families; contains no `docs/` |

### 4.2 Application — 177 measurements, unfiltered

Every sweep ran the **full axe ruleset with no impact filter**.

| Scope | Pages | Findings |
| --- | --- | --- |
| Signer, 1280, light | 33 | 0 |
| Parameterised (`/documents/:id`, `…/permissions`) | 2 | 0 |
| Signer at **320** | 33 | 0 — and 0 horizontal overflow |
| Signer at **390** | 33 | 0 — and 0 horizontal overflow |
| **Dark** | 33 | 0 |
| **Arabic / RTL** (`dir="rtl"` confirmed) | 33 | 0 — and 0 overflow |
| **Reader** session | 8 | 0 |
| **Anonymous** — `/login`, `/mfa` | 2 | 0 |
| **Total** | **177** | **0 at any impact** |

### 4.3 Overlays

| Family | Opened | `aria-hidden` focusables | `aria-modal` | Escape closes | Focus restored |
| --- | --- | --- | --- | --- | --- |
| Menus (Account, Columns, Actions) | 10 | **0** | n/a — correctly absent | 10/10 | 10/10 |
| Dialogues (roles, workflows) | 2 | **0** | **`true`** | 2/2 | 2/2 |

Dialogue focus containment re-measured: 15 Tab presses, **0** escapes from either dialogue.

### 4.4 Reliability

| | Result |
| --- | --- |
| Docs E2E | **161/161** (83 + 56 + 22) |
| `recovery.e2e` | **19/19**, 69s |
| Restore destination | started with **0** `edms` databases, ended with **2** restored |
| Fixture tenants after everything | **0 / 0** |
| Retries used | none |
| Docs unit: api / web / domain / contracts / worker | 649 (+1 skipped) / 179 / 164 / 26 / 2 |
| lint · typecheck · production build · `verify:styles` | all green |

## 5. Accessibility result

**Zero findings at any impact across 177 application measurements**, plus 52/52 on the component
matrix. The only accessibility observations left in the system are the two documented exceptions in
§13 — the portal wrapper and the `/documents` landmark pair — neither of which appears in a resting
page sweep.

## 6. Overlay result

Every overlay the product renders satisfies the full contract: it opens, it is named, focus enters
it, focus stays in it where modality is claimed, Escape closes it, and focus returns to the trigger.
Menus no longer hide the application (8.22); dialogues declare `aria-modal` and hide nothing.

## 7. Landmark result

Re-reviewed per §8 of the brief and the disposition is unchanged, now with the reasoning stated in
full:

- **The `<aside>` on `/documents`** contains exactly one thing — `FolderTree`, which renders its own
  `<nav aria-label="Libraries and folders">`. So the outer element contributes an **anonymous
  `complementary`** wrapped around a **named `navigation`**. It is not misleading and it duplicates
  no name; it adds one unnamed entry to a landmark list that already names what is inside it. It is
  not harmful, and the navigation inside already provides the correct landmark.
- **The nameless `<section>`** holds the document list. A `section` with no accessible name is *not*
  a landmark, so it exposes nothing at all — it is a `<div>` wearing a semantic tag, inside `main`,
  orphaning nothing.

**Accepted.** Changing either is a one-line edit whenever a phase wants to own the decision; neither
belongs in a closure assessment, and Phase 8.16's history — `<aside>` → `<div>` → `<nav>` across
three phases — is the reason to make that change deliberately rather than in passing.

## 8. Reliability result

Everything the audit fixed is still fixed, and each is now guarded by something that runs without a
person: DR scalability and the restore rehearsal by `recovery.e2e`; the fixture teardown by its own
assertion plus a zero-tenant check; 320px reflow by `consistency.e2e` at three widths on 33 routes;
menu modality by `menu-modality.test.tsx` in platform CI; the heading outline by
`dialog-headings.a11y.spec.tsx`. All of the Docs guards run in Docs CI.

## 9. CI result

Read from the workflow rather than from its badge:

| Property | Measured |
| --- | --- |
| Jobs defined | `node`, `integration`, `e2e` (×3 shards), `images`, `boundaries` |
| E2E files in CI | **9 of the 9 that exist** |
| Shard isolation | each shard has its **own** `postgres`, `postgres-dr` and `redis` containers |
| Login budget | 7 / 8 / 4 against 10 per 300s, one Redis per shard |
| DR destination | independent service, **emptiness asserted** before the suite runs |
| Failure logs | API and web logs uploaded on failure |
| Production build | built in every shard; the suite runs the shipped artefacts |
| Browser | Chromium installed per shard |
| `fail-fast` | `false` — one shard's failure does not hide another's result |
| Concurrency | `cancel-in-progress` per ref |
| Triggers | `pull_request`, `push` to `main` and `claude/**`, `workflow_dispatch` |
| Last run | `08dc046` — **7/7 green** |

**And the gap.** `GET /repos/munaxa/munaxa-docs/branches/main` reports `"protected": false`. The same
call for `munaxa/munaxa-platform` reports `"protected": false`. The protection endpoint returns
**403** for both, because this session does not hold repository administration rights.

So the correct statement is: **CI runs on every commit and blocks nothing.** Nothing prevents a red
pipeline from being merged into either repository. This report does not claim CI "gates" anything.

## 10. Visual result

| | Result |
| --- | --- |
| Pass / fail | **93 / 14** |
| Distinct screens failing | 7 (`ar-dashboard`, `ar-dashboard-mobile`, `ar-document-list-{one,two,few,many,mobile}`) × 2 themes |
| Non-Arabic failures | **0** |
| Arabic fonts in this container | **0** (`fc-list`) |
| Layout | pixel-identical; differences are glyph-only |

Reproduced again this phase, identical set. Baselines were **not** regenerated. The canonical font
environment is still not available here, so this remains **environmental**, and it is a Phase 9 entry
gate rather than a defect.

## 11. Security result

Reconfirmed rather than assumed:

- `auth.login` is still `windowSeconds: 300, limit: 10, by: ['ip', 'identity']`, and
  `apps/api/src/core/security/` has not been touched since Phase 6.7 — long before this audit
  sequence began. **No limiter change, no timeout inflation.**
- No test-only bypass exists in production code: a search for `NODE_ENV === 'test'`, `E2E` env reads,
  `skipAuth` and `bypass` outside test files returns only prose in the delegation domain describing
  what an *emergency delegation* bypasses — a product control, not an auth escape.
- The fixture teardown still refuses any tenant whose slug does not begin `e2e`, and still runs each
  tenant in one transaction with the append-only trigger lifted only inside it.
- Tenant isolation is asserted by the integration suite in CI and by `signing.e2e`'s neighbour-tenant
  checks in the E2E shards.
- The E2E suite stays inside the product's own login budget by design (7 / 8 / 4 against 10).

## 12. Recovery result

**19/19.** The destination cluster started with 0 `edms` databases and finished with the 2 restored
ones; the source was unaffected; no stale fixture tenants remained; `countsSql` is present and
unmodified; the teardown remains transactional. No timeout was raised.

## 13. Complete remaining-candidate classification

| Finding | Evidence | Severity | Owner | Layer | Production impact | Release impact | Reproducibility | Status | Required action | Phase |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| DR scalability | 23,068 → 292 processes | — | Docs | harness | none | none | deterministic | **RESOLVED** | keep `countsSql` | 8.18 ✓ |
| Fixture teardown | 150 stale → 0, guarded | — | Docs | harness | none | none | deterministic | **RESOLVED** | none | 8.20 ✓ |
| `/delegations` 320px reflow | 112px → 0px | — | Docs | app | none | none | deterministic | **RESOLVED** | none | 8.21 ✓ |
| Menus hiding the app from AT | 321 serious → 0 | — | platform | component | none | none | deterministic | **RESOLVED** | none | 8.22 ✓ |
| E2E absent from CI | 0 → 9 files, 161 tests | — | Docs CI | CI | none | none | deterministic | **RESOLVED** | none | 8.23 ✓ |
| Dialogue heading outline | 18 × h4 → h3 | — | Docs | app | none | none | deterministic | **RESOLVED** | none | 8.24 ✓ |
| **`main` unprotected, both repos** | `protected: false`; API 403 | high | repo admin | governance | none directly | **enforcement absent** | deterministic | **ADMINISTRATIVE** | an admin configures required checks | **9 entry gate** |
| Arabic visual baselines | 14/107, 0 Arabic fonts | medium | release env | environment | none — glyph rendering only | verification incomplete | deterministic | **ENVIRONMENTAL** | establish the canonical font environment, then re-verify | **9 entry gate** |
| CI wall-clock headroom | 13–15× runner variance; ≈92% local headroom | low | CI infra | CI | none | occasional false red | intermittent | **ENVIRONMENTAL** | watch; do not raise budgets | 9, informational |
| Portal `region` | 1 Radix element, no role, `tabIndex −1`, gone when closed | low | Radix | third-party | negligible | none | deterministic | **ACCEPTED** | none; rule stays on | — |
| `doc-kit` ×12 | not in `files`, not in the 1.5.1 tarball | low | platform docs | unshipped | **none — unshipped** | none | deterministic | **ACCEPTED** | none | — |
| `/documents` landmark pair | 2 of 271; aside wraps a *named* nav | low | Docs | app | negligible | none | deterministic | **ACCEPTED** | optional one-line change, deliberately | post-launch |
| ContextMenu sub-parts | platform ships it; Docs uses **0** | low | platform | component | none in this product | none | n/a | **NO ACTION** | measure if Docs adopts it | — |
| `Combobox` ArrowDown | APG enhancement, no product evidence | low | platform | component | none | none | n/a | **POST-LAUNCH** | evidence first | post-launch |
| Single-viewport component matrix | matrix runs one viewport | low | platform | harness | none | none | n/a | **POST-LAUNCH** | optional coverage | post-launch |
| `aria-errormessage` | unused by the product | low | Docs | app | none | none | n/a | **NO ACTION** | none | — |
| Cloudflare Storybook check | red since PR #8, external dashboard | low | external | external | none | none | deterministic | **EXTERNAL DEPENDENCY** | owner outside these repos | 9, informational |
| E2E login budget | resolved as a CI contract | — | Docs CI | CI | none | none | deterministic | **RESOLVED** | none | 8.23 ✓ |
| Local service shutdowns | Postgres/Redis stop between phases | low | container | environment | none | none | intermittent | **ENVIRONMENTAL** | none | — |

Nothing is left as "deferred" without a destination.

## 14. Release-blocker determination

Against the definition in §15 of the brief:

| Criterion | Evidence | Blocker? |
| --- | --- | --- |
| Breaks core user functionality | 161/161 E2E across the real product | no |
| Material accessibility failure in shipped functionality | 177 measurements, 0 findings at any impact | no |
| Compromises security or tenant isolation | limiter untouched since 6.7, no bypasses, isolation asserted | no |
| Makes recovery unreliable | 19/19, empty→restored destination verified | no |
| Makes deployment unsafe | production build green; images build in CI | no |
| **Leaves required verification unenforced** | **CI is green but nothing requires it — `main` unprotected in both repos** | **yes, and it is administrative** |
| Deterministic production failure | none observed | no |
| Unacceptable data-integrity risk | append-only audit intact, RLS intact, teardown scoped | no |

**Code-level release blockers: none.** One criterion is met — verification is not *enforced* — and
its remedy is a repository setting, not a change to either codebase. Per §15's closing rule, a
finding is not classified as a code blocker merely because it requires administration this session
cannot perform; it is recorded as an **entry gate for Phase 9** instead.

No code was changed in this phase. No Platform version was published. No visual baseline was
regenerated. No accepted structure was removed to produce a tidier report.

## 15. Phase 9 entry gates

**Product**

1. Production routes reachable and functional — evidence: 161/161 E2E.
2. Authentication, role restrictions and the reader role — evidence: E2E reader scope, `signing.e2e`.
3. Responsive behaviour at 1440 → 320 — evidence: `consistency.e2e`, `shell.e2e`.
4. RTL / Arabic — evidence: 33 routes at `dir="rtl"`, 0 findings.
5. No release-blocking accessibility defect — evidence: 177 measurements, 0 findings.

**Accessibility**

6. Component matrix green — 52/52.
7. Application sweep green, unfiltered — 0 findings.
8. Keyboard and overlay semantics proven — menus and dialogues, full contract.
9. Landmark architecture classified — 271 elements; two accepted exceptions documented.
10. Accepted exceptions documented with rationale — §13.

**Reliability**

11. E2E green — 161/161.
12. Recovery green — 19/19, destination empty→restored.
13. Fixture cleanup green — 0 tenants after every run.
14. No unexplained retries, no timeout inflation — none used, none present.

**CI**

15. Required jobs exist — 7 job instances, all green.
16. E2E enforced — **NOT MET**: runs on every commit, required by nothing (§9).
17. Production build enforced in CI — met, in `node` and in every E2E shard.
18. Branch protection status explicitly verified — **verified as absent, both repositories**.

**Security**

19. Tenant isolation, authentication, authorization, audit — asserted in integration and E2E.
20. No test bypasses in production code — searched and confirmed.
21. No weakened production controls — limiter, timeouts and budgets untouched.

**Release**

22. Registry package verification — 1.5.1 `latest`, tarball inspected.
23. Clean frozen install — `--frozen-lockfile` from a wiped store, one copy.
24. Production build — green.
25. Deployment verification — **not yet exercised**; Phase 9 owns it.
26. Rollback / recovery procedure — the DR rehearsal proves restore; a documented rollback
    *procedure* is Phase 9's to certify.

## 16. Administrative prerequisites

1. **Branch protection on `munaxa/munaxa-docs@main`** — require the seven CI checks (`Lint ·
   Typecheck · Test · Build`, `Integration`, the three `End-to-end` shards, `Container images`,
   `Product isolation`) before merge.
2. **Branch protection on `munaxa/munaxa-platform@main`** — likewise for its CI and façade checks.
3. Both require an account with repository administration rights. This session's attempts return
   **403**, and no attempt was made to work around that.

Until (1) and (2) exist, "CI is green" is a description of what happened, not a guarantee about what
can be merged. Phase 9 should treat them as entry gates and verify them by API rather than by
assertion.

## 17. Environmental prerequisites

1. **A canonical Arabic font environment** for the visual suite. Until it exists, 14 of 107
   screenshots cannot be verified anywhere — including in CI. The baselines are not the problem and
   must not be re-recorded to produce a green suite.
2. **CI runner variance** — platform performance budgets hold with ~92% headroom locally and have
   tripped on slow runners. Watch; do not raise budgets.
3. **The Cloudflare Storybook check** — red since PR #8, owned outside these repositories.

## 18. Accepted limitations

- The Radix portal wrapper is counted by axe's `region` rule while a menu is open. One element, no
  role, not focusable, gone on close; wrapping a transient menu in a landmark would be worse for the
  person the rule protects. The rule stays enabled so the finding stays visible.
- `doc-kit`'s 12 `scrollable-region-focusable` findings live in Storybook documentation pages that
  are excluded from the package `files` and absent from the published tarball.
- `/documents` carries an anonymous `complementary` around a named `navigation`, and a nameless
  `<section>` that is not a landmark at all.
- `ContextMenu`'s seven sub-parts are unmeasured because this product renders none.

## 19. Post-launch items

`Combobox` ArrowDown (an APG enhancement, no product evidence of a defect); a second viewport in the
component matrix; `aria-errormessage`, currently unused; and the optional `/documents` landmark
tidy-up.

## 20. Corrections

Previous reports are not edited. One correction, found by re-measuring rather than re-reading.

**Phase 8.22 overstated the platform test count.** Its coverage table recorded "Platform tests 569 →
575". The measured figure today is **569**, and the six `menu-modality` tests are present and
running — so the true progression was **563 → 569**. Phase 8.16 had established 563, and 8.22's own
pull request body recorded 569 after the change; the report's table added the six twice. The guard
exists and works; only the arithmetic in that one row was wrong.

## 21. Final recommendation

**Proceed to Phase 9 — Production Readiness & Release Certification.**

The Phase 8 audit has no remaining code-level release blocker in either repository. Six substantive
defects were found and fixed across 8.18–8.24, each with a guard that now runs without a human, and
the remaining twelve candidates are classified as accepted, environmental, external, post-launch, or
administrative — none of them a reason to keep the audit open.

Phase 9 should open on the two administrative prerequisites in §16, because they are the difference
between a pipeline that reports and a pipeline that enforces, and no amount of further auditing in
this repository can close them.

**Status: READY TO ENTER PHASE 9. Not production-ready — that is Phase 9's determination to make.**
