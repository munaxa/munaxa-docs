# Phase 7.6B — Dashboard Recent Documents & Responsive Completion

**Verdict: PARTIALLY COMPLETE.** Recent Documents is materially improved, and RTL and 390px are now
verified with images for the first time. **The running-application verification (Step 11) is
BLOCKED**, not skipped — this container has no PostgreSQL and no Redis, and the E2E harness boots
the real API. Evidence in §10.

---

## 1. The finding: the row was discarding four fields it already had

`DocumentSummary` — the exact type the dashboard already receives — carries:

| Field | Rendered before? |
| --- | --- |
| `title` | yes |
| `documentNumber` | yes |
| `status` | **no** |
| `folderName` | **no** |
| `file.mimeType` | **no** |
| `updatedAt` | **no** |

The row rendered a title and a number, and threw the rest away. No new request, no new field, no
contract change was needed to fix that — the data was in hand the whole time.

**Not available, therefore not built:** `updatedBy` is a **UUID only**. The reference's "by Sarah
Ahmed" cannot be rendered, for the same reason Phase 7.5 found the account chip showing a raw UUID —
there is no name anywhere in the payload. Refused rather than approximated.

---

## 2. The new row

```
Quality Manual                                    [✓ Published]
Quality   QM-0001   1/2/2026
```

- **Line one** — title at `font-medium`, the strongest text; `DocumentStatusBadge` at the end.
- **Line two** — format family, folder, number, date. All `text-xs text-muted-foreground`, so the
  number no longer competes with the title, which is what §3 asked for.
- Status is **not colour-alone**: `DocumentStatusBadge` already pairs a word with an icon.
- The whole row is one link with a visible focus ring and a hover tint — a larger target than the
  bare title it replaced.

**Platform components:** `Stack`, `Link`, `DocumentStatusBadge` (existing, reused — no second status
component), `formatFor` from `@edms/domain` (the same helper the library's `FormatBadge` uses, so
the format vocabulary is shared rather than forked). **No new component, token, colour, radius,
shadow or font size. No new i18n key**, therefore no invented Arabic.

---

## 3. Deliberately rejected

| Reference element | Reason |
| --- | --- |
| "by Sarah Ahmed" | `updatedBy` is a UUID; no name exists in the payload |
| Row action menu (⋮) | The dashboard has no row action today; §6 forbids inventing one |
| Coloured per-type file icons | The product's format vocabulary is a text family via `formatFor`; recolouring it here would fork it |
| Favourite *folders* | The API returns favourite documents (settled in 7.6A) |

---

## 4. Request budget — §12 and §15

| | Before | After |
| --- | --- | --- |
| Dashboard API calls | 1 × `GET /dashboard` + the two document lists the route already resolved | **identical** |

**Zero requests added.** Every field now shown was already on the objects the component received as
props. No client-side fetch, no per-row request, no loop. Nothing moved into the workspace layout.

---

## 5. Responsive evidence

| Width | Evidence | Result |
| --- | --- | --- |
| 1280 light/dark | baseline, **inspected** | title/status line and metadata line correct |
| 390 | **new** `dashboard-mobile` baseline, **inspected** | single column; status not clipped; metadata wraps; no horizontal overflow |
| 1440 / 1024 / 768 / 640 | **NOT INSPECTED** | no baseline at these widths |

At 390 the KPI region stays two-up, the two list columns collapse to one, and the row's second line
wraps rather than truncating. `UNREAD NOTIFI…` truncates with an ellipsis — that is `StatCard`'s own
label behaviour and pre-existing, not introduced here.

---

## 6. RTL evidence — verified with images for the first time

Four new baselines: `ar-dashboard-light`, `ar-dashboard-dark`, `ar-dashboard-mobile-light`,
`ar-dashboard-mobile-dark`. Inspected at 2×:

- Panel titles right-aligned (`المفتوحة مؤخرًا`, `المفضلة`); "عرض الكل" mirrored to the left.
- The status badge and its icon mirror correctly; `منشورة` renders with the tick.
- **The mixed-direction case holds.** `QM-0001` and `2026/1/2` stay coherent LTR runs inside the RTL
  line — no reversed digits, no broken number. This was the specific risk §9 flagged and it is now a
  picture rather than an argument.
- The date is `toLocaleDateString('ar')`, so the calendar formatting is the locale's, not a
  hand-rolled ladder.

No Arabic wording was changed.

---

## 7. Accessibility

axe runs against the dashboard through `screens.a11y.spec.tsx` in `pnpm test` — **PASS**.

The row is a single `<a>` containing both lines, so its accessible name is the whole row rather than
a bare title, and it has a visible `focus-visible` ring. `<time dateTime>` carries the machine
timestamp beside the localized text. No landmark or heading was added, so no duplicate landmarks.

---

## 8. Tests

New `recent-documents.spec.tsx`, 5 tests — title from real data · folder shown · **status as a word,
not an enum or a key path** · date derived from `updatedAt` rather than invented · row links to the
document it names. All assert what a reader sees, not how it is built.

Combined with 7.6A's `status-labels.spec.tsx` (3 tests, previously proved to fail), the dashboard
now has 8 focused regression tests where it had none.

No test weakened, skipped, or given a wait.

---

## 9. Gates — RUN / PASS / FAIL / NOT RUN / BLOCKED

| Gate | Status |
| --- | --- |
| `pnpm format:check` | RUN — PASS |
| `pnpm lint` | RUN — PASS 13/13 |
| `pnpm typecheck` | RUN — PASS 13/13 |
| `pnpm test` | RUN — PASS 13/13, including the 5 new tests |
| `pnpm verify:styles` | RUN — PASS 10/10 |
| `pnpm --filter @edms/web build` | RUN — PASS |
| `pnpm test:visual` | RUN — 93 pass / 10 fail, all ten **PRE-EXISTING** Arabic-font surfaces |
| `responsive.spec.tsx` | RUN — PASS 24/24 |
| axe | RUN — PASS |
| Dashboard E2E / Chromium app | **BLOCKED** — see §10 |

---

## 10. Why the running application could not be verified

Step 11 is mandatory in this brief. It is blocked by the environment, and that is measured rather
than assumed:

```
pg_isready -h 127.0.0.1 -p 5432   →  no response
redis-cli   -h 127.0.0.1 ping     →  Connection refused
```

The E2E harness (`src/test/e2e/servers.ts`) boots the real API, which requires `DATABASE_URL` and a
Redis connection. Neither service exists in this container, and starting them is infrastructure
work outside a visual phase.

**Consequently unverified:** dashboard load against a live API · real data rendering end to end ·
"View all" navigation · console and server errors · that no fan-out was introduced *at runtime*
(the static argument in §4 is strong — no fetch was added — but it is an argument).

This is the third phase in which running-app verification has been requested and not delivered. It
needs either a container with PostgreSQL and Redis, or the CI `integration` job — which now works —
extended to run the dashboard E2E.

---

## 11. Remaining dashboard opportunities

1. **1440 / 1024 / 768 / 640 baselines** — the four widths still uninspected.
2. **`FormatBadge` was not exercised visually.** The fixture's document has no file, so the format
   family never rendered in a baseline. The code path is covered by types, not by a picture.
3. **"My recent activity" still renders raw action codes** (`DOCUMENT_APPROVED`) in monospace.
   Deliberate — the audit vocabulary must not fork — but it is the least readable text on the screen.
4. **Two near-empty panels.** With one fixture row each, "Recently opened" and "Favourites" look
   sparse; the composition is right but the fixture does not exercise density.

---

## 12. Completion criteria

Met: Recent Documents materially improved · real API data only · nothing fabricated · platform
components reused · no new design system · **zero new requests** · 1280 verified · 390 verified ·
Arabic RTL verified · light and dark verified · axe passes · baselines inspected · regression tests
added · existing behaviour preserved · no test weakened · report written and indexed · tree clean ·
committed · pushed · no PR.

**Not met:** 1440 · 1024 · 768 · 640 · **real Chromium E2E (BLOCKED — no database)**.

**Verdict: PARTIALLY COMPLETE.**

---

## 13. Commands executed

```
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm verify:styles
pnpm --filter @edms/web build
pnpm --filter @edms/web test:visual
pnpm --filter @edms/web exec vitest run --project browser src/test/responsive.spec.tsx
pnpm --filter @edms/web exec vitest run --project a11y src/features/dashboard/recent-documents.spec.tsx
pg_isready -h 127.0.0.1 -p 5432
redis-cli -h 127.0.0.1 ping
```
