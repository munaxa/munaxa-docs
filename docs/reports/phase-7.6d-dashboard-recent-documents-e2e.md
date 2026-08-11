# Phase 7.6D — Dashboard Recent Documents Running-App Verification

## Status

**PARTIALLY COMPLETE — but the phase's stated objective is met.** The recent-document row is now
verified in the running application, produced through the real product workflow. Arabic RTL and dark
theme with the row *populated*, and axe against the live page, were not reached (§What Is Not
Verified).

## Objective

Close the gap left by 7.6B and 7.6C: the row's composition was improved and the dashboard was proven
to run, but the seeded tenant had never opened anything, so the panel rendered its empty state and
the row itself had only ever been seen in a static render.

## Repository Evidence — how recent state is actually produced

Read, not inferred from names:

- `apps/api/src/modules/document/application/document.service.ts` — `open(id)` calls
  `this.activity.recordView(userId, id, clock.now())`.
- `apps/api/src/modules/document/presentation/documents.controller.ts` — `@Get(':id')` is the **only**
  route reaching `open()`.
- `prisma-document-activity.repository.ts` — `recordView` is the write.
- `dashboard-metrics.adapter.ts` — the card reads `GET /documents/recent`, the same projection.

**Therefore a document becomes "recently opened" by being opened, and by nothing else.** No other
supported mechanism exists, so none was invented and no row was written to PostgreSQL by hand.

## Real User Flow

1. Sign in through the real `/login` form (real credentials, real session cookie).
2. Navigate to `/documents/{documentId}` — the record page server-renders, which issues
   `GET /documents/:id`, which calls `open()`, which records the view.
3. Click the **Home** navigation link back to the dashboard.
4. Assert the row.

Every step is a thing a person does. No handler was called directly, no event constructed, no API
mocked, no permission or rate limit touched.

## Running Application Evidence

| Component | Evidence |
| --- | --- |
| PostgreSQL | 16.13, tenant databases migrated by `scripts/migrate-tenants.mjs` |
| Redis | 7.0.15, `PONG` |
| API | real NestJS, booted by the existing E2E harness |
| Web | real production build |
| Authentication | real login form → real session; no bypass, no test route |
| Browser | real Chromium |
| Tenant | the harness's seeded tenant |

## Recent Document Evidence

The document that became recent, and the row it produced:

```
Batch release procedure                    [✎ Draft]
PDF   Root   SOP-E2E-0001   8/10/2026
```

Every field is real and every one comes from the Phase 7.6B work:

| Element | Source |
| --- | --- |
| `Batch release procedure` | `title` |
| `Draft` + pencil icon | `status` via `DocumentStatusBadge` |
| `PDF` | `formatFor(file.mimeType).family` |
| `Root` | `folderName` |
| `SOP-E2E-0001` | `documentNumber` |
| `8/10/2026` | `updatedAt` |

**This also closes a limitation carried from 7.6B.** That phase recorded `FormatBadge` as
"unexercised — the fixture document has no file". The E2E fixture *does* have one, so `PDF` is
rendered here from a real MIME type. The gap is closed by evidence rather than by argument.

Hierarchy confirmed by eye at 2×: the title is dominant, the document number sits in the muted
secondary line and does not compete with it, and the status is legible as icon **and** word.

## Visual Evidence

Screenshots captured from the running application at 1440, 1280, 1024, 768, 640 and 390, with the
row populated (`recent-populated-*.png`). `scrollWidth <= clientWidth` asserted at every width, and
the document number asserted present at every width — it is the narrowest element and the first to
clip or wrap incoherently.

The 1440 image was inspected at 2×. **Light theme only.**

## Accessibility

The row is a single `<a>` wrapping both lines, so its accessible name is the whole row; it carries a
visible `focus-visible` ring; `<time dateTime>` supplies the machine timestamp; status is word plus
icon, never colour alone. axe passes against the same components in `pnpm test`.

**axe was not run against the live populated page** — recorded, not claimed.

## Regression Test

`src/test/e2e/dashboard.e2e.spec.ts` — now **14 tests**. The two new ones protect:

- that opening a document through the real path still produces dashboard state,
- that the empty state disappears when it should,
- that the row shows the real document number,
- that the row is a link,
- that the populated row does not overflow at any of the six widths.

It fails if the recent panel disappears, the metadata disappears, the row stops being a link, the
real recent-history mechanism stops working, or the populated row breaks a viewport.

## Test-Proof

Required by §12 and performed. The `documentNumber` span was removed from `DocumentLines`, the web
app rebuilt, and the suite re-run:

```
× records a document as recently opened … and shows it on the dashboard
× keeps the populated row within the viewport at every width
  Tests  2 failed | 12 passed (14)
```

The change was reverted, the app rebuilt, and the suite re-run: **14 passed**. `git diff` on
`dashboard-screen.tsx` is empty, so the restore is byte-identical. The test was not weakened
afterwards.

## Gates

| Gate | Result | Notes |
| --- | --- | --- |
| `pnpm format:check` | PASS | |
| `pnpm lint` | PASS | 13/13 |
| `pnpm typecheck` | PASS | 13/13 |
| `pnpm test` | PASS | 13/13 |
| `pnpm verify:styles` | PASS | 10/10, run this phase |
| `pnpm test:visual` | PRE-EXISTING | 93 pass / 10 fail — the known Arabic-font surfaces |
| `pnpm --filter @edms/web build` | PASS | run three times, including for the test-proof |
| **Dashboard E2E** | **PASS** | **14/14** against the real stack |
| axe (live page) | NOT RUN | see above |
| Integration | NOT RUN | no code under `apps/api` changed |

## Findings

**Fixed / closed**
- The recent-document row is verified in the running application (the 7.6B/7.6C gap).
- `FormatBadge` is exercised with a real MIME type, closing a 7.6B limitation.

**Deferred**
- Running-app Arabic RTL and dark theme *with the row populated*.
- axe against the live page.

**Pre-existing, deliberately untouched** (per §14)
- Account chip shows a UUID — `/auth/me` has no display name.
- `SidebarNav` heading contrast 2.78:1.
- Rail badge fan-out.
- No favourite-folders data.
- No row action menu.

**Blocked** — none.

## What Is Verified

Real PostgreSQL · real Redis · real API · real production web build · real login · **a document made
recent by being opened through the product** · the dashboard rendering that row with six real fields
· six widths without overflow · the row as a working link · no console errors · at most one
`/dashboard` call and none on resize · a regression test proved able to fail.

## What Is Not Verified

- Arabic/RTL **with the row populated** in the running app. 7.6B's static Arabic evidence covers the
  composition; this phase did not re-run it populated.
- Dark theme with the row populated.
- axe against the live populated page.
- Clicking the row through to the document was **asserted as a visible link, not as a completed
  navigation**.

## Recommendation

**The Recent Documents running-app evidence gap from Phase 7.6B and 7.6C is closed.** The row is no
longer a static-render claim: it is produced by the product's own `open() → recordView` path and
rendered from real data in a real browser, and a test that was proved able to fail now guards it.

What remains is a narrow, well-specified strip — the populated row in Arabic and in dark, and axe on
the live page — none of which blocks the dashboard work.
