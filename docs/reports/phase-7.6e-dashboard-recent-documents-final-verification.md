# Phase 7.6E — Dashboard Recent Documents Final Verification

## Status

**COMPLETE.** All four evidence gaps left by Phase 7.6D are closed against the running application.

## Objective

Close the four gaps 7.6D left open: the populated row in dark, the populated row in Arabic/RTL, axe
against the live populated page, and the row's click actually navigating.

## Previous Evidence

7.6D proved the row is produced by the real product path and rendered from real data at six widths,
in light theme. It explicitly did not verify dark, RTL, live axe, or navigation — it had asserted
only that the row *was* a link, which is not the same as the link working.

## Real Data Path

Unchanged and re-exercised in this phase:

```
real login → GET /documents/:id → DocumentService.open() → activity.recordView()
           → GET /documents/recent → Recent Documents row
```

No row inserted, no handler called directly, no event fabricated, no API mocked, no auth bypassed.

## Dark Theme

Toggled **through the product's own control** — a click on the top bar's theme button, which is what
a person uses and what writes the `edms.theme` preference the platform reads. Not a class set by the
test.

Asserted: `documentElement` gains `dark`; the row keeps its document number; the empty state does
not return. Screenshot captured and **inspected at 2×**:

```
Recently opened                                    See all
Batch release procedure                          [✎ Draft]
PDF  Root  SOP-E2E-0001  8/10/2026
```

Panel sits on the dark surface with a visible edge; the title stays high-contrast; the `Draft` badge
and its pencil remain legible rather than merging into the background; the muted metadata line is
dimmer but readable. Nothing clipped, nothing colour-only. No new colour, radius, shadow or token was
introduced — the theme is entirely the platform's.

## Arabic / RTL

Set through the application's **real** locale mechanism, the `edms_locale` cookie read server-side in
`lib/session.ts`, then a normal navigation. No CSS fake, no test-only attribute.

Asserted at **1280 and 390**: `html[dir="rtl"]`, `html[lang="ar"]`, the document number still present,
and `scrollWidth <= clientWidth`. Screenshots **inspected**:

- `المفتوحة مؤخرًا` right-aligned; `عرض الكل` mirrored to the left.
- Status renders as `مسودة` with its pencil, mirrored to the row's left.
- The Latin title flows correctly inside the RTL line.
- **The mixed-direction case holds** — `SOP-E2E-0001` and `2026/8/10` are intact, coherent LTR runs.
  Neither is reversed or broken. This is the specific failure RTL produces in practice and it is now
  a picture from the running product rather than a static render.

No Arabic string was invented; every word comes from the reviewed catalogue. No missing key was
encountered.

## Accessibility

axe run **against the live page with the row populated**, in the real browser. axe-core 4.13.0 was
already a repository dependency and is injected into the page — no new package.

Filtered to `critical` and `serious`: **zero violations.**

This is stronger than the jsdom suites, which must switch `color-contrast` off because jsdom has no
cascade. Here the rule can run.

## Navigation

7.6D asserted the row was a link. This phase clicks it:

```
dashboard → click the row → waitForURL(/documents/{id}) → assert the document number is rendered
```

No `page.goto`, no location assignment, no mocked router. The destination is asserted to contain the
document's number and **not** to be an error boundary — arriving somewhere is not the same as
arriving at the document.

## Responsive Evidence

7.6D's six-width evidence stands and was **re-run** as part of this suite (the file runs as one
session). No sixth login was added; the established one-session, resize-the-same-page pattern is
preserved, for the rate-limit reason Phase 7.1C established.

## Regression Tests

`dashboard.e2e.spec.ts` — **19 tests**, five new:

1. clicking the row navigates to the real document
2. no critical/serious axe violations with the row populated
3. the populated row renders in dark through the real toggle
4. the populated row renders in Arabic at 1280
5. the populated row renders in Arabic at 390

They fail if the populated row disappears, its metadata disappears, the row stops navigating, RTL
breaks, or dark loses the content.

## Test-Proof

Required by §11. The `documentNumber` span was removed from `DocumentLines`, the web app rebuilt,
and the suite re-run — the assertion each new test anchors on. The break is the same one 7.6D proved,
chosen because it is load-bearing for all four new areas at once: the navigation test finds the row
*by* its number, and the dark and both Arabic tests assert the number survives.

```
× navigates to the real document when the row is clicked
× renders the populated row in dark, through the real toggle
× renders the populated row in Arabic at 1280px
× renders the populated row in Arabic at 390px
× records a document as recently opened … and shows it on the dashboard
× keeps the populated row within the viewport at every width
  Tests  6 failed | 13 passed (19)
```

**All four new areas failed**, alongside 7.6D's two. The change was reverted and the suite re-run green; `git diff` on
`dashboard-screen.tsx` is empty, so the restore is byte-identical. No assertion was weakened
afterwards.

## Gates

| Gate | Result | Notes |
|---|---|---|
| `pnpm format:check` | PASS | |
| `pnpm lint` | PASS | 13/13 |
| `pnpm typecheck` | PASS | 13/13 |
| `pnpm test` | PASS | 13/13 |
| `pnpm verify:styles` | PASS | 10/10 |
| `pnpm --filter @edms/web build` | PASS | rebuilt for the test-proof and the restore |
| **Dashboard E2E** | **PASS** | **19/19** against the real stack |
| **axe (live, populated)** | **PASS** | zero critical/serious |
| `pnpm test:visual` | PRE-EXISTING | 93 pass / 10 fail — the known Arabic-font surfaces, unrelated |
| Responsive suite | PASS | 24/24 |
| Integration | NOT RUN | no `apps/api` code changed |

## Findings

**Fixed / closed** — all four 7.6D gaps: dark, Arabic/RTL, live axe, real navigation.

**Deferred** — none arising from this phase.

**Pre-existing, untouched** (per §12) — account-chip UUID; `SidebarNav` contrast 2.78:1; rail badge
fan-out; favourite folders absent from the contract; no row action menu; `Retry-After`; Arabic
native-speaker review; `DataGrid` responsive limitations.

**Platform** — none newly discovered.

**Blocked** — none.

## What Is Verified

Real PostgreSQL 16.13 · real Redis 7.0.15 · real API · real production web build · real login form
and session · a document made recent through `open() → recordView()` · the row rendered with title,
status, format, folder, number and date · six widths without overflow · **dark through the product's
own toggle** · **Arabic/RTL at 1280 and 390 via the real locale cookie, with LTR runs intact** ·
**live axe, zero critical/serious** · **a real click that navigates to the real document** · no
console errors · at most one `/dashboard` call, none on resize · a test proved able to fail.

## What Is Not Verified

- **Dark at 390 and dark in Arabic** were not captured; dark was verified at 1440 only.
- **Keyboard traversal to the row** was not exercised; focus styling is asserted by CSS and axe, not
  by a Tab sequence.
- The Arabic **date format** is `2026/8/10` from `toLocaleDateString('ar')`; that it is the *correct*
  civil-calendar presentation for an Arabic-locale user is a localization judgement no native speaker
  has reviewed — the same open item carried from Phase 7.4C.

## Closure Assessment

**The populated Recent Documents running-app evidence gap is closed.**

The row is verified end to end in the real product: real data reaches it, a real user can read it in
both themes and both directions, it passes axe where the cascade is real, and clicking it goes where
it says. The residue in *What Is Not Verified* is narrow and none of it blocks the dashboard work.
