# Phase 7.5 — Visual Modernization Audit

**Status:** audit complete, implementation not started
**Scope:** visual composition only. No business logic, schema, API, permission or workflow change.
**Method:** repository inspection plus direct reading of the installed platform typings. No code changed to produce this document.

---

## 0. What the reference screenshots are, and what they are not

Four references were supplied: Dashboard, Add Document modal, Search, Document Library. They set the
quality bar. They are not a specification, and §16 of the brief says so explicitly.

Three of them show functionality this product does not have. Those are recorded in §7 as stop
conditions rather than quietly approximated, because the alternative — inventing a quota, a trend or
an entity switcher to make a screenshot match — is fabricating data on a control surface people make
decisions from.

---

## 1. Platform inventory — what is actually available

The five packages resolve as follows. `@munaxa/ui` is a buildless façade that re-exports
`@munaxa/platform` wholesale; there is no second implementation.

| Package | Role |
| --- | --- |
| `@munaxa/platform` | the implementation — components, tokens, typography, themes, icons, shell |
| `@munaxa/ui` | `export * from '@munaxa/platform'` — the name the app imports |
| `@munaxa/theme` | CSS themes: `base`, `corporate`, `school`, `work`, `docs` |
| `@munaxa/tokens` | typed tokens + `./css` primitives |
| `@munaxa/icons` | the shared icon set |

Component families on the public barrel:

| Family | Members |
| --- | --- |
| primitives | badge, button, tag |
| forms | autocomplete, checkbox, combobox, command, entity-picker, field, field-context, input, label, radio, switch, textarea, token-input |
| feedback | alert, dialog, drawer, empty-state, error-state, skeleton, spinner, toast, tooltip |
| navigation | breadcrumb, pagination, tabs |
| layout | card, separator |
| data-display | accordion, avatar, sparkline, table, timeline |
| overlays | context-menu, dropdown-menu, hover-card, popover |
| data-grid | data-grid, use-data-grid, use-virtual-rows |
| board | dnd, gantt, kanban, org-chart |
| files | dropzone, file-manager |
| flow | approval-flow, workflow |
| query | filter-builder, search-builder |
| date | calendar, date-picker, time-picker |
| patterns | dashboard, motion, progress, stat-card, stepper, token-reference |
| layouts | center, container, grid, page, panel, resizable, scales, split, stack, surface, workspace |
| shell | app-shell, app-shell-context, menus, navigation, navigation-drawer, sidebar, top-bar |
| charts | chart, theme, use-chart, wrappers |

---

## 2. What Phase 7.x already got right — do not redo

This is the largest finding of the audit, and it is a negative one: **the product is already
correctly platform-composed.** There is no local design system to remove.

- **The shell is fully platform.** `workspace-shell.tsx` composes `AppShellProvider`, `AppShell`,
  `Sidebar`, `TopBar`, `NavigationDrawer`, `SidebarNav`, `SidebarTrigger`, `UserMenu`, `useTheme`.
  Nothing re-implements a shell.
- **Tables are platform.** `admin-shared/resource-list.tsx` composes `DataGrid`, `Toolbar`,
  `Pagination`, `DropdownMenu`, with `ColumnDef`/`DataGridState`/`DataGridLabels` typing. Every
  administered list and the document library run through it. There is no replacement table.
- **The dashboard uses `StatCard`, `Grid`, `Section`, `Page`, `PageHeader`.**
- **Upload uses `Dropzone`, `Progress`, `formatFileSize`.**
- **Icons are clean.** `grep -rn "from 'lucide-react'"` across `apps/web/src` and `packages`
  returns **0**. §3.6 is already satisfied.
- **23 visual baselines exist**, covering sidebar, dashboard, document list, folder tree, workflow
  inbox, signatures, record, permissions, rail, search, three responsive widths, and five Arabic RTL
  surfaces.
- **Sectioned navigation, tile icons, `Panel` adoption and the section grammar** were established in
  Phases 7, 7.2 and 7.3 and are not revisited here.

Consequence: Phase 7.5 is **not** a cleanup phase. Almost nothing needs deleting. The gap is that a
substantial amount of platform capability is installed and unused.

---

## 3. The core finding — installed but unused platform capability

Usage counted across `apps/web/src/**/*.tsx`:

| Capability | Files using it | Reference screenshot wants it | Data exists? |
| --- | --- | --- | --- |
| `NavigationItem.badge` | **0** | yes — counts on nav rows | **yes** |
| `StatCard.delta` | **0** | yes — "+12.5% vs last month" | **no** |
| `StatCard.trend` (sparkline) | **0** | no | no |
| `Sparkline` | **0** | no | no |
| charts (donut) | 1 (test only) | yes — status donut | **yes** |
| `Tabs` | **0** | yes — result-type tabs in search | **yes** |
| `HoverCard` | **0** | no | — |
| `Popover` | **0** | no | — |
| `ContextMenu` | **0** | implied — row right-click | n/a |
| `Avatar` | **0** | yes — user chip | partial |
| `FilterBuilder` | **0** | no — facets are simpler | n/a |
| `SearchBuilder` | 1 | "Advanced Search" | partial |
| `FileManager` | **0** | no — DataGrid is right here | n/a |
| `ApprovalFlow` / `Workflow` | **0** | not shown | **yes** |
| `Command` | **0** | yes — `Ctrl+K` palette | n/a |

The three highest-value entries are `NavigationItem.badge`, file-type recognition (§4.2) and `Tabs`,
because all three are backed by data the product already returns.

---

## 4. Findings by surface

### 4.1 Navigation — badges are the single highest-value change

`NavigationItem` has carried `badge?: ReactNode` ("Trailing content: a count, a status dot, a 'new'
pill") since the platform shipped. The product passes `id`, `href`, `label`, `icon`, `active` and
never `badge`.

The reference shows exactly this: Workflows 12, Tasks 8, Approvals 5. And the product **already
fetches the numbers** — `UserDashboard` returns `pending`, `overdue` and `unreadNotifications`, all
rendered as dashboard tiles today.

Impact: high. Risk: low — one optional prop, no new request, no new permission.

Caveat to resolve at implementation: the counts are currently fetched by the dashboard page, not the
workspace layout. Surfacing them in the rail means the layout needs them. Whether that is one extra
call per navigation or a shared fetch is a real design question, and it must not become a per-request
fan-out regression of the kind Phase 7.1C spent a phase fixing.

### 4.2 Document library — file-type recognition

The reference distinguishes PDF / Word / Excel / PowerPoint / DWG with coloured type marks. The
product renders a uniform row.

`documentFileSchema` supplies `filename`, `mimeType` and `sizeBytes`. So this is real data, mapped to
platform icons and semantic tones — not decoration and not fabrication.

The library also already composes `DataGrid` correctly, so this is a cell renderer, not a table
change.

### 4.3 Document library — the contextual right panel

The reference shows a right rail: folder identity, details (parent, total documents, total folders,
total size, created by/date, permissions summary) and recent activity.

Partially backed. Folder identity and parent exist. Aggregate counts, total size and a per-folder
permission summary are **not** in the folder contract. Recording as partial: the identity block is
buildable, the statistics are not, and inventing them is forbidden.

### 4.4 Search — tabs and result-count hierarchy

The reference puts result-type tabs across the top (All 1,256 / Documents 842 / Folders 36 /
Metadata 278 / OCR 100) and a prominent count line.

The product hand-rolls a facet rail from `Card` + `Badge` and does not use platform `Tabs`. Facet
counts already arrive post-filter from the API, so the counts are real. Whether the product's facet
dimensions map onto the reference's tab dimensions needs checking against `SearchResults` before any
change — the tabs in the reference are result *types*, which may not be a facet this API returns.

### 4.5 Dashboard — status breakdown

`BreakdownCard` deliberately renders a definition list, with a comment arguing a five-slice donut of
enum counts is decoration. The reference shows a donut.

This is a genuine judgement call, not a defect. Both readings are defensible: the existing comment is
right that the reader wants numbers, and the reference is right that a distribution reads faster as a
shape. The data is real either way (`breakdownTileSchema`). Recording as a candidate, deliberately
**not** ranked high — it replaces working, reasoned composition with a different one.

### 4.6 Upload modal

Already `Dropzone` + `Progress` + `FormDialog` + `FormSection`. The reference's improvements are
proportion and grouping — a two-column field layout, a more prominent drop zone, a clearer file
queue — all composition, all achievable with existing layout primitives.

The reference's "Scan Document(s)" tab is a second capability. Whether the product has a scan path
must be confirmed before any tab appears; a tab that leads nowhere is worse than no tab.

---

## 5. Existing visual inconsistencies found

1. **Hand-written link styling repeated.** `text-primary-strong text-xs` appears as a literal class
   string on four "see all" links in `dashboard-screen.tsx`. Small, but it is the exact shape of
   drift the architecture rule exists to prevent — a `Button variant="link"` says it once.
2. **`ListCard` is a local wrapper** over `Card`/`CardHeader`/`CardTitle`/`CardContent`. Legitimate
   composition rather than a fork, but it means the dashboard has two card idioms (`StatCard` and
   `ListCard`) with no shared spacing contract.
3. **Activity entries render raw action codes** in `font-mono` (`DOCUMENT_APPROVED`). Deliberate and
   well-argued — the audit vocabulary must not fork — but it is the least scannable text on the
   dashboard and the reference's activity feed is markedly more readable.
4. **Search facet rail is bespoke.** Not wrong, but it is the one list-like surface in the product
   that does not go through a platform data component.

---

## 6. Accessibility risks

1. **Known platform defect, still open.** `SidebarNav` styles group headings
   `text-muted-foreground/70` at `text-[10px]` — measured at **2.78:1** on the Docs light surface,
   against the 4.5:1 WCAG 2.1 AA requires. Phase 7.1 disabled the product's four section headings
   rather than override platform styling or hardcode a colour.

   **This is now directly in tension with the reference**, which shows a visible "ADMINISTRATION"
   section heading. The visual direction cannot be reached without the upstream fix. See §7.
2. Badge counts added to navigation rows must not become icon-only meaning when the rail collapses;
   the accessible name has to carry the count.
3. File-type marks must not be the only carrier of type — the filename already states it, so the
   mark must be `aria-hidden`.

---

## 7. Platform gaps and stop conditions

### 7.1 Platform gap — `SidebarNav` group-heading contrast (re-raised from Phase 7.1)

Smallest upstream fix: raise the heading token from `text-muted-foreground/70` to full
`text-muted-foreground`, or lift the muted token on the Docs theme. Until then the reference's
section headings cannot be reproduced accessibly and the headings stay off.

### 7.2 Stop condition — storage quota does not exist

The reference shows "128.45 GB / 500 GB · 25.69%" with a progress bar, in both the sidebar and a
dashboard card. `storageTileSchema` returns `blobCount`, `storedBytes`, `referencedBytes` and
`unreferencedBlobs`, and its own comment states there is deliberately **no quota**.

A percentage requires a denominator the product does not have. **Not implementing.** A quota is a
backend capability and §14 forbids adding one here.

### 7.3 Stop condition — no period-on-period data for KPI deltas

`StatCard.delta` is well-designed and would be the right component — it even models `goodWhen`, so a
rising "Overdue" would correctly read as bad. But `CountTile` carries `state` and `count` only. There
is no previous-period figure anywhere in the contract.

**Not implementing.** Fabricating "+12.5% vs last month" on a compliance product's dashboard is the
clearest possible violation of §5's "Do not fabricate metrics."

### 7.4 Stop condition — Entity / Branch switcher

The reference header carries an Entity ("Al-Haj Group") and Branch ("Head Office") selector.

Checked: `admin-organization` does have `entities-screen.tsx`, `branches-screen.tsx`,
`companies-screen.tsx` and `departments-screen.tsx`, so entities and branches exist **as administered
records**. What does not exist is any evidence of a *session-scoped active entity* — nothing in the
session, the shell or the navigation carries one, and the tenant boundary in this product is the
database (ADR-0015), not an entity selector.

So the reference's header switcher is not a visual treatment of something the product has. It is a
scoping dimension that would change what every query returns. **Refused** — that is a product
capability and §14 forbids it here.

### 7.5 Stop condition — "Expiring Soon" tile

The reference shows it. `userDashboardSchema` carries exactly seven counts: `drafts`, `rejected`,
`pending`, `overdue`, `checkedOut`, `favorites`, `unreadNotifications`. There is **no** forward-looking
expiry count.

Expiry exists in the domain — Phase 6.1 added the expiry sweep — so the figure is computable, but it
is not exposed and exposing it is an API change. **Refused for this phase**, recorded as the one
backend addition that would most improve the dashboard's usefulness.

---

## 8. Ranked plan

Scored on visual impact × consistency × user value × accessibility ÷ risk.

| # | Change | Impact | Risk | Verdict |
| --- | --- | --- | --- | --- |
| 1 | Navigation badges from existing counts | high | low | **do** |
| 2 | File-type recognition in the library | high | low | **do** |
| 3 | Replace hand-written link classes with platform variants | low | very low | **do** |
| 4 | Upload modal proportion + field grouping | medium | low | **do** |
| 5 | Search: platform `Tabs` + count hierarchy | medium | medium | **verify data first** |
| 6 | Folder identity panel (identity only, no invented stats) | medium | medium | **verify first** |
| 7 | Status donut replacing the definition list | medium | medium | **defer — replaces reasoned work** |
| 8 | Section headings in the rail | medium | blocked | **blocked on 7.1** |
| 9 | Storage quota bar | high | — | **refused — no data** |
| 10 | KPI deltas | high | — | **refused — no data** |

---

## 9. What this audit did not establish

- **No screen has been rendered yet.** Every finding here is from source and typings. Density,
  whitespace and hierarchy judgements in §4 are provisional until the running application is
  inspected in Chromium at the six required widths.
- **Responsive and axe results are not in this document.** They belong to the implementation phase
  and will not be claimed from source inspection, per §11.
- **The reference's search tabs, folder statistics, scan path, entity dimension and expiry count are
  unverified** against their contracts. Each is marked as such above rather than assumed.
