# Phase 5.1 — UI Foundation Completion & Platform Design System Adoption

**Purpose:** finish the UI foundation so every subsequent feature is built on a verified Platform
Design System, and make the Phase 19 defect impossible to repeat silently.
**Status:** point-in-time report. Not edited afterwards.
**Method:** full install, platform internals read, every gate executed including the integration
suite against two real tenant databases. Every number below was measured.

The ten deliverables the brief asks for are sections [1](#1-ui-foundation-completion-report) through
[10](#10-remaining-ui-backlog).

---

## 1. UI Foundation Completion Report

### 1.1 What this phase found

Three things, in descending order of how quietly they were failing.

**The guard the brief asked for works, and proving it took two attempts.** Part 1 asks for a test
that fails when platform-only utility classes disappear. The first implementation passed against a
deliberately broken build — `css.includes('.bg-primary')` matches inside `.bg-primary-strong`, so
every named sentinel resolved on the strength of a *different* class, and the check reported a
healthy stylesheet that was missing 59% of itself. A regression guard that fails open is worse than
no guard, because it converts an absent check into a false assurance. The fix is a selector-boundary
test, and both helpers now have unit tests of their own — the substring bug is one of the cases.

**A second silent defect, of the same family as Phase 19's.** `--color-surface-hover` is referenced
by five hover states across `folder-tree.tsx` and `search-screen.tsx`, and is **defined nowhere** —
not in `@munaxa/platform/themes`, not in its tokens, not anywhere in this repository. Those five
hover affordances have never done anything. Nothing could have caught it: it type-checks, it lints,
it builds, and Tailwind emits a rule whose value happens to reference an undefined variable.

**A correction to Phase 19.** That report recorded `SkipLink` as exported-and-unused and called its
absence an accessibility defect. **It is used** — through `AppShell`'s `skipLinkLabel` prop in
`workspace-shell.tsx:95`, translated in both catalogues. The symbol grep behind that finding could
not see a prop, and the platform's shell renders the component itself. There was no defect, and the
remediation item it generated is withdrawn.

### 1.2 What changed

| Area | Before | After |
| --- | --- | --- |
| Stylesheet regression guard | none | `verify:styles`, in CI after `Build`, proved in both directions |
| Web tests | 21 | **37** |
| Platform components used | 54 / 180 | **62 / 180** |
| Raw `<table>` elements | 3 | **0** |
| Raw visible form controls | 12 | **0** |
| Raw `<button>` imitating a platform variant | 1 | **0** |
| Dead CSS variable references | 5 | **0** |
| Arbitrary Tailwind values | 6 | **1** (`bg-[Canvas]`, deliberate) |
| Screens using `PageHeader` | 4 | 5 |

No business behaviour, route, API, schema, workflow, permission or audit rule was changed. The
audit screen's filters are still read through `FormData` on submit against the same six keys; the
timeline still renders the action code verbatim and the digest with its version.

### 1.3 Verdict

**The UI foundation is complete for the purpose the brief states: subsequent features can now be
built on a verified design system.** The verification is the load-bearing word — before this phase
the application had never been checked against the platform's compiled output, and had shipped for
one full phase with most of its colour missing.

It is not a finished *product* UI. It has no icons at all (§6), no breadcrumb on a folder tree, and
21 of its 37 tests still assert pure helpers rather than screens. Those are in the backlog (§10)
with reasons, not omissions.

---

## 2. Platform Component Inventory

180 components exported by `@munaxa/platform`; **62 used**. The inventory below covers every
component the brief names plus every remaining local implementation with a platform equivalent.

**One caveat that changes how this table should be read:** "used" here means *imported by name*.
`SkipLink` is rendered by `AppShell` from a prop and never imported, which is exactly the mistake
Phase 19 made. Prop-driven composition is invisible to an import census.

| Component | Local implementation | Platform equivalent | Feature parity | Missing platform capability | Risk | Recommendation |
| --- | --- | --- | --- | --- | --- | --- |
| **Table** | raw `<table>` ×3 in `permissions-screen`, `reports-screen` | `Table`/`THead`/`TBody`/`TR`/`TH`/`TD` | **Full** | none | Low | **A — replaced.** Platform `TH` carries `scope="col"`; the hand-written markup omitted it, so this also closed a WCAG gap |
| **Timeline** | `audit-timeline.tsx`, `ClientAuditRow` — `<ol>`/`<li>` with `<br>` and `<small>` | `Timeline`/`TimelineItem` | **Full** — `title`/`meta`/`timestamp` take every field rendered | none | Low | **A — replaced.** Both trails |
| **SkipLink** | none | `SkipLink`, via `AppShell skipLinkLabel` | **Full** | none | — | **Already adopted.** Phase 19's finding was wrong (§1.1) |
| **Button** | `ThemeToggle`'s `<button>` with hand-written ghost classes | `Button variant="ghost"` | **Full** — identical height, radius, padding, `hover:bg-accent` | none | Low | **A — replaced** |
| **Input / Select** | 12 hand-styled controls across 6 screens | `Input`, `Select`, `Field` | **Full** | none | Low | **A — replaced.** Report parameters, quiet hours, revision compare, saved-search name, both search boxes, all six audit filters |
| **PageHeader** | bare `<h1>`/`<p>` on the audit screen | `PageHeader` | **Full** | none | Low | **A — replaced** on audit; 9 workspace screens remain (§10) |
| **EmptyState** | bare `<p>` for four empty conditions | `EmptyState` | **Full** | none | Low | **A — replaced** |
| **FileManager** | `library-screen` + `folder-tree` (379 + 130 lines) | `FileManager` | **Partial** | Custom columns. `FileNode` is `{id,name,kind,size,modifiedAt,mimeType,meta}` — no way to render a document number, revision label, status or confidentiality mark as a *column* | **High** | **C — keep.** See [§4](#4-filemanager-compatibility-report) |
| **ApprovalFlow** | `approval-panel.tsx` (507 lines) | `ApprovalFlow` | **Partial** | `ApprovalMode` is `'all' \| 'any'`; this product has `ALL \| ANY \| QUORUM \| PERCENT`. `ApprovalStatus` has no `CANCELLED` | **High** | **C — keep.** See [§5](#5-approvalflow-compatibility-report) |
| **WorkflowCanvas** | `admin-workflows/versions-screen` | `WorkflowCanvas` | **None** | Requires `{x, y}` per node. A workflow version here is an *ordered list* of stages with no coordinates, and nothing persists any | Medium | **C — keep.** The platform's own `ApprovalFlow` docstring argues a chain is a list rather than a graph; this product agrees |
| **SearchBuilder / FilterBuilder** | `search-screen` facets; `audit-screen` filters | `SearchBuilder`, `FilterBuilder` | **Partial** | Server-computed facet *counts*. `FilterField` models client-side field/operator/value conditions; Phase 8's facets come back from the weighted index with counts attached, and the audit endpoint accepts six fixed columns | Medium | **C — keep** both, documented |
| **DatePicker / DateRangePicker** | `type="date"` inputs on audit and report screens | `DatePicker` | **Partial** | Uncontrolled use. The picker is controlled; both forms are read through `FormData` on submit | Medium | **C — keep.** Migrating means lifting dates into state and changing how the form is read — a behaviour change on the screen that answers an auditor |
| **Breadcrumb** | none — folder navigation has no trail | `Breadcrumb` | n/a — nothing to migrate | none | Low | **A — deferred.** Adding it is a new affordance, and this phase may not change visual appearance. §10 |
| **Tabs, Skeleton, Stepper, Separator, Tooltip, Popover, Drawer, Avatar, Calendar, ScrollArea** | none | available | n/a | none | — | Not needed by any current screen. Not adopting an unused component is correct |
| **NotificationMenu, OrganizationSwitcher** | none | available | Unassessed | — | — | §10 — plausible fits for the top bar, out of this phase's scope |
| **Kanban, Gantt, OrgChart, CountUp, Reveal, Cover** | none | available | n/a | — | — | No place in an EDMS. Correctly unused |

---

## 3. Component Migration Matrix

Every duplicated component, with the category the brief defines and the technical justification it
requires.

| # | Component | Category | Justification |
| --- | --- | --- | --- |
| 1 | Table family | **A — replace completely** | Structural wrapper over native elements; no behaviour to preserve. Applied. Net gain beyond consistency: `scope="col"` |
| 2 | Timeline | **A — replace completely** | `TimelineItem(title, meta, timestamp)` accepts every field both rows rendered. Applied to both trails |
| 3 | ThemeToggle button | **A — replace completely** | The hand-written classes were imitating `variant="ghost"` exactly. Applied |
| 4 | Form controls (12) | **A — replace completely** | `Input`/`Select` are forwardRef wrappers over native elements; `name`, `value`, `defaultValue` and `onChange` pass straight through, so `FormData` reads are unaffected. Applied |
| 5 | Audit screen chrome | **B — extend through composition** | `PageHeader` + `Field` + `EmptyState` + a local `FilterField` that pairs `Field` with a `useId`-generated id. The platform has no "filter bar" component and does not need one |
| 6 | Audit filters | **C — keep** | `SearchBuilder` offers field/operator/value combinations the endpoint does not accept. The trail is queried by six fixed, server-known columns, and the URL is the whole query so a filtered trail is a shareable link |
| 7 | DatePicker | **C — keep** | Controlled vs. uncontrolled. Both forms are read through `FormData` on submit; adopting the picker means lifting state and changing how the form is read, for no capability the native control lacks |
| 8 | Search facets | **C — keep** | Facet *counts* come from the server's weighted index. `FilterField` has no representation for a count, and a client-side condition builder cannot produce one |
| 9 | FileManager | **C — keep** | [§4](#4-filemanager-compatibility-report) |
| 10 | ApprovalFlow | **C — keep** | [§5](#5-approvalflow-compatibility-report) |
| 11 | WorkflowCanvas | **C — keep** | Needs persisted `{x, y}` per node; a stage list has neither and inventing coordinates would store layout as if it were workflow data |
| 12 | Search facet button, report definition button | **C — keep** | List-row toggles with `aria-pressed` and link affordance respectively, at a density `Button` does not offer. Converting changes visual appearance, which this phase may not do |

**Nine components were assessed and kept.** The brief's instruction — *"Do not migrate components
simply because Platform equivalents exist"* — is the reason this matrix is longer than the list of
things that moved.

---

## 4. FileManager Compatibility Report

`FileManager` is storage-agnostic by design: it fetches nothing, uploads nothing, knows no URLs, and
reports `onNavigate` / `onOpen` / `onUpload(files)`. That design is right, and it is not the
obstacle.

| EDMS capability | Supported | Evidence |
| --- | --- | --- |
| **Confidential documents** | **No** | A confidentiality mark must be visible in the list. `FileNode` has no field for it and no custom column exists |
| **Document renditions** | **No** | Nothing models "this row has a preview, that one is still rendering" |
| **Permissions** | **Partial** | `itemActions` is a per-row `ReactNode`, so a capability-gated menu is expressible. Row *visibility* is the product's — correct, and already how the API answers |
| **Previews** | **Partial** | `onOpen` can route to the preview panel. No thumbnail slot |
| **Metadata** | **No** | `meta?: Record<string, unknown>` is passed back in callbacks and **never rendered**. Business metadata is what a document library is for |
| **Versioning** | **No** | No revision label, no "checked out by" lock state |
| **Upload constraints** | **Yes** | `uploadOptions` forwards the full `DropzoneProps` |
| **Retention** | **No** | No field for a disposition date or a legal hold |

### The single blocking gap

**`FileManager` has fixed columns — name, size, modified — and no column API.** A controlled
document's list is `Number | Title | Status | Revision | Confidentiality | Owner`. Six of the eight
rows above fail for one reason.

**Do not migrate.** Forcing a document library through a file browser would mean encoding a document
number into `name` and losing every other column, which is not a file browser rendering documents —
it is a document library pretending to be a file share, and `README.md` opens by saying this product
is not that.

### Platform enhancement required

```ts
export interface FileManagerProps {
  /**
   * Extra columns after `name`. The manager still owns sorting, selection and keyboard
   * navigation; the product owns what a cell contains.
   */
  columns?: readonly {
    key: string;
    header: string;
    render: (item: FileNode) => ReactNode;
    sortable?: boolean;
  }[];
  /** Rendered before the name — a status dot, a confidentiality mark, a lock. */
  itemLeading?: (item: FileNode) => ReactNode;
}
```

The list view is already the platform's `DataGrid`, which has a `ColumnDef` model this product
already uses directly. **The capability exists one layer down and is not exposed.** That makes this a
plausible small enhancement rather than a rewrite — and it would serve any product with a
domain-typed file list, not only this one.

---

## 5. ApprovalFlow Compatibility Report

`ApprovalFlow` is deliberately generic: `approvers` and `condition` are `ReactNode`, rendered and
never read. Its docstring is explicit that modelling them "would be an approval *engine* rather than
an editor for one". Correct — and the mismatch is in the two fields it *does* model.

| EDMS capability | Supported | Evidence |
| --- | --- | --- |
| **Conditional branches** | **Yes** | `condition?: ReactNode`, rendered as-is. `SKIPPED` exists |
| **Parallel approvals** | **Partial** | `mode: 'all' \| 'any'` covers `ALL` and `ANY` |
| **Sequential approvals** | **Partial** | Steps are ordered. But `WorkflowStageSummary.ordered` — sequential *within* a stage — has no equivalent |
| **Rejection paths** | **Partial** | `status: 'rejected'` exists. `TaskDecision.CHANGES_REQUESTED` — return for modification — has no status |
| **Escalation** | **Yes** | Expressible through `meta: ReactNode` |
| **Delegation** | **Yes** | `approvers: ReactNode` renders "on behalf of" from `onBehalfOf` |
| **Audit visibility** | **Yes** | `readOnly` with per-step `status` is exactly the live progress view |
| **Workflow versioning** | **Yes** | A property of the instance, outside the component |

### The two blocking gaps

**1. Completion rules.** The platform models two; this product has four.

```ts
// @munaxa/platform
export type ApprovalMode = 'all' | 'any';

// @edms/domain — packages/domain/src/enums/workflow.ts:40
export const StageCompletionRule = { ALL, ANY, QUORUM, PERCENT };
```

`QUORUM` carries a count and `PERCENT` a percentage — `needsThreshold()` exists precisely because a
definition must state a number for both. **"2 of 3 approvers" and "60% of approvers" cannot be
expressed by a binary `all | any`**, and the screen already renders `approvalsGiven` of
`approvalsRequired` computed by the API using the same function the engine completes the stage with.

**2. Stage status.** `ApprovalStatus` has no `CANCELLED`.

`WorkflowStageStatus.CANCELLED` means "the instance ended before this stage ran"; `SKIPPED` means
"its condition did not hold". The domain enum comments distinguish them deliberately, and the
approval panel shows a skipped stage *with its reason* because — in its own words — *"'this control
did not apply to this document' is a fact an auditor wants"*. Mapping `CANCELLED` onto `skipped`
would tell an auditor a control was evaluated and did not apply, when in fact it was never reached.
**That is a false statement in a compliance record**, which is a stronger objection than a visual one.

**Do not migrate.**

### Platform enhancement required

```ts
export type ApprovalMode = 'all' | 'any' | { kind: 'quorum'; count: number }
                                         | { kind: 'percent'; percent: number };

export type ApprovalStatus =
  | 'pending' | 'active' | 'approved' | 'rejected' | 'skipped'
  | 'changes-requested'   // returned to the author; the request is live, the step is not
  | 'cancelled';          // the instance ended before this step ran — distinct from skipped

export interface ApprovalStep {
  /** Approvers act in order within the step, rather than concurrently. */
  ordered?: boolean;
}
```

Every Munaxa product with an approval chain will meet quorum rules and the skipped/cancelled
distinction, so this is a genuine platform gap rather than an EDMS special case.

---

## 6. Accessibility Report

### Verified present

| Check | Result |
| --- | --- |
| **Skip link** | **Present.** `AppShell skipLinkLabel` at `workspace-shell.tsx:95`; translated in `en` and `ar`. Visually hidden until focused; target id from shell context so link and main cannot disagree |
| **Landmarks** | `AppShell` supplies the main region; `Sidebar`/`TopBar`/`NavigationDrawer` supply navigation and banner |
| **Accessible names** | **Every visible control has one** — audited individually. `aria-label` on both search boxes; wrapping `<label>` on quiet hours, report parameters, revision compare and saved-search name; `Field htmlFor` on all six audit filters |
| **Table semantics** | **Improved.** All three tables now use `TH`, which defaults to `scope="col"`. The replaced markup had bare `<th>` |
| **RTL** | `dir={TEXT_DIRECTION[locale]}` at the root; `dir="auto"` on user-supplied text; `Timeline` uses logical `border-s`; the tree indent uses `paddingInlineStart` |
| **Keyboard navigation** | `DataGrid` cell navigation, `Dialog` focus trapping, `ApprovalFlow` reorder handles — all platform-owned |
| **Focus visibility** | Platform `focus-visible:ring-*`. The product defines no focus styles of its own, so it cannot suppress them |
| **`aria-hidden` on decoration** | Breadcrumb separators, the `✕` glyph in the type-fields editor |
| **No positive `tabIndex`** | Confirmed — zero occurrences |
| **Hover affordances** | **Fixed.** Five hover states referenced an undefined variable and did nothing. Now `hover:bg-accent` |

### Remaining gaps

| Gap | Severity | Why it is not fixed here |
| --- | --- | --- |
| **No automated a11y test** | **High** | Nothing runs axe. Every row above is a static reading, and a static reading is what Phase 19 got wrong about the skip link |
| **Heading hierarchy unverified** | Medium | Nine workspace screens render bare `<h1>`/`<h2>`. Whether any page skips a level needs rendering |
| **No icons → text-only affordances** | Medium | Not itself a failure — text labels beat unlabelled icons — but row actions are text buttons in a dense grid |
| **Colour contrast unmeasured** | Medium | A property of the palette, which lives in the platform |
| **Screen-reader pass not run** | Medium | Needs a real assistive technology, not a grep |

**The honest summary: no accessibility defect was found, one was fixed, one previously reported was
withdrawn as false — and none of that is the same as the application having been tested.**

---

## 7. Design System Compliance Report

| Dimension | Before | After | Notes |
| --- | --- | --- | --- |
| **Typography** | platform scale, but 19 bare headings | unchanged; audit screen now `PageHeader` | §10 |
| **Spacing** | tokens throughout | unchanged | Zero arbitrary spacing values |
| **Elevation** | `Card`/`Panel` only | unchanged | No hand-written shadows |
| **Semantic colours** | 5 dead variable references | **0** | The `--color-surface-hover` fix |
| **Buttons** | 1 hand-styled ghost | **0** | 2 list-row toggles kept, documented |
| **Forms** | 12 hand-styled controls | **0** | `Field`/`Input`/`Select` throughout |
| **Dialogs** | `Dialog`, `FormDialog` | unchanged | Already compliant |
| **Cards** | `Card` throughout | unchanged | Already compliant |
| **Tables** | 3 raw `<table>` | **0** | Plus `scope="col"` |
| **Badges** | `Badge` throughout | unchanged | One tone corrected — `neutral` is not a platform tone; `muted` is |
| **Icons** | none | none | §10 — adopting them changes appearance |

**Hardcoded values: zero** — no hex, no `rgb()`, no arbitrary spacing or radius, across 164 source
files. One arbitrary value remains and is deliberate: `bg-[Canvas]` in the fullscreen preview, a CSS
system colour that matches the OS canvas and has no token equivalent by definition.

Four inline `style` objects remain, all computing genuinely dynamic values — tree indent depth,
preview zoom. That is the correct use of the escape hatch.

---

## 8. Performance Report

| Metric | Value |
| --- | --- |
| **Generated CSS** | **61,384 bytes** |
| Shared first-load JS | **103 kB** across all 39 routes |
| Largest route | `/documents/[documentId]` — 11.4 kB route, 311 kB first load (the PDF viewer) |
| Typical workspace route | 236–248 kB |
| Auth routes | 181 kB — the shell is correctly absent |
| Provider tree | One: `ToastProvider`, `LocaleProvider`, React Query |
| Duplicated contexts | **None** |
| Duplicate dependency of anything platform-provided | **None** — no `radix`, `lucide`, `cmdk`, `clsx`, `echarts`, `tailwind-merge` in `apps/web` |

### On the CSS

The stylesheet grew from 21,882 bytes pre-Phase-19 to **61,384**. **That growth is not bloat — it is
the styling that was missing.** The three states, measured:

| `@munaxa/platform` direct dep | `@source` resolves | Stylesheet | Platform classes with no rule |
| --- | --- | --- | --- |
| no | yes | 21,882 B | 136 of 249 |
| yes | **no** | 23,575 B | 146 of 249 |
| yes | yes | **61,384 B** | **0** |

The middle row is why the sentinel list is documented as the weaker signal: with the package merely
linked, a handful of utilities reach the stylesheet by another route and every named sentinel
resolves — while 59% of the stylesheet is still absent.

Duplicated utilities: none detectable. Tailwind emits one rule per class regardless of use count.

### Tree shaking

The 118 unused platform components are **not** in the bundle — 103 kB shared across every route with
`ApprovalFlow`, `WorkflowCanvas`, `Kanban`, `Gantt`, `OrgChart` and `echarts` all available proves
per-route splitting is working. Adopting more platform components is therefore close to free in
bundle terms.

### Recommendations

1. **Do not chase CSS size.** It is correct now and was wrong when it was small.
2. **`/documents/[documentId]` at 311 kB** is the only outlier, and it is `pdfjs-dist`. Worth
   confirming the viewer is dynamically imported before treating it as a problem.
3. **Adopt more platform components freely** — the tree-shaking evidence says the cost is per-route.

---

## 9. Validation Report

Every gate, on the final commit. `NODE_AUTH_TOKEN` supplied the `read:packages` credential
`.npmrc` deliberately does not commit.

| Gate | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | **Clean** — 602 packages |
| `pnpm format:check` | **Clean** |
| `pnpm lint` | **Clean** — 0 errors, 5 warnings (all `consistent-type-imports`, all pre-existing) |
| `pnpm typecheck` | **Clean** — 13/13 |
| `pnpm test` | **Clean** — 614 API (+1 skipped), 164 domain, 26 contracts, **37 web**, 11 utils, 4 i18n, 2 worker |
| `pnpm build` | **Clean** — 9/9, 39 routes |
| **`pnpm verify:styles`** | **Clean** — 249 platform classes, all generated |
| `pnpm test:integration` | **Clean** — **578 tests across 33 files**, two real tenant databases |

The integration suite was run rather than skipped. Docker is unavailable in this environment but
PostgreSQL 16 and Redis are installed, so the CI job's procedure was reproduced directly: two tenant
databases created, `infra/sql/cluster/01-roles.sql` applied, `scripts/migrate-tenants.mjs` run
against the same `TENANT_CATALOGUE` shape, and `pnpm test:integration` through turbo.

### Regression checks the brief names

| Check | Result |
| --- | --- |
| Platform CSS generated correctly | **Verified** — 0 of 249 classes missing |
| No regression in generated stylesheet | **Verified** — the new guard is the standing check |
| No duplicated platform styling | **Verified** — no local theme, no duplicated dependency |
| No broken imports | **Verified** — typecheck 13/13 |
| No routing regressions | **Verified** — 39 routes build; no route file touched |
| No accessibility regressions | **Verified, with a caveat** — `scope="col"` gained, every accessible name preserved, five dead hovers fixed. But no automated a11y test exists, so this is a static reading (§6) |

### The guard, proved in both directions

| State | `pnpm build` | `pnpm verify:styles` |
| --- | --- | --- |
| `@source` correct | exit 0 | **exit 0** — 249 classes, all generated |
| `@source` broken | **exit 0** | **exit 1** — 146 of 249 missing, named |

The build succeeding while the guard fails is the entire point.

---

## 10. Remaining UI Backlog

Ordered by value. Nothing here is a defect; each is work this phase was scoped out of, or forbidden
from doing.

| # | Item | Size | Why it is not done |
| --- | --- | --- | --- |
| 1 | **Icons** — adopt `@munaxa/icons` across sidebar, row actions, document-type marks, status, empty states | 1–2 days | Part 6 says "maintain visual appearance". There are **zero** direct `lucide-react` imports to migrate — the part is satisfied as written and vacuous in effect. Adding icons where none exist is a visual change this phase may not make |
| 2 | **Automated accessibility test** — axe against rendered screens in CI | 2–3 days | The largest remaining hole. Every claim in §6 is a static reading, and Phase 19 proves static readings get skip links wrong |
| 3 | **`WorkspaceScreen` harness** — mirror `AdminScreen`, migrate 9 screens off bare headings | 1–2 days | 22 admin screens compose through one harness; the workspace screens have none. Mechanical once written |
| 4 | **Screen-level tests** — one render test per screen family, one asserting an affordance is hidden without its capability | 3–5 days | 21 of 37 web tests still assert pure helpers. The `capabilities` rule remains unenforced |
| 5 | **Platform enhancement: `FileManager` columns** | platform PR | §4. The capability exists in `DataGrid` one layer down and is not exposed |
| 6 | **Platform enhancement: `ApprovalFlow` quorum + cancelled** | platform PR | §5. Blocks adoption for every product with quorum rules |
| 7 | **`Breadcrumb` on folder navigation** | 0.5 day | A new affordance; changes appearance |
| 8 | **AR/RTL string sweep** — 36 of 164 files import `@edms/i18n` | 1–2 days | Direction is wired correctly; per-string coverage is unmeasured |
| 9 | **Confirm the PDF viewer is dynamically imported** | 1 hour | §8. The only route above 250 kB |
| 10 | **`NotificationMenu` / `OrganizationSwitcher` in the top bar** | 1 day | Both exported and unused; the product has notifications and is multi-tenant. Needs a design decision, not a migration |
| 11 | **`Skeleton` for loading states** | 0.5 day | `app/loading.tsx` exists; whether it should be skeletons is a design decision |

---

## 11. What this phase did not do

**It did not migrate `FileManager`, `ApprovalFlow` or `WorkflowCanvas`.** Each was assessed against
this product's actual contracts, and each fails on a specific, named field. The brief is explicit
that a missing platform capability is documented rather than worked around, and §§4–5 do that with
the type signatures the platform would need.

**It did not add icons.** Part 6 asks for direct `lucide-react` imports to be replaced. There are
none. Reporting that honestly is more useful than doing adjacent work the brief did not ask for and
its own constraint forbids.

**It did not touch business behaviour.** No route, API, schema, workflow, permission or audit rule
changed. The audit screen reads the same six filter keys from the same `FormData`; the timeline
renders the same verbatim action code and the same versioned digest.

**It did not remove the two remaining raw `<button>` elements.** A facet toggle with `aria-pressed`
and a link-styled definition opener are not DS buttons, and converting them changes appearance.

**It did not claim an accessibility pass.** §6 says what was verified statically and what was not
verified at all, and marks the automated test as the top remaining gap — because the one Phase 19
accessibility finding that this phase checked turned out to be wrong.
