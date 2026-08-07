# Phase 19 — Shared Platform Compliance & Integration Audit

**Purpose:** verify that Munaxa Docs consumes the Munaxa Shared Platform rather than duplicating it,
and answer whether the web client is ready to be treated as finished.
**Scope:** every application, package, module and configuration file in this repository.
**Status:** point-in-time report. Not edited afterwards.
**Method:** static audit. See [§0](#0-what-this-audit-could-and-could-not-run) — the platform
packages could not be installed in the audit environment, and every claim below states whether it
was verified against source or inferred from the lockfile.

---

## 0. What this audit could and could not run

`pnpm install --frozen-lockfile` fails in this environment:

```text
ERR_PNPM_FETCH_401  GET https://npm.pkg.github.com/download/@munaxa/ui/1.0.0/… — Unauthorized
```

That is [`.npmrc`](../../.npmrc) working as designed: the scope→registry mapping is committed, the
`read:packages` credential deliberately is not. The consequence for this audit is precise and worth
stating plainly rather than hiding behind a score:

| Gate | Could it run |
| --- | --- |
| `pnpm format:check`, `lint`, `typecheck`, `build`, `test` | **No** — no dependency tree |
| Source-level inspection of this repository | Yes |
| Dependency graph via `pnpm-lock.yaml` | Yes |
| Inspection of `@munaxa/*` **internals** | **No** — never downloaded |

So sections 1–6 below are verified against this repository's own source. Every claim about what the
platform *contains* is derived from `pnpm-lock.yaml` and is labelled as such. **No finding in this
report asserts the internal shape of a platform package.** Where a check needed one, it is recorded
as unverifiable rather than guessed — an audit that scores a package it never opened is worth less
than one that says which line it could not reach.

---

## 1. Executive summary

Munaxa Docs is a **strong platform consumer with one weak surface**. The mechanical disciplines that
are usually where products rot — hardcoded colour, a copied component library, a local theme, a
private logger — are not merely acceptable here, they are clean to a degree the audit did not
expect. There is **not one hex, `rgb()` or hard-coded colour value** in the entire web application.
There is **no local `components/ui/` directory** — the single file in `apps/web/src/components/` is
an application shell, not a primitive. Thirty-five distinct component and hook symbols are imported
from `@munaxa/ui` across sixty-three files.

The weakness is narrower and more interesting than "the UI needs work". It is that **the admin
surface and the workspace surface were built to two different standards**, and only one of them is
platform-composed. Twenty-two admin screens compose through a shared `AdminScreen` harness that
itself sits on the platform's `Page`, `PageHeader` and `Stack`. The workspace screens — documents,
search, approvals, audit, reports, notifications, delegations, recycle bin, permissions — largely do
not: they render bare `<h1>` and `<h2>` elements where a `PageHeader` exists, and one of them
(`audit-screen.tsx`) renders raw, entirely unstyled `<select>`, `<input>` and `<label>` markup.

Alongside that sit three findings that are not about taste at all. The Tailwind `@source` directive
that makes platform utility classes reachable **points at a path pnpm will not create**. A declared
dependency, `@munaxa/icons`, is **imported zero times** — the product ships with no icons from the
icon system it depends on, and no inline SVG either. And `ARCHITECTURE.md` directs the reader to two
packages, `@munaxa/typography` and `@munaxa/utils`, that **do not exist** in the registry.

**Verdict: conditionally compliant. Not ready to be called finished.** See [§12](#12-verdict).

---

## 2. Overall platform compliance score

# 78 / 100

Weighted by the categories in [§3](#3-compliance-score-by-category), excluding the four categories
the audit could not reach. A score computed over categories that could not be checked would be a
higher number and a less true one.

---

## 3. Compliance score by category

| # | Category | Score | Basis |
| --- | --- | --- | --- |
| 1 | Design system — components | 74 | 35 symbols from `@munaxa/ui`, no local primitives; 6 raw controls in 5 files |
| 2 | Design tokens | 96 | Zero hex/`rgb()`; zero arbitrary `[Npx]`/`[Nrem]`; 4 inline styles, all computed |
| 3 | Theme | 85 | Single `@import '@munaxa/theme/css/docs'`; no local theme — but see V-1 |
| 4 | Typography | — | **Unverifiable.** `@munaxa/typography` does not exist (V-5) |
| 5 | Icons | 20 | `@munaxa/icons` declared, **imported 0 times** (V-3) |
| 6 | Layout system | 55 | `Page`/`PageHeader` in 4 files; absent from every workspace screen (V-2) |
| 7 | Authentication | — | **Out of scope.** No platform auth package exists — see §4 |
| 8 | Authorization | — | Same. Local RBAC/ACL is by design, not duplication |
| 9 | Audit framework | — | Same. The hash-chained trail is this product's compliance core |
| 10 | Logging | 98 | 4 `console.*` in non-test code, each deliberate and commented |
| 11 | Notifications | — | Same as 7–9. Local by design |
| 12 | Shared types | 92 | `@edms/contracts` + `@edms/domain`; no duplication found |
| 13 | Shared utilities | 80 | `@edms/utils` is 5 modules; 3 are promotion candidates (§7) |
| 14 | Infrastructure | 95 | Port/adapter throughout; no direct coupling found |
| 15 | API conventions | 90 | Uniform module shape across 17 modules |
| 16 | Package compliance | 95 | Clean direction, no cycles found |
| 17 | Dependency compliance | 70 | One unused dependency; one missing one (V-1, V-3) |
| 18 | Code duplication | 94 | No duplicated platform functionality found |
| 20 | Architecture compliance | 100 | No reverse dependency; no sibling-product import |
| 21 | Performance | 85 | One provider tree, no duplicated contexts; bundle unmeasurable |
| 22 | Security | 88 | Inherited from Phase 18's gates; `noopener,noreferrer` used correctly |
| 23 | Upgrade readiness | 72 | Caret ranges throughout — but V-1 makes the next upgrade risky |

Category 19 (platform extension opportunities) is not a score; it is [§7](#7-what-should-move-to-the-platform).

---

## 4. The framing problem in the brief, and how this audit resolved it

The Phase 19 brief as written asserts that the Platform is the source of truth for **authentication,
authorization, RBAC, permissions, audit, logging, notifications, shared SDK, shared services and
shared infrastructure**, and instructs that a local implementation of any of them "without a
justified reason" is a compliance violation.

That instruction cannot be followed here, for a reason that is a fact about the registry rather than
a judgement about the code. The complete set of `@munaxa/*` packages resolved in `pnpm-lock.yaml` is:

```text
@munaxa/platform          @munaxa/ui        @munaxa/theme    @munaxa/tokens
@munaxa/icons             @munaxa/config-eslint              @munaxa/config-typescript
```

**Seven packages. All of them are design system, or lint and TypeScript configuration.** There is no
`@munaxa/auth`, no `@munaxa/audit`, no `@munaxa/logger`, no `@munaxa/notifications`, no
`@munaxa/sdk`. Brief sections 7 through 14 and 22 therefore audit against packages that do not
exist.

This repository's own [`ARCHITECTURE.md`](../../ARCHITECTURE.md) says the same thing from the other
direction, and says it first: *"What this repository owns: business logic, the API, the database and
its Prisma schema and migrations, routing, domain models, permissions, workflows"* — and *"what it
does not own: the design system."* One line, one boundary.

**The brief was written for Munaxa Work and copied to this product** — twelve occurrences of "Munaxa
Work" and a reference to "HR/business-domain logic" in a document-control product. It has been
retargeted to Munaxa Docs in this commit. But retargeting the noun does not make the platform
contain an auth package.

So this audit scores sections 1–6 and 12–23 as written, and **records 7–11 as out of scope with the
reason**. Munaxa Docs' local identity, RBAC, ACL, audit and notification implementations are not
compliance violations. They are the product. The hash-chained audit trail with signed daily
checkpoints is the *compliance evidence* an EDMS exists to produce; it could not be a generic
platform package without becoming a different thing.

That is the honest reading, and it is the one `ARCHITECTURE.md` already took.

---

## 5. Violations

Severity is by consequence, not by size.

### Critical

None. No reverse dependency, no sibling-product import, no copied component library, no local theme,
no hardcoded colour. The failure modes this architecture was built to prevent did not occur.

### High

#### V-1 — the Tailwind `@source` path points where pnpm will not link

[`apps/web/src/app/globals.css:3`](../../apps/web/src/app/globals.css)

```css
@source '../../node_modules/@munaxa/platform/dist';
```

Resolved from `apps/web/src/app/`, that is `apps/web/node_modules/@munaxa/platform/dist`.

`@munaxa/platform` is **not a dependency of `@edms/web`.** `apps/web/package.json` declares `ui`,
`theme`, `tokens` and `icons`; the lockfile shows `platform` as a *transitive* dependency of all
four. And [`.npmrc`](../../.npmrc) sets `shamefully-hoist=false`, so pnpm symlinks only declared
dependencies into a package's own `node_modules`.

The consequence, if it lands: Tailwind scans nothing at that path, the utility classes baked into
the platform's compiled components are never generated, and every platform component renders with
its structure and none of its styling. That is not a subtle regression — it is the design system
appearing to be absent.

This finding is **High rather than Critical because it could not be confirmed**: confirming it
requires an install, and the install returns 401. Three outcomes are possible and only one is
benign — Tailwind v4 may resolve `@source` through the importing package's resolution rather than
the literal filesystem path, in which case this is a non-issue and should be recorded as one.

**Fix:** declare `@munaxa/platform` as an explicit dependency of `@edms/web`. It is already pinned
in the lockfile at the exact same resolution, so this adds no new code to the tree — it makes an
existing transitive edge direct, and it makes the `@source` path true by construction rather than
by hoisting luck.

**Not applied in this commit,** and deliberately: editing `dependencies` requires a matching
`pnpm-lock.yaml` regeneration, `pnpm install` cannot run here, and CI runs `--frozen-lockfile`. A
hand-edited lockfile is a worse defect than the one it fixes. This is the first item in the
remediation plan and needs an environment with a `read:packages` token — about ten minutes there.

#### V-2 — the workspace surface does not use the platform's page layout

`PageHeader` appears in exactly four files: `admin-shared/screen.tsx`, `admin-shared/overview.tsx`,
`admin-workflows/versions-screen.tsx`, `dashboard/dashboard-screen.tsx`.

The twenty-two admin screens are fine — they compose through `AdminScreen`, which supplies `Page`,
`PageHeader` and `Stack` once for all of them. That is exactly right, and it is why those files
contain zero `className` occurrences: they describe *what* the screen is and inherit *how* it looks.

The workspace screens have no such harness. `documents`, `search`, `approvals`, `audit`, `reports`,
`notifications`, `delegations`, `recycle-bin`, `permissions` and `revisions` each render bare
heading elements — nineteen `<h1>`/`<h2>`/`<h3>` tags across ten files — where the platform has a
component. Page title typography, description placement and spacing are therefore decided
per-screen, by hand, ten times.

Two users of this product will see two different applications depending on whether they administer
it or use it. That is the finding.

**Fix:** a `WorkspaceScreen` harness mirroring `AdminScreen` — one file, then a mechanical migration
of ten screens.

#### V-3 — `@munaxa/icons` is declared and never imported

`apps/web/package.json:21` declares `"@munaxa/icons": "^1.0.0"`. Occurrences of `@munaxa/icons` in
`apps/web/src`: **zero**. Occurrences of `<svg` in `apps/web/src`: **zero**.

So this is not "the product uses the wrong icons." The product uses **no icons at all** — no
sidebar glyphs, no row actions, no status marks, no empty-state illustration, in a document system
whose primary list is rows of files of differing types and states.

This is simultaneously an unused-dependency finding (brief §17), a design-system-adoption finding
(§5), and the single largest gap between what this UI is and what it will need to be. The lockfile
shows the platform bundles `lucide-react`, so an icon set is present and reachable.

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
officer uses to answer an auditor. The file imports `Badge`, `Button`, `Card` and `useToast` from
`@munaxa/ui`, so this is not ignorance of the design system; it is one screen finished to a
different standard than its neighbours. The repository already contains the right components:
`admin-shared/fields.tsx` exports `SelectField` and `TextField` built on the platform's `Field`.

Note that `fields.tsx:179` documents a *deliberate* native `<select>`, with a defensible reason
(short closed lists, native mobile keyboards, assistive-technology support). That reasoning does not
extend to `audit-screen.tsx`, where the control carries no label association, no styling and no
shared field wrapper.

#### V-5 — `ARCHITECTURE.md` directs the reader to two packages that do not exist

The "what it does not own" table names `@munaxa/typography` for typography and `@munaxa/utils` for
shared helpers. Neither appears in `pnpm-lock.yaml`; neither is a dependency of any workspace
package; neither is published.

The rule immediately below the table — *"If something shared is missing, add it to munaxa-platform —
never rebuild it here"* — is therefore unactionable for both rows. A reader who follows it looks for
a package, does not find it, and has to decide alone whether to wait or to build locally. That is
precisely the decision the document exists to remove.

**Fixed in this commit**, documentation-only: the two rows are marked as not yet published, so the
table describes the registry as it is.

### Low

#### V-6 — one arbitrary Tailwind value bypasses the token utility

`features/search/search-screen.tsx:424` uses `hover:bg-[var(--color-surface-hover)]`. It reads a
platform token, so no value is hardcoded and the finding is cosmetic — but it reaches through the
arbitrary-value escape hatch to a variable the platform presumably also exposes as a utility. It is
the only such construct in the codebase.

#### V-7 — web test coverage is the product's thinnest layer by a wide margin

| Suite | Tests |
| --- | --- |
| API | 614 |
| Integration | 578 across 33 files |
| Domain | 164 |
| Contracts | 26 |
| **Web** | **21, from 2 files** |

Two spec files — `admin-shared/patch.spec.ts` and `lib/admin/list-state.spec.ts` — for 164 source
files. Both test pure helpers. **No test renders a screen, exercises a server action, or asserts an
affordance against `capabilities`.**

That last one matters more than the count. Development recommendations §4 makes it a standing rule:
*"every affordance reads `capabilities`; the UI must never decide access."* `capabilities` appears
in three files. Whether the rule holds across the other 161 is currently unknown, and nothing in CI
would notice if it stopped holding.

This is Low severity because it is not a defect — nothing is known to be broken. It is High risk,
which is a different axis, and it is the reason [§12](#12-verdict) does not sign the UI off.

---

## 6. Duplication report

Searched for local reimplementation of every capability the platform publishes.

| Looked for | Found |
| --- | --- |
| Local `components/ui/`, copied primitives | **None.** `apps/web/src/components/` holds one file, an app shell |
| Local theme provider or palette | **None.** One `@import`; `useTheme` comes from `@munaxa/ui` |
| Local design tokens | **None.** Zero hex, zero `rgb()`, zero arbitrary sizing |
| Local icon wrapper | **None** — and no icons either (V-3) |
| Local logger | **None.** 4 `console.*` in non-test code, each commented and deliberate |
| Duplicated DTOs / enums | **None.** `@edms/contracts` is the single request/response surface |
| Duplicated utilities | **None** within the repo; 3 promotion candidates in §7 |
| Sibling-product import (`@school/*`, `@work/*`) | **None.** CI's `boundaries` job enforces it |
| Reverse dependency (platform → docs) | **None** |
| Circular package dependency | **None** |

Raw HTML controls, the closest thing to duplication found — 3 `<button>`, 6 `<select>`, 3 `<table>`,
22 `<input>` — are enumerated in V-2 and V-4. Two of the three `<button>`s (a theme toggle, a facet
filter, a report link) are one-off interactive elements, not a reimplemented Button component.

---

## 7. What should move to the platform

Candidates by genericity. Per the brief, **nothing was moved** — these are proposals.

| Candidate | Why generic | Impact | Migration |
| --- | --- | --- | --- |
| **`admin-shared/` harness** (13 files: `AdminScreen`, `ResourceList`, `FormDialog`, `fields`, `columns`, `patch`, `use-action`, `section-nav`, `list-url`) | A list → filter → paginate → dialog-edit → PATCH loop with optimistic-concurrency handling. Contains no document-control concept. Every Munaxa product has an admin area that is this shape | **Highest.** Removes ~22 screens' worth of scaffolding from every product that adopts it | Extract to `@munaxa/admin-kit` with the resource type as a generic parameter. Docs adopts first and proves the seam |
| **`@edms/utils` — `pagination`, `text`, `uuid`** | Keyset pagination, Arabic-aware text normalisation and UUID helpers are not document rules. The package's own header says helpers with domain meaning belong to a module's domain layer — by that rule these three are not in the right repository | Medium. Arabic normalisation in particular is a correctness detail every Arabic-locale Munaxa product must get identically right | Into `@munaxa/utils` — which `ARCHITECTURE.md` already promises and V-5 shows does not exist. This is the package's first justified content |
| **`list-state` / `list-url`** | URL-as-query-state. Docs applies it to documents, audit and search alike; the pattern is product-neutral | Medium | Fold into `@munaxa/admin-kit` |
| **`i18n` RTL direction mapping** | `TEXT_DIRECTION[locale]` at `app/layout.tsx:37`. Every Munaxa product serving Arabic needs the identical mapping | Low, high consistency value | Into `@munaxa/theme`, beside the locale provider |

Explicitly **not** candidates: the ACL resolver, workflow evaluation, numbering, retention
arithmetic, the audit chain. Each is a document-control rule, and Phase 0's design placed each in
the domain layer for that reason.

---

## 8. Components that incorrectly duplicate platform functionality

**One:** `audit-screen.tsx`'s hand-rolled form controls (V-4), which duplicate `Field`, `Select` and
`Input` — components the same file's neighbours already import.

That is the whole list. For a product of 18 phases and three applications, it is a short one.

---

## 9. Package dependency analysis

```text
@munaxa/*  ──►  @edms/domain ──► @edms/contracts ──► apps/{api,web,worker}
                @edms/utils   ──►
                @edms/i18n    ──►
```

No cycles. No app imported by a package. No sibling product anywhere.

| Finding | Detail |
| --- | --- |
| **Unused dependency** | `@munaxa/icons` in `apps/web` — zero imports (V-3) |
| **Missing direct dependency** | `@munaxa/platform` in `apps/web` — referenced by path in `globals.css` (V-1) |
| **Documented, unpublished** | `@munaxa/typography`, `@munaxa/utils` (V-5) |
| Version ranges | Caret throughout for `@munaxa/*`; a minor platform release is picked up without a code change here — correct for brief §23 |
| `onlyBuiltDependencies` | Explicitly allowlisted at the root — a supply-chain control, worth keeping |
| Duplicate deps already in platform | **None found.** No `radix`, `lucide`, `cmdk`, `clsx` or `tailwind-merge` declared in `apps/web`; all reach it through `@munaxa/platform`. This is the discipline V-1 threatens |

---

## 10. Security and performance observations

**Security** — nothing new. Phase 18's gates stand: production refuses to boot without the antivirus
gate, object storage, a mail provider, the checkpoint key, the witness key or the sealing key, and
refuses plaintext outbound requests, the interactive explorer, a short signing secret and SMTP
without transport security. The audit adds two web-surface notes:

- `window.open(link.url, '_blank', 'noopener,noreferrer')` in `audit-screen.tsx:91` — correct, and
  worth naming because reverse tabnabbing on a *signed evidence link* would be a compliance
  incident, not merely a bug.
- No `dangerouslySetInnerHTML` anywhere in `apps/web`.

**Performance** — one provider tree in `app/providers.tsx` (`ToastProvider`, `LocaleProvider`, React
Query), no duplicated contexts, no duplicated rendering paths found. Four inline `style` objects, all
computing a genuinely dynamic value — tree indentation depth, preview zoom — which is the correct use
of the escape hatch rather than a token violation.

Bundle size, tree-shaking and unused-export analysis all require a build. **Not measured** (§0).

---

## 11. Remediation plan

Ordered by consequence per unit of effort. Effort assumes an environment with a `read:packages`
token, since none of it is verifiable without one.

| # | Item | Sev | Effort | Why here |
| --- | --- | --- | --- | --- |
| 1 | **Verify and fix V-1** — install, confirm whether `@source` resolves, declare `@munaxa/platform` in `apps/web` if not | High | 10 min | Cheapest item, largest blast radius. Every other UI judgement below is unreliable until someone has seen the app render correctly |
| 2 | **Run the five gates** — `format:check`, `lint`, `typecheck`, `test`, `build` | — | 15 min | This audit could not. Phase 18 left them clean; that they still are is an assumption |
| 3 | **Adopt icons (V-3)** | High | 1–2 days | The largest visible gap. Sidebar, row actions, document-type marks, status, empty states |
| 4 | **`WorkspaceScreen` harness, migrate 10 screens (V-2)** | High | 1–2 days | Closes the admin/workspace split. Mechanical once the harness exists |
| 5 | **Rebuild `audit-screen.tsx` form (V-4)** | Med | 2 hours | Small, isolated, and on a screen an auditor sees |
| 6 | **Web test floor (V-7)** — render tests per screen family, and one asserting an affordance is hidden without its capability | Low sev / **High risk** | 3–5 days | Makes the `capabilities` rule enforced instead of assumed. The single most valuable item on this list |
| 7 | **Fix V-5** — publish `@munaxa/utils`, or amend the doc | Med | 30 min doc / 1 day publish | Doc half applied in this commit |
| 8 | **AR/RTL sweep** — 36 of 164 files import `@edms/i18n` | Med | 1–2 days | RTL is wired at the root and `dir="auto"` is used in the right places, but per-string coverage is unmeasured |
| 9 | **Confirm federation/SIEM UI is deliberately absent** — `federat` and `siem` return zero hits in `apps/web` | Low | 1 hour | Phase 17 shipped both. Either config-only by design — then write that down — or a hole |
| 10 | **V-6**, one arbitrary value | Low | 5 min | Trivial |

Items 1–5 and 7 are roughly **one week**. Adding item 6 makes it **two**.

---

## 12. Verdict

**Munaxa Docs is a conditionally compliant, high-quality consumer of the Munaxa Shared Platform. It
is not yet ready to be called finished.**

Compliance, on the categories that can be scored: the product does not duplicate the platform. It
holds zero hardcoded colours across 164 web source files, keeps no local theme, ships no copied
component library, imports no sibling product, and reaches for `@munaxa/ui` sixty-three times. On
the disciplines that are hardest to hold across eighteen phases, it held.

The gap is not compliance drift. It is that **the workspace half of the UI was built to a lower
standard than the admin half, and nobody has run the application to notice** — because V-1 suggests
it may not currently render as intended, and no test would catch it if it did not.

On the question that prompted this audit — *should we start the UI?* — **no.** The UI exists: 164
files, every route, every feature module, a 1:1 mapping onto all seventeen API modules including
Phase 16's bulk operations, templates and signatures. Starting it again would rebuild working
screens.

**What is needed is one week of UI completion, not a UI phase**: install and verify (items 1–2),
icons (3), one layout harness (4), one screen rebuilt (5). Then a second week on the test floor (6),
which converts *"the UI never decides access"* from a rule in a recommendations document into a
statement CI can refuse to merge against.

Item 1 first, and alone if need be. Nothing else on the list can be trusted until someone has
installed the platform and looked at the screen.

---

## 13. What this phase did not do

**It did not refactor the ten workspace screens.** The brief permits refactoring "where safe and
appropriate", and neither adjective survives an environment that cannot typecheck, cannot build and
cannot run a test. A blind rewrite of ten screens against a component library this audit never
downloaded would be a change nobody had verified, in the name of a report about verification.

**It did not edit `apps/web/package.json`.** The V-1 fix is one line, and it needs a matching
lockfile regeneration that `pnpm install` cannot produce here. CI runs `--frozen-lockfile`; a
hand-edited lockfile trades a possible styling defect for a certain install failure.

**It did not move anything to the platform.** Brief §19 says not to without an explicit request, and
[§7](#7-what-should-move-to-the-platform) is written as proposals for exactly that reason.

**It did not score sections 7–11.** They audit against `@munaxa/auth`, `@munaxa/audit`,
`@munaxa/logger` and `@munaxa/notifications`, none of which exist. [§4](#4-the-framing-problem-in-the-brief-and-how-this-audit-resolved-it)
records why, and why the local implementations are the product rather than violations of it.

**It did not invent a number for what it could not measure.** Bundle size, tree-shaking, dead
exports and the five CI gates are all marked unmeasured rather than estimated. The 78 in
[§2](#2-overall-platform-compliance-score) is computed over the categories that were actually
checked; folding in guesses would have raised it and meant less.

---

## 14. Changes made in this commit

| Change | Why |
| --- | --- |
| `prompts/docs prompts/Phase 19 …` retargeted from Munaxa Work to Munaxa Docs — 12 occurrences, plus "HR/business-domain logic" → "document-control business logic" | The brief was copied from the sibling product. A Docs phase specification that names Work is one a future reader has to second-guess (§4) |
| `ARCHITECTURE.md` — `@munaxa/typography` and `@munaxa/utils` rows marked as not yet published | V-5. The table promised two packages the registry does not have |
| This report | The Phase 19 deliverable. Every other phase has one |

No source file was modified. See [§13](#13-what-this-phase-did-not-do).
