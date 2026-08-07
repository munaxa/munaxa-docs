# Phase 19 — Shared Platform Compliance & Integration Audit

**Purpose:** verify that Munaxa Docs consumes the Munaxa Shared Platform rather than duplicating it,
and answer whether the web client is ready to be treated as finished.
**Scope:** every application, package, module and configuration file in this repository, and the
seven `@munaxa/*` packages it installs.
**Status:** point-in-time report. Not edited afterwards.
**Method:** full install, all five gates executed, platform internals read, and one build compared
against another. Every number below was measured.

---

## 0. Method

The platform installs from GitHub Packages with a `read:packages` credential that
[`.npmrc`](../../.npmrc) deliberately does not commit. This audit ran with the token the same file
names as CI's — `NODE_AUTH_TOKEN` — and therefore reached everything a Phase 19 audit needs to reach:

| Gate | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Clean — 602 packages |
| `pnpm format:check` | **Clean** |
| `pnpm lint` | **Clean** — 0 errors, 5 warnings (all `consistent-type-imports`, all pre-existing) |
| `pnpm typecheck` | **Clean** — 13/13 |
| `pnpm test` | **Clean** — 614 API (+1 skipped), 164 domain, 26 contracts, 21 web, 11 utils, 4 i18n, 2 worker |
| `pnpm build` | **Clean** — 9/9, 37 static pages |

Every figure matches [Phase 18](./phase-18-production-readiness.md) §14 exactly. Eighteen phases of
gates still hold.

`pnpm test:integration` was **not** run — it needs two live PostgreSQL tenant databases, and this
audit changed nothing it covers.

What made this audit worth running is that the platform's own `dist/` could be read. The findings in
[§5](#5-violations) and [§6](#6-platform-adoption--the-central-finding) are not inferences about what
the platform might contain. They are what it contains.

---

## 1. Executive summary

Munaxa Docs is a **disciplined platform consumer that had one silent, critical defect and one large
blind spot.** The defect is fixed in this commit and the fix is measured. The blind spot is the
subject of the report.

The disciplines that usually rot first are clean here, and cleaner than the first pass suggested.
**Zero hardcoded colours** across 164 web source files. No local theme. No local `components/ui/`.
No sibling-product import. No circular dependency. **Fifty-nine distinct symbols** imported from
`@munaxa/ui` across **60 files** — the application shell itself is composed from the platform's
`AppShell`, `Sidebar`, `TopBar`, `UserMenu` and `NavigationDrawer`, which is exactly right.

Then two findings that only an install could produce.

**The critical one: the design system was shipping with roughly half its styling missing, and every
gate was green.** `globals.css` pointed Tailwind's `@source` at
`node_modules/@munaxa/platform/dist` — a path pnpm does not create, because `@munaxa/platform` was a
transitive dependency and `.npmrc` sets `shamefully-hoist=false`. Measured: **136 of 249 platform
utility classes generated no CSS rule at all**, and all 136 were classes the product never writes
itself — `bg-card`, `bg-primary`, `bg-background`, `border-primary`, every surface and brand colour
the platform's own components declare. Declaring `@munaxa/platform` as a direct dependency takes the
built stylesheet from **21,882 to 61,505 bytes** and the missing classes from **136 to 0**. Nothing
in CI could have caught this: it is not a type error, not a lint error, not a test failure and not a
build failure. It is a stylesheet that is silently 64% too small.

**The large one: Munaxa Docs uses 54 of the platform's 180 exported components.** Some of the other
126 are irrelevant to an EDMS — `Gantt`, `Kanban`, `OrgChart`. Many are not. The platform exports
`Table`, `THead`, `TBody`, `TR`, `TH`, `TD` and this product renders raw `<table>` in two screens. It
exports `Timeline` and `TimelineItem`; this product hand-rolled `audit-timeline.tsx` from `Card` and
`Badge`. It exports `ApprovalFlow`, and Phase 4 built an approval panel without it. It exports
`FileManager` — in a document management system that did not import it. Also unused: `Breadcrumb`,
`Tabs`, `Skeleton`, `DatePicker`, `SearchBuilder`, `FilterBuilder`, `Stepper`, `WorkflowCanvas`, and
`SkipLink`, whose absence is an accessibility defect.

Development recommendations §4 states the rule this breaks, and states it first in the table:
*"**Search before you create.** Say what you searched for and what you found — the platform already
has the dropzone, file manager, data grid and approval flow."* The dropzone and data grid were
found. The file manager and approval flow were not.

**Verdict: compliant in architecture, incomplete in adoption. Not ready to be called finished.**
See [§12](#12-verdict).

---

## 2. Overall platform compliance score

# 81 / 100

Measured across all categories in [§3](#3-compliance-score-by-category) that the platform makes
scorable, and reflecting the repository **after** the V-1 fix in this commit. Before it, the same
scoring gives **68** — the difference is one line in one `package.json`.

---

## 3. Compliance score by category

| # | Category | Score | Measured basis |
| --- | --- | --- | --- |
| 1 | Design system — components | 70 | 59 symbols across 60 files; but 54/180 platform components adopted, and 6 raw controls in 5 files |
| 2 | Design tokens | 96 | Zero hex/`rgb()`; zero arbitrary `[Npx]`/`[Nrem]`; 4 inline styles, all computed values |
| 3 | Theme | 95 | One `@import`; no local theme; `useTheme` from the platform. Was 40 before V-1's fix |
| 4 | Typography | 88 | `@munaxa/platform/typography` exists and is reached through `@munaxa/ui`; no local type scale. `@munaxa/typography` as a standalone package does not exist (V-5) |
| 5 | Icons | 15 | The full lucide set is re-exported and **imported zero times**; zero inline `<svg>` (V-3) |
| 6 | Layout system | 62 | `AppShell`/`Sidebar`/`TopBar` correct; `Page`/`PageHeader` in 4 files only; `Breadcrumb`, `Tabs`, `Container`, `Surface`, `Split` unused (V-2) |
| 7–11 | Auth, RBAC, audit, logging, notifications | — | **Out of scope.** No such platform package exists — see [§4](#4-the-brief-audits-against-packages-that-do-not-exist) |
| 12 | Shared types | 92 | `@edms/contracts` single surface; no duplicated DTO or enum found |
| 13 | Shared utilities | 80 | `@edms/utils` is 5 modules; 3 are promotion candidates (§7) |
| 14 | Infrastructure | 95 | Port/adapter throughout; no direct coupling |
| 15 | API conventions | 90 | Uniform shape across 17 modules |
| 16 | Package compliance | 95 | Clean direction, no cycles |
| 17 | Dependency compliance | 78 | `@munaxa/platform` now direct (fixed); `@munaxa/icons` still unused; no duplicate of anything platform provides |
| 18 | Code duplication | 76 | Was 94 before the platform could be read. `Table`, `Timeline`, `ApprovalFlow` are duplicated by hand (V-8) |
| 20 | Architecture compliance | 100 | No reverse dependency, no sibling-product import |
| 21 | Performance | 88 | 103 kB shared first-load JS; one provider tree; no duplicated contexts |
| 22 | Security | 90 | Phase 18's gates hold; `noopener,noreferrer` correct; no `dangerouslySetInnerHTML` |
| 23 | Upgrade readiness | 85 | Caret ranges throughout; V-1's fix removes a hoisting dependency that a platform release could have broken |

Logging scores 98 on its own measurement — 4 `console.*` in non-test code, each commented and
deliberate — but is folded into the out-of-scope block above, since the brief scores it against a
platform logger that does not exist.

---

## 4. The brief audits against packages that do not exist

The Phase 19 brief asserts the Platform is the source of truth for **authentication, authorization,
RBAC, audit, logging, notifications, shared SDK, shared services and shared infrastructure**, and
calls any local implementation a violation.

That cannot be followed here. The complete set of `@munaxa/*` packages in the registry is:

```text
@munaxa/platform   @munaxa/ui      @munaxa/theme   @munaxa/tokens
@munaxa/icons      @munaxa/config-eslint           @munaxa/config-typescript
```

**Seven packages: design system, plus lint and TypeScript configuration.** `@munaxa/platform/dist`
contains `ui/`, `icons/`, `themes/`, `tokens/`, `typography/` and nothing else. There is no
`@munaxa/auth`, no `@munaxa/audit`, no `@munaxa/logger`, no `@munaxa/notifications`, no
`@munaxa/sdk`. Brief sections 7–11 audit against packages that were never published.

[`ARCHITECTURE.md`](../../ARCHITECTURE.md) drew the same boundary first and in one line: this
repository owns *"business logic, the API, the database … permissions, workflows"*, and does not own
*"the design system."*

**The brief was written for Munaxa Work and copied here** — twelve occurrences of the name and a
reference to "HR/business-domain logic" in a document-control product. It is retargeted in this
commit. But renaming the product does not create an auth package.

So this audit scores 1–6 and 12–23, and records 7–11 as out of scope with the reason. Munaxa Docs'
identity, RBAC, ACL, audit trail and notifications are not violations. The hash-chained trail with
signed daily checkpoints is the compliance evidence an EDMS exists to produce; it could not become a
generic platform package without becoming a different thing.

---

## 5. Violations

### Critical

#### V-1 — the design system was shipping with half its styling missing — **CONFIRMED, FIXED, MEASURED**

[`apps/web/src/app/globals.css:3`](../../apps/web/src/app/globals.css)

```css
@source '../../node_modules/@munaxa/platform/dist';
```

`@munaxa/platform` was not a dependency of `@edms/web` — the app declared `ui`, `theme`, `tokens`
and `icons`, and `platform` sat one level below all four. With `shamefully-hoist=false` in
`.npmrc`, pnpm links only declared dependencies. Verified after a clean install:

```text
apps/web/node_modules/@munaxa/ → config-eslint  config-typescript  icons  theme  tokens  ui
apps/web/node_modules/@munaxa/platform → does not exist
```

Tailwind scanned nothing at that path. Measured against the built stylesheet, sampling 249 utility
classes that appear in `className` strings inside the platform's compiled components:

| | Before | After |
| --- | --- | --- |
| Platform classes with **no CSS rule** | **136 of 249** | **0** |
| …of those, classes the product never writes itself | **136** | — |
| Built stylesheet | 21,882 bytes | **61,505 bytes** |

All 136 were platform-only, so nothing masked them. They include `bg-card`, `bg-background`,
`bg-primary`, `bg-primary-strong/40`, `border-primary`, `border-border/60`, `backdrop-blur-xs`,
`fill-border`, `disabled:cursor-not-allowed` and `[&>div:first-child]:sr-only` — the surfaces, the
brand colours, the disabled affordances and one screen-reader rule. Platform components were
rendering with their structure, their spacing and **none of their colour**.

**The fix is one line** — declare `@munaxa/platform` in `apps/web/package.json`. The lockfile diff is
**three lines** at the identical resolution already pinned for the transitive edge, so no new code
enters the tree; an existing edge becomes direct, and the `@source` path becomes true by
construction rather than by hoisting luck.

**Why no gate caught it, which is the part worth keeping:** this is not a type error, a lint error, a
test failure or a build failure. `pnpm build` succeeded, emitted 37 static pages and reported a
healthy 103 kB shared bundle while the stylesheet was 64% too small. **The only signal was visual,
and nothing in this repository looks.** That is the argument for V-7 in one sentence.

### High

#### V-2 — the workspace surface does not use the platform's page layout

`PageHeader` appears in exactly four files: `admin-shared/screen.tsx`, `admin-shared/overview.tsx`,
`admin-workflows/versions-screen.tsx`, `dashboard/dashboard-screen.tsx`.

The twenty-two admin screens are right: they compose through `AdminScreen`, which supplies `Page`,
`PageHeader` and `Stack` once for all of them — which is why those files contain zero `className`
occurrences. They say what the screen is and inherit how it looks.

The workspace screens have no such harness. `documents`, `search`, `approvals`, `audit`, `reports`,
`notifications`, `delegations`, `recycle-bin`, `permissions` and `revisions` render **nineteen bare
`<h1>`/`<h2>`/`<h3>` elements across ten files** where the platform has a component. Title
typography, description placement and spacing are decided by hand, ten times.

`Breadcrumb` is also unused — in a product whose central navigation is libraries containing folders
containing documents.

**Fix:** a `WorkspaceScreen` harness mirroring `AdminScreen`, then a mechanical migration.

#### V-3 — `@munaxa/icons` is declared and imported zero times

`apps/web/package.json:21` declares it. Imports in `apps/web/src`: **zero**. `<svg>` elements:
**zero**.

Reading the package settles what is available:

```ts
/** Icons — the single icon source for every AXA product. */
export * from 'lucide-react';
```

The entire lucide set, at one version, already installed. So the product ships **no icons at all** —
no sidebar glyphs, no row actions, no document-type marks, no status indicators, no empty-state
illustration — while depending on a package that would give it all of them with an import.

This is the single largest gap between what this UI is and what it needs to be, and the cheapest to
close.

#### V-8 — components the platform exports are duplicated by hand

Only readable once the platform was installed. Each of these is exported by `@munaxa/platform` and
used zero times by Munaxa Docs:

| Platform component | What the product built instead |
| --- | --- |
| `Table`, `THead`, `TBody`, `TR`, `TH`, `TD` | Raw `<table>` in `permissions-screen.tsx` (×2) and `reports-screen.tsx` |
| `Timeline`, `TimelineItem` | `audit-timeline.tsx`, 124 lines of `Card` and `Badge` |
| `ApprovalFlow` | `approval-panel.tsx` |
| `FileManager` | `library-screen.tsx` / `folder-tree.tsx` |
| `SearchBuilder`, `FilterBuilder` | Hand-rolled facets in `search-screen.tsx` |
| `DatePicker`, `DateRangePicker` | Raw `<input>` date filters in `audit-screen.tsx` |
| `WorkflowCanvas` | `admin-workflows/versions-screen.tsx` |
| `Stepper`, `Tabs`, `Skeleton`, `Separator`, `Label`, `Tooltip`, `Popover`, `Drawer`, `Avatar`, `ScrollArea`, `Calendar` | Ad-hoc markup, or the affordance is simply absent |

Development recommendations §4 anticipated exactly this, naming four platform components by name.
Two of the four — `Dropzone` and `DataGrid` — *are* used. The other two, `FileManager` and
`ApprovalFlow`, are not. The rule was followed unevenly rather than ignored.

**This is not a demand to rewrite ten screens.** Some hand-rolled implementations may encode
document-control behaviour the generic component cannot. But each of the rows above is currently an
undocumented decision, and the brief's own instruction covers it: *"If a local implementation exists
because the Platform lacks an equivalent, document it as a gap instead of forcing an incorrect
migration."* Right now neither the migration nor the documented gap exists.

#### V-9 — `SkipLink` is exported and unused

An accessibility defect rather than a styling one, and separated from V-8 for that reason. The
platform exports a skip link; the workspace shell — a persistent sidebar with a long navigation list
in front of every page's content — does not use it. Keyboard and screen-reader users tab the whole
navigation on every route.

### Medium

#### V-4 — `audit-screen.tsx` renders unstyled native controls

[`apps/web/src/features/audit/audit-screen.tsx:96-125`](../../apps/web/src/features/audit/audit-screen.tsx)

```tsx
<h1>{translate('audit.title')}</h1>
<p>{translate('audit.subtitle')}</p>
…
<label>
  {translate('audit.filter.action')}
  <select name="action" defaultValue={value('action')}>
```

No `className`, no `Field`, no `Select`, no `Input`, no `PageHeader` — on the screen a compliance
officer uses to answer an auditor. The file already imports `Badge`, `Button`, `Card` and `useToast`
from `@munaxa/ui`, so this is not ignorance of the design system; it is one screen finished to a
different standard than its neighbours. `admin-shared/fields.tsx` already exports the `SelectField`
and `TextField` it needs.

Note `fields.tsx:179` documents a *deliberate* native `<select>`, with a sound reason — short closed
lists, native mobile keyboards, assistive-technology support. That reasoning does not carry to
`audit-screen.tsx`, where the control has no label association, no styling and no field wrapper.

#### V-5 — `ARCHITECTURE.md` named two packages that do not exist

The table directed readers to `@munaxa/typography` and `@munaxa/utils`. Neither is published. The
rule below it — *"If something shared is missing, add it to munaxa-platform — never rebuild it
here"* — was unactionable for both rows.

Typography does exist, at `@munaxa/platform/dist/typography`, reached through `@munaxa/ui`; it is
the standalone package that does not. Shared helpers have no home at all.

**Fixed in this commit**, documentation-only: both rows now state their real status.

### Low

#### V-6 — one arbitrary Tailwind value bypasses the token utility

`features/search/search-screen.tsx:424` uses `hover:bg-[var(--color-surface-hover)]`. It reads a
platform token, so nothing is hardcoded — but it reaches through the arbitrary-value escape hatch.
It is the only such construct in the codebase, and worth noting that under V-1 it was one of the
few hover states that *did* render, because the product's own source is what Tailwind was scanning.

#### V-7 — web test coverage is the product's thinnest layer, and V-1 is what that costs

| Suite | Tests |
| --- | --- |
| API | 614 |
| Integration | 578 across 33 files |
| Domain | 164 |
| Contracts | 26 |
| **Web** | **21, from 2 files** |

Two spec files, both testing pure helpers, for 164 source files. **No test renders a screen,
exercises a server action, or asserts an affordance against `capabilities`** — which development
recommendations §4 makes a standing rule: *"every affordance reads `capabilities`; the UI must never
decide access."* `capabilities` appears in three files; whether the rule holds in the other 161 is
unknown, and nothing would notice if it stopped.

Filed Low severity because nothing is known to be broken, and **High risk** because V-1 is precisely
what this gap costs: a critical, user-visible defect that lived through five green gates and an
entire phase because no check ever looked at a rendered page.

---

## 6. Platform adoption — the central finding

| | Count |
| --- | --- |
| Components exported by `@munaxa/platform` | **180** |
| Used by Munaxa Docs | **54** |
| Unused | **126** |

Adoption is not a number to maximise — `Gantt`, `Kanban`, `OrgChart`, `CountUp` and `Reveal` have no
place in an EDMS, and not importing them is correct. The finding is *which* unused components map
onto screens this product already built by hand, and that list is [V-8](#v-8--components-the-platform-exports-are-duplicated-by-hand).

The 54 that are used are used well: the shell is `AppShell` + `Sidebar` + `TopBar` + `UserMenu` +
`NavigationDrawer`, the admin harness is `Page` + `PageHeader` + `Stack`, lists are `DataGrid` +
`Pagination`, uploads are `Dropzone`, charts are `BarChart` + `LineChart` from `@munaxa/ui/charts`.
The product knows how to consume the platform. It did so unevenly.

---

## 7. Duplication report

| Looked for | Found |
| --- | --- |
| Local `components/ui/`, copied primitives | **None.** `apps/web/src/components/` holds one file, an app shell composed from platform parts |
| Local theme provider or palette | **None.** One `@import`; `useTheme` from `@munaxa/ui` |
| Local design tokens | **None.** Zero hex, zero `rgb()`, zero arbitrary sizing |
| Local icon wrapper | **None** — and no icons either (V-3) |
| Local logger | **None.** 4 `console.*` in non-test code, each commented |
| Duplicated DTOs / enums | **None.** `@edms/contracts` is the single surface |
| Duplicated npm dependency of anything platform provides | **None.** No `radix`, `lucide`, `cmdk`, `clsx`, `echarts` or `tailwind-merge` in `apps/web` — all reach it through `@munaxa/platform` |
| Sibling-product import (`@school/*`, `@work/*`) | **None.** CI's `boundaries` job enforces it |
| Reverse dependency (platform → docs) | **None** |
| Circular package dependency | **None** |
| **Hand-built equivalents of platform components** | **Nine.** See V-8 — the one category that only an install could reveal |

---

## 8. What should move to the platform

Per the brief, **nothing was moved.** These are proposals.

| Candidate | Why generic | Impact | Migration |
| --- | --- | --- | --- |
| **`admin-shared/` harness** (13 files: `AdminScreen`, `ResourceList`, `FormDialog`, `fields`, `columns`, `patch`, `use-action`, `section-nav`, `list-url`) | A list → filter → paginate → dialog-edit → PATCH loop with optimistic-concurrency handling, containing no document-control concept. Every Munaxa product has an admin area of this shape, and this one drives 22 screens on zero `className`s | **Highest.** The platform has `DataGrid` but nothing above it; this is the missing tier | Extract as `@munaxa/admin-kit` with the resource type as a generic parameter. Docs adopts first and proves the seam |
| **`@edms/utils` — `pagination`, `text`, `uuid`** | Keyset pagination, Arabic-aware text normalisation, UUID helpers. The package's own header says anything with domain meaning belongs to a module's domain layer — by that rule these three are in the wrong repository | Medium. Arabic normalisation especially: every Arabic-locale Munaxa product must get it identically right | Into `@munaxa/utils`, which V-5 shows does not exist. This is its first justified content |
| **`list-state` / `list-url`** | URL-as-query-state, applied here to documents, audit and search alike. Product-neutral | Medium | Fold into `@munaxa/admin-kit` |
| **i18n RTL direction mapping** | `TEXT_DIRECTION[locale]` at `app/layout.tsx:37`. Every Munaxa product serving Arabic needs the identical mapping | Low, high consistency value | Into `@munaxa/theme`, beside the locale provider |

Explicitly **not** candidates: the ACL resolver, workflow evaluation, numbering, retention
arithmetic, the audit chain. Each is a document-control rule, and Phase 0 placed each in the domain
layer for that reason.

---

## 9. Package dependency analysis

```text
@munaxa/platform ──► @munaxa/{ui,theme,tokens,icons} ──► apps/web
                                                          ▲
@edms/{domain,contracts,utils,i18n} ──────────────────────┘──► apps/{api,worker}
```

No cycles. No app imported by a package. No sibling product anywhere.

| Finding | Detail |
| --- | --- |
| **Fixed** | `@munaxa/platform` is now a direct dependency of `@edms/web` (V-1). 3-line lockfile diff, same resolution |
| **Unused dependency** | `@munaxa/icons` — zero imports (V-3). Left in place; the fix is to *use* it |
| **Documented, unpublished** | `@munaxa/utils` (V-5). Typography exists inside `@munaxa/platform` |
| Version ranges | Caret throughout for `@munaxa/*` — a minor platform release reaches this product with no code change, satisfying brief §23 |
| `onlyBuiltDependencies` | Allowlisted at the root — a supply-chain control worth keeping |
| Duplicate of a platform-provided dependency | **None found** |

---

## 10. Security and performance observations

**Security.** Phase 18's boot gates stand unchanged. Two web-surface notes:

- `window.open(link.url, '_blank', 'noopener,noreferrer')` in `audit-screen.tsx:91` — correct, and
  worth naming because reverse tabnabbing on a *signed evidence link* is a compliance incident, not
  merely a bug.
- No `dangerouslySetInnerHTML` anywhere in `apps/web`.

**Performance**, now measured rather than deferred:

| Metric | Value |
| --- | --- |
| Shared first-load JS | **103 kB** across all 37 routes |
| Largest route | `/documents/[documentId]` — 11.3 kB route, 311 kB first load (the PDF viewer) |
| Typical workspace route | 236–248 kB first load |
| Auth routes | 181 kB — the shell is correctly absent |
| Stylesheet | 61,505 bytes after V-1's fix (was 21,882) |
| Provider tree | One — `ToastProvider`, `LocaleProvider`, React Query. No duplicated context |

The bundle is healthy. The stylesheet growth is not bloat; it is the styling that was missing.

---

## 11. Remediation plan

Items 1 and 2 of the previous plan are **done** — the install ran, the gates are green, and V-1 is
fixed and measured.

| # | Item | Sev | Effort | Why here |
| --- | --- | --- | --- | --- |
| ~~1~~ | ~~Verify and fix V-1~~ | Critical | — | **Done in this commit.** 136 missing classes → 0 |
| ~~2~~ | ~~Run the five gates~~ | — | — | **Done.** All clean, matching Phase 18 exactly |
| 3 | **Adopt icons (V-3)** | High | 1–2 days | The largest visible gap and the cheapest. The full lucide set is installed and one import away |
| 4 | **Triage V-8's nine components** | High | 1 day to decide | For each: adopt, or write down why the local one stays. Cheap, and it converts nine undocumented decisions into a decision |
| 5 | **`WorkspaceScreen` harness, migrate 10 screens (V-2)** | High | 1–2 days | Closes the admin/workspace split. Mechanical once the harness exists |
| 6 | **`SkipLink` (V-9)** | High | 30 min | Accessibility, one component, one insertion point |
| 7 | **Rebuild `audit-screen.tsx` (V-4)** | Med | 2 hours | Small, isolated, on a screen an auditor sees |
| 8 | **Web test floor (V-7)** | Low sev / **High risk** | 3–5 days | One render test per screen family; one asserting an affordance is hidden without its capability; **and one asserting the stylesheet contains a platform-only class** — that last one is a regression test for V-1 and costs an hour |
| 9 | **Publish `@munaxa/utils` (V-5)** | Med | 1 day | Doc half done in this commit |
| 10 | **AR/RTL sweep** — 36 of 164 files import `@edms/i18n` | Med | 1–2 days | RTL is wired at the root and `dir="auto"` used correctly, but per-string coverage is unmeasured |
| 11 | **Confirm federation/SIEM UI is deliberately absent** | Low | 1 hour | Zero hits for `federat`/`siem` in `apps/web` though Phase 17 shipped both. Config-only by design — then write it down — or a hole |
| 12 | **V-6**, one arbitrary value | Low | 5 min | Trivial |

Items 3–7, 9 and 12 are about **one week**. Item 8 adds a second, and is the one that stops the next
V-1.

---

## 12. Verdict

**Munaxa Docs is architecturally compliant with the Munaxa Shared Platform and incomplete in its
adoption of it. It is not yet ready to be called finished.**

On architecture the product is clean, and cleanly so: zero hardcoded colours across 164 files, no
local theme, no copied component library, no duplicated platform dependency, no sibling-product
import, no reverse dependency, no cycle, and 59 platform symbols across 60 files. Eighteen phases of
gates still pass on the numbers Phase 18 recorded. The failure modes this architecture exists to
prevent did not occur.

What did occur is subtler and is the report's real content. **A one-line packaging omission removed
64% of the design system's stylesheet, and five green gates plus an entire production-readiness
phase did not notice**, because nothing in this repository ever looks at a rendered page. And when
the platform was finally read rather than assumed, it turned out to export a `Table`, a `Timeline`,
an `ApprovalFlow` and a `FileManager` that this product had each built by hand.

Both findings have the same root, and it is not carelessness — it is that **the UI has never been
verified, only compiled.**

On the question that prompted this audit — *should we start the UI?* — **no, and now for a firmer
reason than before.** The UI exists: 164 files, every route, a feature module for each of the
seventeen API modules including Phase 16's bulk operations, templates and signatures. Until this
commit it had also never rendered correctly, which means the honest description is not "the UI needs
building" but **"the UI has never actually been seen."**

Do the week: icons, the V-8 triage, one workspace harness, the skip link, the audit screen. Then do
the second week on the test floor — including the one-hour assertion that the built stylesheet
contains a platform-only class, which is the test that would have caught V-1 on the day it was
introduced.

---

## 13. What this phase did not do

**It did not refactor the ten workspace screens or the nine hand-built components.** The brief
permits refactoring "where safe and appropriate", and it also says to document a gap rather than
force an incorrect migration. Whether `ApprovalFlow` can express Phase 4's conditional stages, or
`FileManager` the confidentiality rules Phase 7 burns into a rendition, are questions with real
answers that this audit did not have time to establish. Migrating on the assumption that they can
would be the "incorrect migration" the brief warns against; item 4 exists to answer them first.

**It did not run `pnpm test:integration`.** It needs two live tenant databases, and nothing this
phase changed is covered by it.

**It did not remove `@munaxa/icons`** despite it being an unused dependency. Removing it is the wrong
correction to V-3 — the product needs icons, not one less dependency.

**It did not move anything to the platform.** Brief §19 says not to without an explicit request.

**It did not score sections 7–11.** They audit against `@munaxa/auth`, `@munaxa/audit`,
`@munaxa/logger` and `@munaxa/notifications`, none of which exist ([§4](#4-the-brief-audits-against-packages-that-do-not-exist)).

---

## 14. Changes made in this commit

| Change | Why |
| --- | --- |
| `apps/web/package.json` — `@munaxa/platform` added as a direct dependency; `pnpm-lock.yaml` +3 lines at the same resolution | **V-1.** Makes the `@source` path real. Measured: 136 ungenerated platform classes → 0; stylesheet 21,882 → 61,505 bytes |
| `prompts/docs prompts/Phase 19 …` retargeted from Munaxa Work to Munaxa Docs — 12 occurrences, plus "HR/business-domain logic" → "document-control business logic" | The brief was copied from the sibling product. A Docs specification that names Work is one a future reader has to second-guess ([§4](#4-the-brief-audits-against-packages-that-do-not-exist)) |
| `ARCHITECTURE.md` — the `@munaxa/typography` and `@munaxa/utils` rows now state their real status | **V-5.** The table promised two packages the registry does not have |
| This report | The Phase 19 deliverable. Every other phase has one |

No application source file was modified. All five gates pass after the change.
