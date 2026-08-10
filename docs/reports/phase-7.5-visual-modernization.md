# Phase 7.5 — Visual Modernization

**Companion:** [`phase-7.5-visual-modernization-audit.md`](./phase-7.5-visual-modernization-audit.md)
**Commits:** `86476e7` (audit), `<this commit>` (implementation)
**Verdict:** partial. One change shipped, one refused after building it, eight blocked or refused with
reasons. Read §6 before treating this as a completed modernization.

---

## 1. What changed

### 1.1 A notification bell in the top bar

The product had none. Notifications were reachable only by finding the rail row, so the one thing on
screen that changes without the reader acting had no presence in the frame that is always visible.
All four reference screenshots put a counted bell in the header.

- `apps/web/src/components/workspace-shell.tsx` — new `NotificationBell`, composed from
  `buttonVariants('ghost', …)`, `Badge` and the `Bell` icon, placed in `TopBar`'s `actions` slot.
  `TopBar` documents that slot as "Trailing content, aligned to the end: **notifications**, theme
  toggle, the user menu", so this is the composition the platform intends.
- `apps/web/src/app/(workspace)/layout.tsx` — fetches `GET /notifications/unread-count`.

**Platform components reused:** `buttonVariants`, `Badge`, `TopBar`, `@munaxa/icons` `Bell`.
**New components:** none. **New tokens, colours, radii, shadows, font sizes:** none.

### 1.2 Nothing else

No other screen was modified. §4 explains why for each.

---

## 2. The endpoint decision, and the one it replaced

The reference shows counts on the rail rows too — Workflows 12, Tasks 8, Approvals 5 — and the
product *has* those figures. It was ranked the highest-value change in the audit. It is not shipped,
and the reason is measurement rather than preference.

The only endpoint carrying `pending` / `overdue` together is `GET /dashboard`, which costs roughly
**thirteen database round-trips across eight modules** (`document` 4, `workflow` 3, `retention` 2,
`storage` 2, `identity` 1, `organization` 1). The rail is in the layout, so paying that means paying
it on **every navigation in the product** to decorate a sidebar. That is the per-request fan-out
regression Phase 7.1C spent a whole phase removing.

`GET /notifications/unread-count` is the **only** count-shaped endpoint in the entire API, and its
own comment says why it exists: the question "is asked wherever a badge is — every page load — and
answering it by fetching a page of notifications would make a count cost a paginated read". One
query, built for this.

So the bell ships and the rail badges wait for a cheap endpoint. The smallest unblocking change is a
sibling count route on `approval-tasks`, mirroring the notification one — §5.3.

A failed count yields `null`, not `0`. Zero is an answer — "you are up to date" — and asserting it
because the API was unreachable tells somebody nothing is waiting for them when nobody knows.

---

## 3. What I built, looked at, and threw away

The reference shows the count **overlaid** on the bell's corner. I built that first.

The platform has no overlay-count primitive — `Badge` is an inline label, and `NavigationItem.badge`,
the only badge slot in the system, is documented as "trailing content". Reaching the overlay meant
pinning `Badge` with `absolute -end-1 -top-1 min-w-4 px-1 text-[10px] leading-4`.

Rendered and zoomed 6×, it was a tall pink rectangle floating beside the bell rather than a pill on
it. And the classes that produced it are exactly the "hardcode visual values to imitate the
screenshots" this phase forbids — a second design system in miniature, five utilities long.

The count now sits **beside** the bell, with `Badge` given no sizing overrides at all. This is a
visible departure from the reference and it is deliberate.

---

## 4. What was deliberately left unchanged

The audit's largest finding was negative: **the product is already correctly platform-composed.**
The shell, every list (`DataGrid` via `ResourceList`), the dashboard tiles (`StatCard`), the upload
(`Dropzone`/`Progress`) are all platform. `grep -rn "from 'lucide-react'"` returns **0** across
`apps/web/src` and `packages`. There was no local design system to remove.

| Surface | Decision |
| --- | --- |
| Document library | Untouched. Already `DataGrid` + `Toolbar` + `Pagination`. |
| Library file-type marks | **Audit finding corrected.** Written up as missing; it already exists as `FormatBadge` rendering `formatFor(mimeType).family`. Replacing a legible label with an icon in a cell whose width was already tuned in a real browser buys little and risks the legibility it was tuned for. |
| Dashboard status breakdown | Left as a definition list. A donut of the same real counts is defensible, but replacing working, explicitly-reasoned composition with a different valid one is what §16 warns against. |
| Document record | Untouched — Phase 7.2/7.3 grammar intact. |
| Search | Untouched. Platform `Tabs` for result types is a real opportunity, but whether the reference's tab dimensions map onto this API's facets is unverified, and guessing would have been inventing. |
| Upload modal | Untouched. Already correctly composed; the remaining gain is proportion, which I did not reach. |

---

## 5. Platform gaps and refusals

### 5.1 Platform gap — no overlay-count primitive

Every product with a notification bell needs a count on a glyph. Smallest addition: an `Indicator`
(or `Badge` with an `overlay` prop) owning the placement, size and the 99+ cap. Until then any
product reaching for it writes the same five arbitrary utilities. §3.

### 5.2 Platform gap — `SidebarNav` group-heading contrast (re-raised from Phase 7.1, still open)

Headings are styled `text-muted-foreground/70` at `text-[10px]` — **2.78:1** on the Docs light
surface against the 4.5:1 AA requires, so the product's four section headings are switched off. The
reference shows a visible "ADMINISTRATION" heading, so the visual direction is unreachable until
this is fixed upstream. Smallest fix: drop the `/70`, or lift the muted token on the Docs theme.

### 5.3 Backend gap — no cheap count endpoint for approval work

Blocks the rail badges (§2). Precedent exists: `GET /notifications/unread-count`.

### 5.4 Refused — storage quota bar

`storageTileSchema` returns `blobCount`, `storedBytes`, `referencedBytes`, `unreferencedBlobs`, and
its own comment states there is deliberately **no quota**. The reference's "128.45 GB / 500 GB ·
25.69%" needs a denominator that does not exist.

### 5.5 Refused — KPI deltas

`StatCard.delta` is well designed and even models `goodWhen`, so a rising "Overdue" would correctly
read as bad. But `CountTile` carries `state` and `count` only; no period-on-period figure exists
anywhere. Fabricating "+12.5% vs last month" on a compliance dashboard is the clearest available
violation of "do not fabricate metrics".

### 5.6 Refused — Entity / Branch switcher

Entities and branches exist as administered records, but nothing carries a session-scoped active
entity; the tenant boundary here is the database (ADR-0015). A header switcher would change what
every query returns — a product capability, not a visual treatment.

### 5.7 Refused — "Expiring Soon" tile

Not among the seven counts `userDashboardSchema` exposes. Computable from the Phase 6.1 expiry
domain, but exposing it is an API change.

### 5.8 Defect found, not fixed — the account chip shows UUIDs

`displayName={me.userId}` and `description={me.tenantId}` are raw UUIDs where the reference shows
"Ahmed Al-Haj / System Administrator". `/auth/me` returns `userId`, `tenantId`, `roles`,
`permissions` — **no display name and no email**, so the name cannot be shown without an API change.

`roles` *is* on the payload, so replacing the tenant UUID with the caller's role would be a real
improvement from real data. I did not make that change: it alters what information the chip conveys,
which is a product decision rather than a visual one. Flagged for a decision.

---

## 6. Verification

| Gate | Result |
| --- | --- |
| `pnpm format:check` | pass |
| `pnpm lint` | pass — 13/13 |
| `pnpm typecheck` | pass — 13/13 |
| `pnpm test` | pass — 13/13 |
| `pnpm verify:styles` | pass — 10/10 |
| `pnpm test:visual` | 88 pass; 10 fail — **all ten are the known Arabic-font surfaces**, unrelated to this phase |
| Responsive suite | 24/24 |
| axe (shell) | pass — `workspace-shell.spec.tsx` 14/14 including `has no axe violations` |

**Tests added** (`workspace-shell.spec.tsx`, 4):
speaks the unread count rather than only drawing it · draws no badge when there is nothing unread ·
draws no badge when the count could not be established · caps the badge rather than widening the top
bar.

The first two initially failed for a real reason: the rail also carries a "Notifications" link, so
querying by that name alone matched two elements. Fixed by asserting on the *absence of an unread
clause* rather than the bare name.

**Baselines added:** `top-bar-bell-light.png`, `top-bar-bell-dark.png`. The whole shell rather than
the bell alone, because the point is placement — collision with the theme toggle, clipping at the
bar's edge, and which side the badge lands on when direction flips. **Both were inspected by eye at
1×, 2× and 6×**, which is how the overlay version was caught. No existing baseline changed.

### What was not verified

- **The running application was not driven in Chromium.** Verification is the static-render browser
  harness plus the unit suites. §15 Step 5 asks for the real app; I did not get there.
- **The six-width responsive sweep in §10 was not performed for this change.** The existing
  responsive suite covers three widths and passes; 1440/1024/640 were not inspected for the bell.
- **RTL was not visually confirmed for the badge.** The classes are logical (`gap`, no physical
  direction), and the `-end-1` that would have mattered is gone with the overlay, but no Arabic
  baseline covers the top bar.

---

## 7. Acceptance criteria — honest status

Met: audit completed · Phase 7.x work preserved · platform tokens/components used · no
product-specific design system · no business logic, API, schema or permission change · platform gaps
documented rather than worked around · gates green (bar the pre-existing Arabic-font failures) ·
report written · index updated · tree clean · pushed · no PR opened.

**Not met:** priority screens *materially* improved — one affordance was added to the shell; the
dashboard, library, search, record and upload screens are unchanged. Dashboard hierarchy, library
density, search cohesion and upload polish are all still open.

Per §20, this phase is **not COMPLETE**. It is an audit plus one shipped change, with the reasons
each remaining item was blocked, refused or deferred recorded above.
