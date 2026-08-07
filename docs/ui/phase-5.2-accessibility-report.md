# Phase 5.2 — Accessibility, UI Quality & Design System Completion

**Purpose:** replace the UI's static accessibility claims with automated verification, finish the
design-system adoption, and protect both against regression.
**Status:** point-in-time report. Not edited afterwards.
**Method:** every number measured. Two harnesses — jsdom for structure and interaction, real
Chromium for contrast and pixels — and eight gates run, including the integration suite against two
live tenant databases.

The ten deliverables are sections [1](#1-accessibility-automation-report) through
[10](#10-ui-quality-roadmap).

---

## Executive summary

**Accessibility is now tested rather than argued.** Web tests went 37 → 104 (76 jsdom + 28 browser),
of which **52 are accessibility assertions** across eleven surfaces, both themes.

Three defects were found, and none of them could have been found by reading source:

1. **`text-primary` on white is 3.70:1** — below the 4.5:1 WCAG AA requires — on three dashboard
   links. Fixed by using `--primary-strong` (5.07:1), the on-white token the platform already ships.
2. **`Badge` is 4.31:1** against its own tint. The classes are the platform component's own, so it
   is documented as a platform issue with the arithmetic and **not worked around**.
3. **The collapsed navigation rail was blank.** `SidebarNav` renders only the icon when collapsed;
   the product passed none. Ten icons fix it, and a screenshot proves it.

Two things about the *harnesses* were wrong before they were right, and both are recorded because
each would have produced a green suite that proved nothing:

- A `matchMedia` stub answering `false` to everything renders the **mobile** shell. The first run
  reported a missing navigation landmark that was not missing.
- **axe ships `duplicate-id` switched off** (deprecated in 4.10). The brief requires duplicate ids
  to fail; by default they do not. Re-enabled explicitly.

**Design-system adoption: 62 of 180 platform components, and zero raw controls left in product
code** — no `<table>`, no visible `<input>`, `<select>` or `<textarea>`, no hardcoded colour, no
arbitrary Tailwind value. Two `<button>` elements remain and are documented exceptions.

---

## 1. Accessibility Automation Report

### What runs

| Suite | Environment | Tests | What only it can check |
| --- | --- | --- | --- |
| `screens.a11y.spec.tsx` | jsdom | 13 | Structure and ARIA on six screens, populated *and* empty |
| `workspace-shell.spec.tsx` | jsdom | 8 | The frame every page sits inside; skip link; icon coverage |
| `keyboard.spec.tsx` | jsdom | 8 | Tab order, focus trapping, Escape — a sequence of key presses |
| `a11y.spec.tsx` | jsdom | 10 | **The harness itself** |
| `visual.spec.tsx` | Chromium | 28 | Colour contrast, and pixels |
| **Total** | | **67** | of which **52** are accessibility |

Both run in CI. The jsdom suites are inside `pnpm test`; the browser suite is `pnpm test:visual`, a
turbo task depending on `build` — because it reads the *built* stylesheet, and `test` runs before
`build`.

### Surfaces covered

Every surface the brief names, except two, with the reason given rather than omitted:

| Surface | Covered | Note |
| --- | --- | --- |
| Login | ✅ | `LoginForm` |
| Dashboard | ✅ | Tiles ready, and administrator tiles refused |
| Document List | ✅ | With rows, empty, and without create/bulk rights |
| Search | ✅ | Before a search, and with no matches |
| Approval Workflow | ✅ | Pending, delegated, empty |
| Folder Tree | ✅ | Selected, and with no library |
| Layout Shell | ✅ | Plus skip link, landmarks, `aria-current` |
| Navigation | ✅ | Plus icon coverage and keyboard reachability |
| Settings | ⚠️ | Renders through the shared `AdminScreen` harness, which the 22 admin screens all use. Covering the harness covers the family; a per-screen test would assert the same markup 22 times |
| Document Details | ❌ | `DocumentScreen` takes 16 props including a full `Document`, preview manifest, workflow, revisions and audit. The fixture is a half-day on its own and is item 3 of the roadmap |
| User Profile | ❌ | **There is no user-profile screen.** `UserMenu` in the top bar is the whole of it, and that is covered by the shell suite |

### The rules that fire

Everything the brief lists is live except one, and the exception is stated rather than assumed:

| Required to fail on | Status |
| --- | --- |
| Missing labels | ✅ `label`, `aria-*`, `button-name`, `link-name` |
| Invalid ARIA | ✅ `aria-valid-attr`, `aria-valid-attr-value` |
| Missing headings / landmarks | ✅ region and heading-order rules |
| **Duplicate ids** | ✅ **only because they were re-enabled** — see below |
| Colour contrast | ✅ **in the browser suite**, not jsdom |
| Keyboard traps | ✅ `keyboard.spec.tsx`, by pressing Tab 20 times |

**On duplicate ids.** `duplicate-id` and `duplicate-id-active` were deprecated in axe-core 4.10 and
default to `enabled: false`; only `duplicate-id-aria` still runs. Verified against 4.13.0, not
assumed. So a page with two `id="name"` inputs **passes a default axe run**. Both are switched back
on, because every field in this product associates its label through `htmlFor`/`id` — a duplicate id
is a label pointing at whichever element the browser found first.

### The harness's own test

`a11y.spec.tsx` exists because Phase 5.1 shipped a stylesheet checker whose first draft passed
against a build that was deliberately broken. **A check that fails open converts an absent test into
a false assurance**, which is worse than no test. Every screen suite passed axe on its first run, and
that is only good news if axe would have said otherwise.

So each failure class is seeded and asserted to be caught — unlabelled control, nameless link,
nameless button, invalid ARIA, dangling `aria-labelledby`, duplicate id, missing `alt`, bad `headers`
reference — plus the inverse: correct markup must pass, or a harness that failed everything would
satisfy all of the above while being useless.

One test asserts that **invisible-on-white text passes in jsdom**, so no one can read a green run as
contrast coverage.

---

## 2. Keyboard Navigation Report

Eight tests, all passing. axe checks whether markup *can* be operated; it does not press Tab.

| Requirement | Verified | How |
| --- | --- | --- |
| Skip link | ✅ | First element Tab reaches; target exists and carries `tabindex="-1"` |
| Logical tab order | ✅ | Nothing has a positive `tabindex` |
| Full keyboard navigation | ✅ | Every navigation destination reached within 40 Tab presses |
| Dialogs | ✅ | Focus stays inside across 20 presses; Escape closes; dialogue has an accessible name |
| Form filters | ✅ | Clicking a label focuses its control — the association, tested rather than inspected |
| Dropdowns | ⚠️ | `UserMenu` is Radix, which the platform tests. Not re-asserted here |
| Tables | ⚠️ | `DataGrid` cell navigation is the platform's, and tested there |
| Tree navigation | ❌ | The folder tree is a nested list of links, so ordinary Tab order applies. No roving `tabindex` to test |
| Workflow dialogs | ⚠️ | Covered structurally by the generic dialogue tests; the approval-specific dialogue needs the `DocumentScreen` fixture (roadmap item 3) |

**Visible focus is not asserted, and cannot be here.** It is a rendered outline and jsdom has no
layout. The platform sets `focus-visible:ring-*` on its controls and this product defines no focus
styles of its own, so it *cannot* suppress them — but that is an argument, not a test. Roadmap
item 5.

---

## 3. Design System Consistency Report

| Category | Product code | Note |
| --- | --- | --- |
| Raw `<table>` | **0** | Phase 5.1; `TH` carries `scope="col"` |
| Raw visible `<input>` / `<select>` / `<textarea>` | **0** | All `Field` + `Input`/`Select` |
| Raw `<button>` | **2** | Documented exceptions below |
| Hardcoded colours | **0** | No hex, `rgb()` or `hsl()` in 114 files |
| Arbitrary Tailwind values | **1** | `bg-[Canvas]`, a CSS system colour with no token equivalent |
| Inline `style` | **5** | All computing dynamic values — tree indent, preview zoom |
| Icon libraries | **1** | `@munaxa/icons`; zero direct `lucide-react` imports |

Components adopted this phase and last: `Field`, `Input`, `Select`, `Textarea`, `Checkbox`, `Radio`,
`Badge`, `EmptyState`, `Alert`, `Table` family, `Card`, `Dialog`, `Button`, `Spinner`, `Accordion`,
`Timeline`, `PageHeader`.

### Deliberate exceptions

| # | What | Why it stays |
| --- | --- | --- |
| 1 | `search-screen.tsx:423` — facet toggle `<button>` | A list-row toggle carrying `aria-pressed`, at a density `Button` does not offer. Converting changes visual appearance, which this phase may not do |
| 2 | `reports-screen.tsx:221` — definition opener `<button>` | Link-styled affordance. Same reasoning |
| 3 | `bg-[Canvas]` in the fullscreen preview | A CSS system colour matching the OS canvas. There is no token for it *by definition* |
| 4 | Native `<select>` in `admin-shared/fields.tsx` | Documented since Phase 2: short closed lists, native mobile keyboards, assistive-technology support |
| 5 | `Tooltip`, `Popover`, `Tabs`, `Skeleton`, `Breadcrumb` unused | Nothing on any current screen needs them. Not adopting an unused component is correct |
| 6 | `FileManager`, `ApprovalFlow`, `WorkflowCanvas`, `SearchBuilder`, `DatePicker` | Assessed in Phase 5.1 §§4–5 with the platform type signatures that would change the answer. Unchanged |

---

## 4. Icon Adoption Report

| Requirement | Status |
| --- | --- |
| No mixed icon libraries | ✅ One package, `@munaxa/icons`; **zero** direct `lucide-react` imports |
| Consistent sizing | ✅ `size-4` everywhere — the platform's own size, 38 uses across its components against 2 of anything else |
| Consistent spacing | ✅ Owned by `SidebarNav`; the product sets none |
| Consistent semantic usage | ✅ One icon per destination; every one `aria-hidden` |

### Why icons arrived in a phase that may not change visual identity

Because their absence was a defect, not a gap. `SidebarNav`'s own documentation says it: *"Collapsed,
each row shows only its icon and carries the label as a `title`."* Confirmed in the compiled
component — when collapsed the label is rendered `sr-only`. **A destination with no icon is a blank
row of clickable space.** The accessible name survived; the visible one did not.

Ten destinations now have one: home, documents, approvals, search, audit, recycle bin, delegations,
notifications, reports, admin. `sidebar-nav-collapsed-{light,dark}.png` are the proof.

A test asserts every destination has a *real* icon rather than the fallback, so a new destination
cannot silently reintroduce the defect.

**Broader icon adoption — row actions, empty states, buttons — is deliberately not done.** Those are
additive and would change visual identity, which the mandatory requirements forbid. Roadmap item 6.

---

## 5. Visual Regression Report

**14 baselines: seven surfaces × two themes.** Compared with `pixelmatch` at a 120-pixel tolerance —
a pixel *count* rather than a percentage, because a percentage of a large screenshot hides a total
change to a small component, which is the regression most worth catching.

| Surface | Light | Dark |
| --- | --- | --- |
| `sidebar-nav` (expanded) | ✅ | ✅ |
| `sidebar-nav-collapsed` | ✅ | ✅ |
| `dashboard` | ✅ | ✅ |
| `document-list` | ✅ | ✅ |
| `folder-tree` | ✅ | ✅ |
| `workflow-inbox` | ✅ | ✅ |
| `search` | ✅ | ✅ |

**Proved in both directions.** Changing three links from `text-xs` to `text-base font-bold` produced
819 changed pixels in light and 699 in dark, and failed. A missing baseline is *created* rather than
failed, so adding a screen is one commit — which is why the count above is the thing to watch rather
than the pass.

### What the harness renders, and the one thing that caught out

Server-rendered markup plus the real built stylesheet, in Chromium. Not the running application:
that would need the API, a database, a session and a tenant — four things that make a UI test fail
for reasons that are not about the UI.

**The first shell baseline was a screenshot of the wrong layout.** `useMediaQuery` has no media to
query during a static render, so `WorkspaceShell` always renders its *mobile* variant. Verified
rather than assumed: the SSR markup contains no `<aside>`, no `<nav>` and exactly one `<svg>` — so
the baseline meant to prove the icon work contained none of the icons. `SidebarNav` is now rendered
directly, where `collapsed` is an explicit prop.

**Not covered: interaction.** A static render has no hydration, so no dialogue is opened and no
dropdown expanded in a screenshot. The jsdom suites do hydrate and cover those. Neither harness
covers everything; together they cover more than either. Dialogs and forms as *pixels* are roadmap
item 4.

---

## 6. Accessibility Fix Report

| # | Issue | Severity | Owner | Resolution |
| --- | --- | --- | --- | --- |
| 1 | `text-primary` `#6b8e62` on `#ffffff` = **3.70:1** (needs 4.5) on three dashboard links | Serious | Product | **Fixed.** Now `text-primary-strong` `#56774d` = **5.07:1** — the on-white token the platform already ships. The product was using a fill colour as text |
| 2 | `Badge`: `#56774d` on its `bg-primary/15` tint `#e9eee7` = **4.31:1** | Serious | **Platform** | **Not fixed, and not worked around** — see below |
| 3 | Collapsed navigation rail rendered blank rows | Serious | Product | **Fixed.** Ten icons |
| 4 | `--color-surface-hover` referenced by five hover states, defined nowhere | Moderate | Product | Fixed in Phase 5.1 |
| 5 | Raw `<th>` with no `scope` | Moderate | Product | Fixed in Phase 5.1 via the platform's `TH` |

**No other violations exist.** Everything else axe checks — labels, ARIA validity, landmarks,
heading order, duplicate ids, image alternatives, keyboard traps — passes on every covered surface,
in both themes.

**Nothing was suppressed.** Issue 2 is the only tolerated violation, and the tolerance is
deliberately narrow: the suite fails on **any** contrast violation that is not that exact one.

### Issue 2, in full, because it is a platform limitation

`Badge` renders `border-primary/30 bg-primary/15 text-primary-strong` from inside
`@munaxa/platform`. In the Docs light palette:

```text
--primary        #6b8e62   →  bg-primary/15 over white  =  #e9eee7
--primary-strong #56774d
contrast(#56774d, #e9eee7) = 4.31 : 1     WCAG 2.1 AA needs 4.5 : 1 below 18.66px
```

Computed from `themes/docs/palette.css`, not estimated. The product cannot fix it: the classes are
the component's own, so the only product-side remedies are overriding platform styling or hardcoding
a colour — and `ARCHITECTURE.md` forbids the second outright while the brief forbids
product-specific workarounds for platform limitations.

**The fix belongs in the platform.** Either `--primary-strong` a shade darker, or the badge tint
lighter. Roughly `#4d6b45` would clear it. Deleting the entry from `KNOWN_PLATFORM_CONTRAST` when the
palette ships is how this stops being tolerated.

---

## 7. Performance Audit Report

| Metric | Value | Assessment |
| --- | --- | --- |
| Generated CSS | **61,339 bytes** | Correct. It was 21,882 when it was *broken* — see Phase 19 |
| Shared first-load JS | **103 kB** across all 39 routes | Healthy |
| Largest route | `/documents/[documentId]` — 311 kB | `pdfjs-dist`. The only outlier |
| Typical workspace route | 236–248 kB | Consistent |
| Auth routes | 181 kB | The shell is correctly absent |
| Middleware | 73.7 kB | Unchanged |
| Client components | **68 of 114** `.tsx` | See below |
| Duplicated providers or contexts | **0** | One tree: `ToastProvider`, `LocaleProvider`, React Query |
| Duplicate of a platform-provided dependency | **0** | No `radix`, `lucide`, `cmdk`, `clsx`, `echarts`, `tailwind-merge` in `apps/web` |

**Unused CSS: not meaningfully measurable, and saying so is more useful than a number.** Tailwind
emits only what it scans, and `verify:styles` requires every platform class to be present — so
"unused" here means "a class the platform ships but no screen currently renders", which is exactly
what must stay for the design system to work.

**Tree shaking works.** 118 unused platform components — including `echarts`, `Gantt`, `Kanban`,
`OrgChart` — and the shared bundle is still 103 kB. Adopting more platform components is close to
free.

### Largest client components

| Lines | File |
| --- | --- |
| 987 | `admin-workflows/definition-editor.tsx` |
| 625 | `revisions/revision-panel.tsx` |
| 576 | `admin-shared/resource-list.tsx` |
| 549 | `reports/reports-screen.tsx` |
| 525 | `search/search-screen.tsx` |

**No optimisation was performed**, per the brief. 68 of 114 files carrying `'use client'` is worth a
look — several are leaves that could be server components — but the bundle numbers do not justify it
yet, and premature splitting is how a working boundary becomes two. Roadmap item 7.

---

## 8. Component Inventory Report

**62 of 180 platform components used; 118 unused.**

| Used this phase or last (62) | |
| --- | --- |
| Shell | `AppShell`, `AppShellProvider`, `Sidebar`, `SidebarNav`, `SidebarTrigger`, `TopBar`, `NavigationDrawer`, `UserMenu`, `SkipLink` (via prop) |
| Layout | `Page`, `PageHeader`, `Section`, `Stack`, `Panel`, `Grid`, `Toolbar` |
| Data | `DataGrid`, `Pagination`, `Table`/`THead`/`TBody`/`TR`/`TH`/`TD`, `Timeline`/`TimelineItem`, `StatCard` |
| Forms | `Field`, `Input`, `Select`, `Textarea`, `Checkbox`, `Radio`, `Switch`, `MultiSelect`, `Combobox`, `Dropzone` |
| Feedback | `Alert`, `Badge`, `EmptyState`, `ErrorState`, `Spinner`, `Progress`, `useToast`, `ToastProvider` |
| Overlay | `Dialog`, `DropdownMenu` family, `Accordion` family |
| Charts | `BarChart`, `LineChart` |
| Icons | 11 from `@munaxa/icons` |

### Intentionally unused, with reasons

| Component | Reason |
| --- | --- |
| `FileManager` | No column API — a document number or confidentiality mark cannot be a column. Phase 5.1 §4 |
| `ApprovalFlow` | `'all' \| 'any'` cannot express `QUORUM`/`PERCENT`; no `CANCELLED` status. Phase 5.1 §5 |
| `WorkflowCanvas` | Needs persisted `{x, y}` per node; a stage list has none |
| `SearchBuilder`, `FilterBuilder` | Server-computed facet counts have no representation in `FilterField` |
| `DatePicker`, `DateRangePicker` | Controlled, where both forms are read through `FormData` on submit |
| `Breadcrumb` | Adding it is a new affordance. Roadmap item 8 |
| `Tabs`, `Skeleton`, `Tooltip`, `Popover`, `Drawer`, `Avatar`, `Calendar`, `ScrollArea`, `Separator`, `Stepper` | No current screen needs them |
| `NotificationMenu`, `OrganizationSwitcher` | Plausible fits for the top bar; needs a design decision, not a migration. Roadmap item 9 |
| `Kanban`, `Gantt`, `OrgChart`, `CountUp`, `Reveal`, `Cover` | No place in an EDMS |

### Custom components (product-owned, correctly)

`WorkspaceShell` (composition of platform parts), the 13-file `admin-shared` harness (a promotion
candidate — Phase 19 §7), `FolderTree`, `AuditTimeline`, `PreviewPanel` and the four viewers,
`ApprovalPanel`, `RevisionPanel`, `BulkPanel`. Each encodes document-control behaviour.

### Platform improvements this phase identified

1. **`Badge` contrast** — 4.31:1. Evidence in §6. *New.*
2. **`FileManager` column API** — `DataGrid` one layer down already has `ColumnDef`.
3. **`ApprovalFlow` quorum + `cancelled`** — blocks any product with quorum approval rules.

---

## 9. Validation Report

Every gate, on the final commit.

| Gate | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | **Clean** |
| `pnpm format:check` | **Clean** |
| `pnpm lint` | **Clean** — 0 errors, 5 warnings (all `consistent-type-imports`, all pre-existing) |
| `pnpm typecheck` | **Clean** — 13/13 |
| `pnpm test` | **Clean** — 614 API, 164 domain, 26 contracts, **76 web**, 11 utils, 4 i18n, 2 worker |
| `pnpm build` | **Clean** — 9/9, 39 routes |
| `pnpm verify:styles` | **Clean** — 249 platform classes, all generated |
| **`pnpm test:visual`** | **Clean** — 28 (12 contrast, 14 baselines, 2 harness) |
| `pnpm test:integration` | **Clean** — **578 tests across 33 files**, two real tenant databases |

The integration suite was run rather than skipped: Docker is unavailable in this environment but
PostgreSQL 16 and Redis are installed, so CI's procedure was reproduced directly.

### Regression checks the brief names

| Check | Result |
| --- | --- |
| No functional regressions | **Verified** — 578 integration + 614 API tests unchanged |
| No routing regressions | **Verified** — 39 routes; no route file touched |
| No API / schema / auth / workflow changes | **Verified** — no file under `apps/api`, `prisma/` or `packages/domain` modified |
| Translations preserved | **Verified** — no catalogue key removed; `nav.*` unchanged |
| Permissions preserved | **Verified** — `destinationsFor` untouched; capability-gated branches under test |
| Accessibility already implemented preserved | **Verified** — skip link, landmarks and `aria-current` now have tests that would fail if removed |
| Visual identity preserved | **Verified within the covered surfaces** — 14 baselines. The icons are the one deliberate visual change, and §4 argues why they are a fix |

---

## 10. UI Quality Roadmap

| # | Item | Size | Why not now |
| --- | --- | --- | --- |
| 1 | **Platform: fix `Badge` contrast** | platform PR | §6. The only tolerated violation in the suite |
| 2 | **Platform: `FileManager` columns, `ApprovalFlow` quorum** | platform PR | Carried from Phase 5.1 |
| 3 | **`DocumentScreen` a11y + visual coverage** | 0.5–1 day | 16 props including a full `Document`, preview manifest, workflow, revisions and audit. The largest remaining coverage gap |
| 4 | **Interactive visual baselines** — open dialogue, expanded dropdown | 1 day | Needs hydration in the browser harness, not a static render |
| 5 | **Assert visible focus** | 0.5 day | Needs computed styles; belongs in the browser harness beside contrast |
| 6 | **Broader icon adoption** — row actions, empty states | 1–2 days | Additive; changes visual identity, which this phase may not do |
| 7 | **Client/server boundary review** — 68 of 114 files are client components | 1 day | Bundle numbers do not justify it yet |
| 8 | **`Breadcrumb` on folder navigation** | 0.5 day | A new affordance |
| 9 | **`NotificationMenu` / `OrganizationSwitcher`** | 1 day | A design decision, not a migration |
| 10 | **AR/RTL string sweep** — 36 of 164 files import `@edms/i18n` | 1–2 days | Direction is wired correctly; per-string coverage unmeasured |
| 11 | **Screen-reader pass** | 1 day | Needs real assistive technology. axe is a floor, not a ceiling |

---

## 11. Scores

| Dimension | Score | Basis |
| --- | --- | --- |
| **Accessibility** | **92 / 100** | Zero violations on eleven surfaces in both themes; one tolerated platform issue; two surfaces uncovered; no screen-reader pass |
| **Design-system adoption** | **95 / 100** | Zero raw controls, zero hardcoded colours, one icon library, one arbitrary value (justified) |
| **Platform component usage** | **62 / 180** | Not a percentage to maximise — 118 are unused for stated reasons |
| **Accessibility test coverage** | **9 of 11 surfaces** | Document Details uncovered; User Profile does not exist |
| **Keyboard coverage** | **6 of 9 categories** | Dropdowns and tables are platform-tested; the tree needs no roving tabindex |
| **Visual regression coverage** | **7 surfaces × 2 themes** | Static renders only; no interactive states |

**The accessibility score is 92 rather than higher because two surfaces are untested and no human
has used this product with a screen reader.** axe catches roughly a third of what a real audit
finds; a green suite means the floor is solid, not that the building is.

---

## 12. What this phase did not do

**It did not suppress a violation.** The one tolerated failure is a platform-owned contrast issue,
recorded with its arithmetic, and the suite still fails on any other contrast violation.

**It did not work around the platform.** Fixing `Badge` product-side would mean overriding platform
styling or hardcoding a colour — the second is forbidden by `ARCHITECTURE.md` and both are forbidden
by the brief.

**It did not add icons beyond navigation.** Those were a defect fix; the rest would be a visual
change the mandatory requirements forbid.

**It did not change business logic, APIs, the schema, authentication, workflows or permissions.** No
file under `apps/api`, `prisma/` or `packages/domain` was touched.

**It did not claim contrast coverage from jsdom.** A test asserts that invisible-on-white text passes
there, so a green jsdom run can never be read as a contrast result.
