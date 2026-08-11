# Phase 8 — Enterprise Platform Consistency & Cross-Screen Audit

## 0. Status

**COMPLETE — audit only.** No product code changed. One test file was added
(`apps/web/src/test/e2e/consistency.e2e.spec.ts`), which is what turned twelve source readings into
twelve measurements.

Every statement below that names a number was measured in the running application against real
PostgreSQL, Redis, the API artefact, the production web build and a real login. Where a measurement
was not comparable, it says so rather than being reported as a finding.

## 1. Route inventory

**37 authenticated routes** under `(workspace)`, read from the route tree rather than assumed, plus
three unauthenticated ones (`/login`, `/mfa`, and the error/not-found boundaries).

| Domain | Routes | Page frame |
| --- | --- | --- |
| Dashboard | `/` | `Page` + `PageHeader` (direct) |
| Documents / Library | `/documents`, `/documents/[id]`, `/documents/[id]/permissions`, `/documents/recent` | `WorkspacePage` ×4 |
| Search | `/search` | `WorkspacePage` |
| Approvals | `/approvals` | `AdminScreen` |
| Delegations | `/delegations` | `WorkspacePage` |
| Notifications | `/notifications` | `WorkspacePage` |
| Recycle bin | `/recycle-bin` | `WorkspacePage` |
| Reports | `/reports` | `WorkspacePage` |
| Audit | `/audit` | **`PageHeader` with no `Page`** |
| Administration | `/admin` + 24 children | `AdminScreen` ×24; `/admin` and `/admin/workflows/[id]` use `Page` directly |

**Frame adoption: 34 of 37 routes use `Page` + `PageHeader`** through one of the two shared frames.
That is the headline, and it is good news: the grammar is already the norm, not the exception.

Screens are reached through two frames, and both are the same composition:

- `WorkspacePage` — `Page gap=6` → `PageHeader` (+ optional `Breadcrumb` in `above`) → `Stack gap=4`.
- `AdminScreen` — `Page gap=6` → `PageHeader` → `Stack gap=4`. No breadcrumb; administration has a
  section rail instead.

`/admin/*` additionally wraps in `SidebarLayout width="md" collapseBelow="lg"` with
`AdminSectionNav` — a real, intentional domain difference (**class C**), not an inconsistency.

## 2. Platform primitive inventory

Read from the installed typings and implementation in
`node_modules/@munaxa/platform/dist`, not from general UI knowledge.

| Primitive | Role | API actually offered | Reference usage | Misuse found |
| --- | --- | --- | --- | --- |
| `Page` | page column: gutters, max width, vertical rhythm | `gap` | every reference screen | absent on `/audit` (§6.1) |
| `PageHeader` | `<h1>`, description, actions, `above` slot | `title` `description` `actions` `above` `level` `align` | all four | `actions` unused on 5 screens (§6.4) |
| `Section` | labelled `role="region"`, `<h2 font-display text-lg font-semibold>` | `title` `description` `actions` `gap` | Dashboard, Search | 3 features only |
| `Panel` | bordered region, `<h2 font-display text-sm font-semibold>`, header/footer/scrollBody | `title` `actions` `footer` `scrollBody` + Surface | Search facets, Document Record | 11 of 21 features |
| `Toolbar` | labelled control row; deliberately **not** `role="toolbar"` | `actions` `label` `sticky` | Library | — |
| `ResourceList` | product wrapper over the list grammar | product-owned (`admin-shared`) | 24 admin screens | — |
| `DataGrid` | column-driven table | platform | 3 uses | — |
| `Stack` / `Inline` / `Cluster` | one-dimensional flow; horizontal follows `dir` | `direction` `gap` `align` `justify` `wrap` `as` | everywhere | — |
| `Grid` | `cols: Responsive<1\|2\|3\|4\|5\|6\|12>` | | Dashboard | — |
| `Surface` / `Card` | elevation and border | | everywhere | — |
| `EmptyState` / `ErrorState` | the two "nothing here" shapes | `title` `description` | 15 features | rendered *outside* the page frame on `/documents/recent` (§6.1) |
| `SidebarNav` | rail; items `text-muted-foreground`, group titles `text-muted-foreground/70` | `groups` `label` `renderLink` `collapsed` `className` | shell + admin section nav | group-title contrast (§6.3) |
| `DocumentStatusBadge` / `FormatBadge` | product status vocabulary | product-owned | all four | no screen rolls its own |

**Loading and error states are global, not per route.** `app/loading.tsx`, `app/error.tsx` and
`app/not-found.tsx` exist; **no route defines its own `loading.tsx` or `error.tsx`**. Consistent by
construction — and a finding in its own right for any screen whose first paint is expensive
(**class F**, §9).

## 3. The reference grammar, as the four screens actually implement it

1. **One frame per screen.** `Page` supplies gutters and rhythm; nothing renders a heading outside it.
2. **One `<h1>`, from `PageHeader`.** Measured: exactly one on all four, and on 11 of the 12 other
   screens.
3. **The primary action lives in `PageHeader.actions`.** Phase 7.4 promoted Library's there
   deliberately.
4. **Sections are `Section`; bordered sub-regions are `Panel`.** Both label their region; neither is
   hand-rolled. Phase 7.7B converted the last screen-level exception.
5. **Two-line records.** Title + status on one line; type · number · revision · date, quiet, on a
   second (Phase 7.6B, Phase 7.7B).
6. **Status is a badge with an icon**, never colour alone.
7. **Quiet text is `text-muted-foreground`**, not an opacity fade.
8. **No colour is named** — enforced since Phase 7.9 by `no-raw-colours.spec.ts`.
9. **Empty is `EmptyState` inside the frame.**
10. **The URL is the state** for lists and search.

## 4. Audit matrix — measured, 1280 then resized to 390, one session

| Screen | `<h1>` | raw keys | 1280 overflow | 390 overflow | axe (serious/critical) |
| --- | --- | --- | --- | --- | --- |
| `/approvals` | 1 "Approvals" | none | no | no | **0** |
| `/audit` | 1 "Audit trail" | none | no | no | **0** |
| `/delegations` | 1 "Delegations" | none | no | **YES** | not sampled |
| `/notifications` | 1 "Notifications" | none | no | no | not sampled |
| `/recycle-bin` | 1 "Recycle bin" | none | no | no | not sampled |
| `/reports` | 1 "Reports" | none | no | no | **0** |
| `/documents/recent` | **0** | none | no | no | not sampled |
| `/admin` | 1 "Administration" | none | no | no | not sampled |
| `/admin/users` | 1 "Users" | none | no | no | **6 × color-contrast** |
| `/admin/document-types` | 1 "Document types" | none | no | no | not sampled |
| `/admin/libraries` | 1 "Document libraries" | none | no | no | not sampled |
| `/admin/settings` | 1 "Settings" | none¹ | no | no | not sampled |

¹ The first version of the detector reported six here. They were **false positives** — see §7.

Every one of the twelve rendered without an error boundary.

## 5. Classification key

**A** confirmed · **B** probable, needs evidence · **C** intentional domain difference ·
**D** platform limitation · **E** insufficient evidence · **F** product decision required

## 6. Confirmed findings

### 6.1 — `/documents/recent` loses its page frame when empty — **A, P0**

```
[grammar recent] {"h1":null,"h1Count":0,…}
```

`RecentScreen` returns a bare `EmptyState` **outside** `WorkspacePage` when `rows.length === 0`:

```tsx
if (rows.length === 0) {
  return <EmptyState title={…} description={…} />;   // no Page, no PageHeader, no breadcrumb
}
return <WorkspacePage title={…} breadcrumb={…}> … </WorkspacePage>;
```

A reader who has opened nothing gets a screen with **no accessible page title and no breadcrumb**,
and a screen reader has nothing to announce it by. P0 because it is an accessibility defect, not a
visual one — and it is invisible to anyone testing with data, which is why six phases of populated
verification missed it.

**Owner:** product (`recent-screen.tsx`). One-line shape change: move the guard inside the frame.
**Check for the same shape elsewhere** — this is the class of defect that repeats.

### 6.2 — `/delegations` overflows the viewport at 390px — **A, P2**

```
[grammar delegations] {"overflow1280":false,"overflow390":true,…}
```

The only horizontal overflow in twelve screens. Every other screen, including four with tables,
contains itself. **Not diagnosed further in this phase** — Phase 7.7A's discipline is to measure
computed widths, flex bases and bounding boxes *before* proposing a cause, and that measurement is
the first step of the fixing phase, not of the audit.

**Owner:** product (`delegations-screen.tsx`), pending that measurement.

### 6.3 — navigation group titles fail AA — **A, P1, PLATFORM**

axe reports **six serious `color-contrast` nodes on `/admin/users`** and none on `/audit`,
`/approvals` or `/reports`. Measured rather than counted:

```
text        "Organisation" / "People and access" / "Control"
class       px-3 pb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70
color       oklab(0.544376 -0.00296196 -0.034888 / 0.7)      ← #667085 at 70% alpha
background  rgb(255, 255, 255)
```

`#667085` at 70% over white composites to `rgb(148, 155, 170)` — **2.79:1**, against 4.5:1 for
10px text. The class is `SidebarNav`'s own group-title style, from inside `@munaxa/platform`, with
no prop by which a host can change it.

**Why only `/admin/users`:** the *admin section nav* renders six titled groups; the main rail's
groups render without visible titles. So the same component fails only where titles are shown —
which is also why Phase 7.9's rail measurement found `headingWorst: null` and reported nothing.

**This locates the original pre-7.8 "≈2.78:1" figure.** That number is almost exactly 2.79, and it
was never reproducible for the *rail items* — Phase 7.9 was right to retract that claim (items
measure 4.97:1 light and 6.89:1 dark). It appears to have been the **group titles** all along,
attributed to the wrong element. Both corrections stand: the item finding was wrong; a real
sub-AA number exists one element away.

**Owner:** `@munaxa/platform` → `ui/shell/navigation.js`. `text-muted-foreground/70` is a fade *of*
a token; the fix is to drop the fade or introduce a dedicated group-title token. A host-side
workaround would mean overriding a shared component's styling, which the architecture forbids.

**Affected:** every product using the shell, wherever a navigation group carries a title.

### 6.4 — the primary action is not in the page header on 5 screens — **A, P1**

`PageHeader.actions` is passed by **zero** of `/reports`, `/notifications`, `/recycle-bin`,
`/delegations`, `/audit` — while each renders between 1 and 6 buttons in its body. Library's action
was deliberately promoted to the header in Phase 7.4 and that is the reference.

Not every one of those buttons is a *primary* action, which is why this is a finding about
**placement of the primary one**, screen by screen, rather than a mechanical move.

**Owner:** product, five screens, one shape.

### 6.5 — `/audit` renders `PageHeader` without `Page` — **A, P3**

Source and measurement agree:

```tsx
return (<> <PageHeader title={…} description={…} /> <Card className="p-4"> … )
```

```
[grammar audit]     pageFrame {"paddingTop":"0px","maxWidth":"none"}
[grammar approvals] pageFrame {"paddingTop":"24px","maxWidth":"1280px"}
```

The audit trail is the one workspace screen with no `Page`, so it gets neither the gutter nor the
max width every other screen has. P3 rather than P2: it is legible and does not overflow, and the
difference is rhythm.

**Owner:** product (`audit-screen.tsx`). Wrap in `Page`, or adopt `WorkspacePage`.

### 6.6 — `Panel`/`Section` adoption is uneven — **A, P3**

`Panel` appears in 11 of 21 feature folders and `Section` in 3. Six admin feature folders use
neither: `admin-approval-routing`, `admin-identity`, `admin-integration`, `admin-libraries`,
`admin-organization`. Those are `ResourceList` screens — a list under a header genuinely needs no
sub-region — so this is **mostly class C**, and only becomes a finding where a screen groups
unrelated content without labelling the groups. Per-screen work, low value, listed for completeness.

## 7. A finding the audit made about itself

The raw-key detector reported six leaks on `/admin/settings`:

```
security.password.minimumLength   security.session.idleTimeoutMinutes   notification.brand.name …
```

All six are **false positives**. `settings-screen.tsx` renders each tenant setting's own key as its
row title (`title={setting.key}`) — data an operator is meant to see, not a missing translation.
`translate()` returns the key itself on a miss, so a leak and a legitimate dotted identifier look
identical; the detector is now scoped to the catalogue's own top-level namespaces, derived from `en`
at runtime.

Whether an administrator should read `security.password.minimumLength` or a translated label is a
**product decision (class F)**, not a defect. The keys are the operator vocabulary that appears in
configuration documentation, and translating them would break that correspondence.

## 8. Priorities and recommended order

| # | Finding | Class | Priority | Screens | Owner |
| --- | --- | --- | --- | --- | --- |
| 1 | §6.1 recent loses its frame when empty | A | **P0** | 1 | product |
| 2 | §6.3 navigation group titles at 2.79:1 | A | **P1** | all admin screens, all products | **platform** |
| 3 | §6.4 primary action not in the header | A | **P1** | 5 | product |
| 4 | §6.2 delegations overflows at 390 | A | **P2** | 1 | product |
| 5 | §6.5 `/audit` has no `Page` | A | **P3** | 1 | product |
| 6 | §6.6 uneven `Panel`/`Section` | A/C | **P4** | ≤6 | product |
| 7 | Phase 7.9's ~30 `text-* opacity-70` sites | C | **P4** | 15 | product |

**Recommended order:** §6.1 first — it is the only accessibility defect and it is one line. Then
§6.3, because it is the only one a platform change fixes everywhere at once and it blocks nothing
else. Then §6.4 as a single pass across five screens, since doing them together is what makes the
placement consistent. §6.2 needs its own measurement pass. §6.5 and §6.6 are cleanup.

**Do not** bundle §6.1 with §6.4: the first is a correctness fix with a one-line test, the second is
five judgement calls about which button is primary.

## 9. Deferred, and why

- **Per-route `loading.tsx` / `error.tsx`** — none exist; the global boundaries serve every route.
  Consistent today. Whether an expensive screen deserves its own skeleton is **class F**.
- **Dark and RTL on the twelve non-reference screens** — not run. The shell's frame is verified in
  both on all four reference screens (Phase 7.8/7.9), and the twelve share that frame, but their
  *contents* were not driven in dark or Arabic. **Explicitly not claimed.**
- **axe on eight of the twelve** — sampled four. A full sweep costs a page load each and the API's
  rate limit is 300/60s; Phase 7.8 learned that the hard way.
- **Populated states** — the twelve were measured as the fixture leaves them. Several are
  legitimately empty (recycle bin, notifications), which is how §6.1 was found; others would need
  real production mechanisms to populate, as Phase 7.7B did for Search.

## 10. Platform limitations

| Item | Detail |
| --- | --- |
| `SidebarNav` group titles | `text-muted-foreground/70` → 2.79:1. Component-owned, no host prop. §6.3 |
| `Badge` | `text-primary-strong` on `bg-primary/15` → 4.31:1. Recorded since Phase 5.2, still open |
| `Input` | `w-full` makes `flex-basis: auto` unusable in a flex row (Phase 7.7A) |
| `AppShell` | paints no canvas by design; the host supplies it (resolved in Phase 7.8) |

## 11. Product decisions required

1. Should tenant setting keys be translated, or remain operator vocabulary? (§7)
2. Which button is *primary* on Reports, Notifications, Recycle bin, Delegations and Audit? (§6.4)
3. Do any screens warrant their own loading skeleton? (§9)

## 12. Environment limitations

- **MinIO** — 3 API integration tests (`presigned upload`) cannot run here: this container has a
  `docker` client but **no daemon**. That is an **ENVIRONMENT FAILURE**, not a product one; CI
  starts the object store. Confirmed by attempting to start it and reading the daemon error.
- **Arabic rendering** — the ten `ar-document-list-*` visual baselines differ by font metrics in
  this container. Recorded since Phase 7.1; both renders are valid Arabic.
- **Rate limiting** — 300 requests/60s is real and shapes how these suites navigate.
- **Disaster-recovery rehearsal** — `recovery.e2e.spec.ts` needs a second, empty PostgreSQL cluster
  (`DR_DEST_ADMIN_URL`) that this container does not provide, and refuses to run rather than restore
  over the source. **ENVIRONMENT**, not a product or test failure.

## 13. What was added

`apps/web/src/test/e2e/consistency.e2e.spec.ts` — 9 tests over 12 routes: no error boundary, exactly
one `<h1>`, no leaked catalogue key, no overflow at 1280 or 390, and axe on four routes with
contrast on.

It asserts what holds and **names what does not**: `RECORDED_FINDINGS` and `RECORDED_AXE` list §6.1,
§6.2 and §6.3 by screen, so everything else fails the build and a later phase deletes an entry when
it fixes the screen. One test asserts the recorded gap is **still there and still only there**, so
the exception cannot quietly widen.

## 14. Gates

Audit phase; the gates needed to establish it, plus the full set for the added test file.

| Gate | Result |
| --- | --- |
| `pnpm format:check` | PASS |
| `pnpm lint` | PASS |
| `pnpm typecheck` | PASS |
| `pnpm test` | PASS |
| `pnpm verify:styles` | PASS |
| `pnpm build` | PASS |
| **Consistency E2E** | **9/9** |
| Whole `e2e` project | **86 passed, 19 skipped** — shell 8/8, search 23/23, dashboard 19/19, signing and workflows unchanged |
| `recovery.e2e.spec.ts` | **19 skipped — ENVIRONMENT, not a failure.** The suite refuses to run without `DR_DEST_ADMIN_URL` naming an empty destination cluster: *"it needs somewhere else to restore to — and it must not guess"* (Phase 6.10). Refusing to guess is the suite behaving correctly |
| Integration | NOT RE-RUN — no API, schema or package code changed in this phase |
| Visual | NOT RE-RUN — no product code changed, no baseline could move |

## 15. Verdict

The application already follows its own grammar. **34 of 37 routes** use the shared page frame,
**11 of 12** audited screens have exactly one page heading, **11 of 12** contain themselves at
390px, no screen leaks a translation key, and three of four axe-sampled screens are clean.

What is left is a short, specific list: one accessibility defect, one platform token, one repeated
placement decision across five screens, and three pieces of cleanup. That is a roadmap, not a
refactor — which is what this phase was for.
