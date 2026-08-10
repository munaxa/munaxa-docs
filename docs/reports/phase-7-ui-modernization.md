# Phase 7 — Visual Modernization & UI Polish

**Status:** COMPLETE, with three named limitations (§28).

Part I is the audit the brief requires before any code; Part II is what was implemented, measured
and verified. Nothing below rests on a screenshot looking better: every claim is a gate result, a
rendered image that was inspected, or a run of the real application in a real browser.

---

# Part I — Visual audit

## 1. Current visual architecture

The finding that shapes every decision below: **this application owns almost no visual language of
its own, and that is deliberate.**

```css
/* apps/web/src/app/globals.css — the whole file */
@import 'tailwindcss';
@import '@munaxa/theme/css/docs';
@source '../../node_modules/@munaxa/platform/dist';
```

`ARCHITECTURE.md`, restated in the file itself: *"Branding is configuration, not code … Nothing in
this repository may hardcode a colour, a font, a radius or a shadow — retuning the Docs palette
happens in munaxa-platform and reaches this product with no change here."*
`16-frontend-architecture.md` §1 makes it a table row: *"No hardcoded colour, spacing, radius,
shadow or z-index — semantic token classes only."*

**So Phase 7 cannot be a re-skin.** The palette, type scale, radii and shadows are not in this
repository, and inventing a competing set here is the one thing the architecture forbids outright —
which happens to be the same thing the brief forbids in §3. What is in this repository, and what is
therefore what this phase can improve, is **composition**: which component is used where, what is
grouped with what, what is emphasised, what recedes, and what the product says when it has nothing
to show.

That is not a consolation prize. Every weakness the audit found below is a composition weakness.

## 2. Existing design-system components

| Layer | Package | What it provides |
| --- | --- | --- |
| Tokens | `@munaxa/tokens` | typed design tokens + `css` entry |
| Theme | `@munaxa/theme` | `css/docs` — this product's palette, one import |
| Icons | `@munaxa/icons` | the shared icon set |
| Components | `@munaxa/ui` → `@munaxa/platform` | the entire component library |

`@munaxa/ui` re-exports `@munaxa/platform` wholesale. The platform ships far more than this product
uses:

- **primitives** — badge, button, tag
- **layout** — card, separator; and `layouts/`: page, panel, grid, stack, split, surface,
  container, center, scales, resizable, workspace
- **data-display** — table, timeline, accordion, avatar, sparkline
- **data-grid** — a real virtualised `DataGrid` with column menu, sorting and selection
- **feedback** — alert, dialog, drawer, **empty-state**, **error-state**, **skeleton**, spinner,
  toast, tooltip
- **navigation** — **breadcrumb**, pagination, tabs
- **overlays** — context-menu, dropdown-menu, hover-card, popover
- **forms** — field, input, label, select, checkbox, radio, switch, textarea, combobox,
  autocomplete, command, entity-picker, token-input
- **patterns** — dashboard, **stat-card**, stepper, progress, motion, token-reference
- **shell** — app-shell, sidebar, navigation-drawer, top-bar, menus, navigation
- specialised — files (dropzone, file-manager), flow (approval-flow, workflow), query
  (filter-builder, search-builder), board (kanban, gantt, org-chart, dnd), charts, date

## 3. What the product actually uses

Counted from imports across `apps/web/src`:

| Component | Uses | Read |
| --- | --- | --- |
| `Button` | 35 | healthy |
| `Select` · `Input` · `Field` | 30 · 17 · 13 | healthy |
| `Badge` | 27 | healthy in count, **weak in meaning** (§6) |
| `Card` | 22 | **over-used as the default container** (§7) |
| `Alert` | 17 | healthy |
| `EmptyState` | 14 | good, but absent from the dashboard |
| `PageHeader` · `Page` | 5 · 4 | **the finding** (§5) |
| `Timeline` · `DataGrid` · `Panel` · `Section` | 2 · 2 · 2 · 3 | under-used |
| `StatCard` | 1 | under-used |
| `Breadcrumb` | **0** | **never used anywhere** |
| `Skeleton` | **0** | **never used anywhere** |

The shape of that table is the audit's headline. The product reaches for `Card`, `Badge` and
`Button` and stops; the platform's compositional layer — page frames, sections, panels, breadcrumbs,
skeletons — is largely untouched.

## 4. What is already good, and must not be "improved"

Stated first, because the brief warns against assuming the UI is poor. It is not.

- **`ResourceList`** (`features/admin-shared/resource-list.tsx`) is a genuinely good abstraction:
  toolbar, `DataGrid`, row menu, bulk bar, pagination, delete/restore confirmations, `EmptyState`,
  loading state, column menu and per-row disabled reasons — once, for every list in the product,
  including the document library. It should be *extended*, never replaced.
- **`AdminScreen`** already does exactly what every other screen should: `Page` + `PageHeader` +
  `Stack`. The pattern exists; it is simply not applied outside `admin/`.
- **The dashboard's honesty rules** — `FORBIDDEN` and `UNAVAILABLE` render different sentences, and
  a tile the caller may not see is absent rather than zero. That is better than most enterprise
  dashboards and must survive.
- **The accessibility and visual-regression suites** — real Chromium, both themes, contrast checked
  against the *built* stylesheet, with one platform contrast defect explicitly tolerated and
  documented rather than silenced.
- **RTL discipline** — logical properties throughout, because the product ships EN + AR.

## 5. Finding 1 — page composition is inconsistent across the whole workspace

`AdminScreen` gives every one of the ~20 administration screens a `Page` + `PageHeader`. **No
workspace screen uses it.**

| Screen | Header today |
| --- | --- |
| Document library | **none at all** |
| Approval inbox | **none at all** |
| Document detail | raw `<h1 className="text-2xl font-semibold">` |
| Search · Notifications · Delegations · Recycle bin · Reports · Recent · Permissions | raw `<h1>` |

(Permissions keeps its own `<h1>`: it is a sub-page of a document rather than a workspace destination, and Phase 7 left it alone.)

Consequences visible on screen: the vertical rhythm differs between `admin/` and everything else;
title sizes are set locally (`text-2xl` in seven places, `text-lg` in two); there is no consistent
slot for page-level actions; and **no screen in the product renders a breadcrumb**, although the
platform ships `Breadcrumb`, `PageHeader` accepts an `above` slot built for it, and
`16-frontend-architecture.md` calls for contextual breadcrumbs.

This is the single largest "does not feel like one product" defect, and it is the cheapest to fix.

## 6. Finding 2 — the status system carries no meaning

`06-document-lifecycle.md` defines thirteen states. The library renders every one of them the same
way:

```tsx
cell: (row) => <Badge>{translate(`documents.status.${row.status}`)}</Badge>
```

Search renders them `tone="muted"`. The document header renders the default tone. So `DRAFT`,
`PUBLISHED`, `ARCHIVED`, `REJECTED` and `EXPIRED` are visually identical everywhere, and a reader
scanning a folder of two hundred rows has to read every badge.

There is **no shared status→tone mapping in the product at all** — `toneFor` exists twice, locally,
in `delegations-screen.tsx` and `audit-screen.tsx`, for different enums. This is brief §12 exactly,
and it is the highest-value single change in the phase: one component, five screens.

## 7. Finding 3 — `Card` is the default container, so nothing has weight

The document record page is the clearest case. Identity, properties, file facts, preview, revisions,
approvals, signatures and audit all arrive as equal-weight cards in a grid. There is no visual
answer to "what is this document, what state is it in, and what do I do next" — the brief's PRIMARY
tier — because everything is tier two.

The header compounds it: up to **eight buttons in one flat row**, all `variant="outline"` except
download, so the primary action does not read as primary.

The dashboard has the same flatness at lower stakes: seven `CountStat` tiles of identical weight,
where exactly one of them ("overdue") is the one that should catch the eye — the code even says so
in a comment — and it is distinguished only by tone.

## 8. Finding 4 — empty, loading and error states are uneven

`EmptyState` is used 14 times and is good where used. But:

- the dashboard's `ListCard` renders emptiness as a bare muted sentence, five times, rather than the
  platform pattern;
- **`Skeleton` is used zero times** — every loading state in the product is a spinner or nothing,
  and the list already knows its own row count;
- `ErrorState` is used twice, so most failures fall back to a toast or an `Alert` with no "what you
  can do next".

## 9. Finding 5 — the shell states no hierarchy

`SidebarNav` is handed **one group containing all ten destinations**. Home, Documents, Approvals,
Search, Audit, Recycle bin, Delegations, Notifications, Reports and Administration read as one
undifferentiated list, so the rail says nothing about what kind of product this is. The platform's
`SidebarNav` takes an array of groups; the product passes one.

Two smaller shell defects:

- the theme toggle is a **text** button whose label changes between "Light" and "Dark" — the top bar
  visibly reflows on every toggle, and on first paint it reads "Appearance", a third width;
- the brand is a bare `<span>` with no mark, so the workspace has no identity anchor.

## 10. Repeated patterns worth extracting — and ones that are not

**Extract** (each appears three or more times, in the same shape, across features):

| Pattern | Where it repeats today |
| --- | --- |
| Page frame + title + description + actions (+ breadcrumb) | 10 workspace screens, hand-rolled |
| Document status → tone + label | library, search, detail, recent, recycle bin |
| `dt`/`dd` property pair | document detail (twice), revisions, signatures, permissions |

**Do not extract** — one-off layouts whose abstraction would cost more than it saves: the workflow
definition editor (987 lines, a bespoke stage editor), the signing ceremony, the preview toolbar,
the numbering builder, the permissions matrix. The brief's §18 warning applies to all five.

**Do not migrate**: `ResourceList` must not be replaced by a bare platform `DataGrid` — it carries
delete-reason capture, restore, blocked-delete reasons and the bulk bar, none of which the platform
component owns. Brief §17.

## 11. Design-system gaps found

1. **`Badge` contrast** — `text-primary-strong` on `bg-primary/15` measures 4.31:1 against a 4.5:1
   requirement in the Docs light palette. Already documented in Phase 5.2 and tolerated by the
   visual suite; a palette fix, not a product fix. Phase 7 must not add *more* uses of the default
   tone where a semantic tone is available.
2. No `Skeleton` composition for a table (the primitive exists; a row-shaped composition does not).
3. `StatCard` has an `icon` slot the product has never passed.

## 12. Risks this phase must manage

**Accessibility.** The suites are real: axe in jsdom (`a11y.spec.tsx`), keyboard traversal
(`keyboard.spec.tsx`), and Chromium contrast over the built stylesheet. Any new interactive element
needs a name, and any new colour pairing needs to survive both themes.

**Visual regression.** Eighteen baselines exist — dashboard, document list, folder tree, search,
sidebar (open and collapsed), signatures (two states) and the workflow inbox — each in light and
dark. Every one of them is expected to change. They must be re-recorded deliberately, screen by
screen, *after* the change that causes them, and never in bulk.

**Responsive.** The library is `flex-col lg:flex-row` with a 288px aside; the document header wraps
eight buttons; the dashboard grid is already responsive. Narrow-screen work is refinement, not
rescue.

**Scope.** 18,322 lines of feature TSX. A pass that touched every file would be the uncontrolled
rewrite the brief forbids. The plan below is ordered by leverage: the first three items change how
every screen reads, by editing shared code rather than screens.

## 13. Implementation order

| # | Change | Screens affected | Kind |
| --- | --- | --- | --- |
| 1 | `WorkspacePage` — `Page` + `PageHeader` + breadcrumb slot | 10 | extract |
| 2 | `DocumentStatusBadge` — one status system | 5 | extract |
| 3 | Sidebar groups + brand mark + icon theme toggle | all | shell |
| 4 | Document record page: identity block, action hierarchy, sections | 1 | compose |
| 5 | Library: title/number hierarchy, status column, folder aside | 1 | compose |
| 6 | Dashboard: tile icons, priority, `EmptyState` in `ListCard` | 1 | compose |
| 7 | Property list extraction | 3 | extract |
| 8 | Tests: shell spec, a11y, keyboard, baselines re-recorded | — | verify |

---

# Part II — What was implemented

## 14. Before and after, in one paragraph each

**Before.** Twenty administration screens sat in a `Page` with a `PageHeader`; every workspace
screen did not — the library and the approval inbox had no header at all and seven others opened
with a hand-written `<h1>`. No screen anywhere rendered a breadcrumb. Thirteen document lifecycle
states rendered as one identical grey badge. The record page opened with up to eight equal-weight
buttons above the document's own name, and the number that identifies a controlled record was the
fourth line of the second card. The rail listed ten destinations in one undifferentiated run. Seven
dashboard tiles were seven identical rectangles of text.

**After.** Every workspace screen shares one page frame, one title scale, one actions slot and a
breadcrumb where there is a path to show. Each lifecycle state has its own tone *and* its own mark,
in the library, in search and on the record page. The record page leads with the document's identity
— title, number, revision, state — one primary action, and one menu holding the rest. The rail is
four named sections behind a brand mark. The dashboard's tiles are recognisable before they are
read, and its five empty lists say so in the platform's own empty state.

## 15. Screens changed

| Screen | What changed |
| --- | --- |
| **Application shell** | four navigation sections; brand mark; icon theme toggle that no longer reflows the top bar |
| **Document library** | page header + breadcrumb; two-line title with the number beneath it; status column with tone and mark; duplicate "Status" header resolved; end-aligned size |
| **Document record** | identity block (title · number · revision · state); one primary action, the rest in a menu; properties card no longer restates the number |
| **Dashboard** | an icon per tile; hover affordance on the tiles that are links; `EmptyState` in the five list cards |
| **Search** | page header + description; status badges |
| **Recently opened** | page header + breadcrumb |
| **Notifications · Delegations · Recycle bin · Reports** | page header, replacing four hand-written `<h1>` blocks |

## 16. Components changed

**Added — two, both shared:**

- `components/workspace-page.tsx` — `WorkspacePage`: the `Page` + `PageHeader` + breadcrumb frame,
  used by ten screens. Deliberately not the same component as `AdminScreen`: that one takes message
  keys and always has a description, while a workspace title is frequently a document's own name.
- `features/documents/status-badge.tsx` — `DocumentStatusBadge` and `statusPresentation`: one
  mapping from the domain's thirteen states to a tone and a mark, used by five screens.

**Changed:** `workspace-shell.tsx`, `dashboard/tiles.tsx`, `dashboard-screen.tsx`, and the seven
screens listed above.

**Deliberately not extracted**, per brief §18 and the audit's §10: the workflow definition editor,
the signing ceremony, the preview toolbar, the numbering builder and the permissions matrix. Each is
a one-off layout whose abstraction would cost more than it saves.

**Deliberately not migrated**, per brief §17: `ResourceList` stays. It carries delete-reason capture,
restore, blocked-delete reasons and the bulk bar; the platform's `DataGrid` owns none of those, and
replacing it would have been a migration that lost capability.

## 17. Platform components newly adopted

`Breadcrumb` (**0 uses before this phase**), `EmptyState` on the dashboard, `StatCard`'s `icon` slot,
`ColumnDef.multiline`, and `Button size="icon"`. Nothing was re-implemented locally.

## 18. Design-system changes

**None to the design system, and that is the finding.** `ARCHITECTURE.md` and
`16-frontend-architecture.md` §1 both forbid this repository from holding a colour, a font, a radius
or a shadow; the Docs palette lives in `munaxa-platform` and arrives through one `@import`. So this
phase changed *composition* and touched no token. `verify:styles` confirms the built stylesheet is
unchanged in kind: 249 platform utility classes, all generated, 61 kB.

Six i18n keys were added through the catalogue, in both English and Arabic: `nav.breadcrumb`, four
navigation group labels, `documents.number.none`, `documents.actions.more` and `admin.fields.record`.

## 19. Accessibility verification

| Check | Result |
| --- | --- |
| axe, jsdom, every rendered screen spec | **132 passed** |
| Keyboard traversal (`keyboard.spec.tsx`) | passed — skip link still first, every destination reachable |
| Chromium colour contrast, both themes, built stylesheet | **18/18 passed** |
| Navigation landmarks named, icons `aria-hidden`, one `aria-current` | passed |
| New: every lifecycle state carries a word *and* a mark | **new test**, 13 states |
| New: every destination belongs to a named section | **new test** |

**No new tolerated contrast violation.** The suite has tolerated exactly one platform palette defect
since Phase 5.2 and still tolerates exactly that one.

## 20. Defects found

| # | Defect | Where | Outcome |
| --- | --- | --- | --- |
| 1 | `Badge tone="success"` fails WCAG AA — **4.21:1** light, **3.98:1** dark, against 4.5:1 for 12px text | `@munaxa/platform` palette | **Not shipped.** Found by giving `APPROVED`/`PUBLISHED` the semantically correct green and measuring it in a browser. Those two states use `default` instead; the hollow and filled marks still separate them, and the palette fix is a platform issue (§22) |
| 2 | A wrapper span inside `Badge` moved the text off the element carrying `text-primary-strong`, turning a *documented, inherited* 4.31:1 into an unrecognised violation that failed the build | this product | **Fixed** — the icon and the word are direct children of the badge, gap on the badge itself |
| 3 | A fixed 320px (then 240px) title column squeezed Type, Confidentiality and Size into single-letter ellipses with colliding headers | this product, introduced by this phase | **Fixed** — measured in a browser three times; even sharing reads best, and `minWidth` is not honoured by the current distribution |
| 4 | Two columns headed "Status" in the library — lifecycle state and record state | pre-existing | **Fixed** narrowly: the shared column is renamed *in place* for this one list, without touching the twenty administration screens that use it |
| 5 | The dashboard fixture supplies workflow and user states that are not members of either enum, so two breakdown cards render raw message keys in the baseline | test fixture | **Not fixed** — a fixture-fidelity issue, not a product defect; the real enums resolve correctly |

## 21. Defects deliberately not fixed

- **#5 above** — the fixture, not the product.
- **The `Badge` default-tone contrast defect inherited from Phase 5.2** (4.31:1). Unchanged, still
  the only tolerated violation, still a platform palette fix.

## 22. Platform gaps, for `munaxa-platform`

1. **`Badge` success tone fails AA** at its own 12px size: `text-success-strong` on `bg-success/15`
   measures 4.21:1 (light) and 3.98:1 (dark). Same family as the already-reported
   `text-primary-strong` at 4.31:1. Both need a darker `-strong` or a lighter tint.
2. **`DataGrid` has no proportional column strategy.** `width` is absolute and consumes from the
   shared remainder; `minWidth` is not honoured in distribution. A `flex`/`weight` per column would
   let a title column earn more space without starving the rest — the exact case measured in §20 #3.
3. **No table-shaped `Skeleton` composition.** The primitive exists; a rows-and-columns composition
   does not, which is why loading states in this product are still spinners.

## 23. Responsive verification

The changed layouts keep the responsive behaviour they had and add none that regresses: the library
is still `flex-col lg:flex-row`; the dashboard grids are still `base/sm/md/lg/xl`; `Page` supplies
one measure. The record header's eight-button row — the one element that genuinely wrapped badly on
a laptop — is now one button and one menu, which is the phase's clearest narrow-screen improvement.
Verified at 1280×900 in Chromium through the visual suite and through the E2E suite's own viewport.
**Not verified: true tablet and phone widths**, which is recorded as remaining debt in §26 rather
than claimed.

## 24. Test results

| Gate | Result |
| --- | --- |
| format | clean |
| lint | **13/13**, 0 errors |
| typecheck | **13/13** |
| unit | web **132** (was 128) · API 645 (1 skipped) · domain 164 · contracts 26 · utils 11 · i18n 4 · worker 2 |
| build | **9/9** |
| verify:styles | 249 classes, all generated |
| visual regression | **36/36** — 18 contrast checks, 18 baselines |
| **E2E, real browser** | **24/24 passed** — the shipped API on real PostgreSQL and Redis, `next start` over the production build, real Chromium |

**Coverage went up, not down.** Four tests were added (13 lifecycle states; navigation sections; two
more in the shell spec) and three suites were *adapted rather than weakened*: the archive-affordance
spec, and the two lifecycle E2E tests, now open the overflow menu with a real click before asserting.
That was deliberate — "offered" has to keep meaning "reachable by a person", not "present in the
markup", and a test that reached into a closed menu's DOM would pass against a menu that never opens.

## 25. Visual regression: what changed and why

Six of eighteen baselines were re-recorded. Each was inspected as a rendered image before acceptance,
and each corresponds to one intended change:

| Baseline | Intended change |
| --- | --- |
| `dashboard-light` · `dashboard-dark` | tile icons, hover affordance, `EmptyState` in the list cards |
| `document-list-light` · `document-list-dark` | page header, breadcrumb, two-line title, status tone and mark, "Record" column heading |
| `search-light` · `search-dark` | page header and description, status badges |

**Twelve baselines were not touched** — sidebar, collapsed sidebar, folder tree, workflow inbox and
both signature states — because nothing this phase did changes what they render. Nothing was
mass-accepted: the first re-record attempt was thrown away when the rendered image showed the column
regression in §20 #3.

## 26. Remaining visual debt

1. **The rail's grouping has no baseline.** `sidebar-nav` renders `SidebarNav` with its own fixture
   groups rather than through `WorkspaceShell`, so the four sections are covered structurally by
   `workspace-shell.spec.tsx` and not visually. A shell-composed baseline would close it.
2. **No baseline for the document record page**, the screen this phase changed most. It is exercised
   behaviourally by the E2E suite; a screenshot would make the identity block a guarded rendering.
3. **Tablet and phone widths are unverified** (§23).
4. **`Skeleton` is still unused.** Every loading state in the product is a spinner; the lists know
   their own row count and could show their shape.
5. **Forms are untouched.** Brief §10 asked for field grouping and progressive disclosure; the
   phase spent its budget on the shell, the library and the record page, which is where the audit
   said the leverage was. The admin forms are consistent already — they are just not *composed*.
6. **The title column still truncates** at 1280px with the folder aside open. Blocked on platform
   gap §22 #2.

## 27. Recommended next improvements

1. Take the platform palette fix (§22 #1), then give `APPROVED`/`PUBLISHED` back their green — it is
   a two-line change here once the tone passes.
2. A table-shaped skeleton, once the platform ships one, wired into `ResourceList`'s `loading` state
   — one change, every list in the product.
3. A shell-composed sidebar baseline and a record-page baseline (§26 #1, #2).
4. Forms: section grouping and progressive disclosure on the four longest — the workflow definition
   editor, the upload dialogue, the numbering builder and the notification templates screen.

## 28. Status against the brief's definition of done

| Requirement | Status |
| --- | --- |
| UI visibly more modern; hierarchy improved | **Implemented** — verified as rendered images and in a real browser |
| Shell polished | **Implemented** |
| Library feels like a professional EDMS | **Implemented** |
| Record page feels like a controlled record | **Implemented** |
| Statuses visually consistent | **Implemented** |
| Tables consistent | **Implemented** — one `ResourceList`, unchanged in behaviour |
| Forms modernised | **Not done** — §26 #5, stated rather than claimed |
| Loading states intentional | **Partial** — empty and error states yes, skeletons no (§26 #4) |
| Responsive improved | **Partial** — desktop and laptop verified, tablet and phone not (§23) |
| Accessibility preserved | **Verified** — 132 axe assertions, 18 contrast checks, no new tolerated violation |
| Functionality intact | **Verified** — 24/24 E2E against the shipped application |
| No business logic rewritten | **Verified** — no API, schema, permission, workflow or storage change |
| No security control weakened | **Verified** — every affordance still reads the server's `capabilities`; the overflow menu changed where an action is, never whether it is offered |
| Visual regression passes | **Verified** — 36/36 |
| Build · typecheck · lint pass | **Verified** |
