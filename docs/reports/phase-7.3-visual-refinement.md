# Phase 7.3 — Product-Wide Visual Refinement & UI Consistency

## 1. Executive summary

**PARTIALLY COMPLETE**, and the boundary is drawn deliberately rather than by exhaustion.

Phase 7.2 established the section grammar on the record page and left twelve hand-rolled headings
elsewhere. This phase located all of them, migrated **ten**, and found that two of the twelve were
not section headings at all but **hand-rolled page headers** — one of which rendered its `<h1>` at
`text-lg`, eighteen pixels, on a page whose own section headings were the same size or larger. That
is the most severe instance of the "no visual language" defect found so far, and no baseline existed
to notice it.

Three findings are corrections of earlier claims rather than new work, and are stated as such:

- **Phase 7.2's library-toolbar finding was a misdiagnosis.** "Columns" is not wrapping at 1280px.
  It is `DataGrid`'s own toolbar row, rendered separately from the product's, and it is on its own
  line at *every* width. The route to one row exists (`toolbarActions`, verified in the compiled
  implementation) and is written up rather than taken, with the reason.
- **The pluralisation fix is a STOP**, per §5's own condition — with the full 28-string inventory
  and the exact type-system obstacle, not a shrug.
- **A code comment I wrote in Phase 7.2 was wrong** about `Panel`'s `padding` prop; it was corrected
  in that phase and the underlying gap is re-verified here against the installed package.

Two defects were found by the *new* coverage this phase added, which is the argument for adding it:
the 18px page title, and five full-width `Select`s stacked into a column because `fieldBase` is
`w-full`.

## 2. Initial visual audit

Every remaining hand-rolled heading in the product, located precisely:

| Surface | Line | Current | Class | Category | Action |
| --- | --- | --- | --- | --- | --- |
| Permissions | 205 | `<h1>` **page title** | `text-lg font-semibold` | **A** | → `WorkspacePage` |
| Numbering reservations | 76 | `<h1>` **page title** | `text-2xl font-semibold` | **A** | → `Page` + `PageHeader` |
| Permissions | 215/251/369 | `<h2>` in `Card p-4` | `text-base font-semibold` | **A** | → `Panel` ×3 |
| Reports | 191/213/249/364 | `<h2>` in `Card p-4` | `text-sm font-medium` | **A** | → `Panel` ×4 |
| Audit export | 209 | `<h2>` in `Card p-4` | `text-sm font-medium` | **A** | → `Panel` |
| Notification preferences | 255 | `<h2>` in `Card` | `text-lg font-semibold` | **A** | → `Panel` |
| Notification suppressions | 171 | `<h2>` in `Card` | `text-lg font-semibold` | **A** | → `Panel` |
| Search — saved / recent | 321/380 | `<h2>` in `<section>` | `text-lg font-medium` | **E** | not enough evidence — §7 |
| Login, MFA ×3 | — | `<h1>` outside the shell | `text-2xl` / `text-lg` | **E** | auth screens, not audited |
| Revision compare, ceremony ×2, record metadata, search:426 | — | `<h3>` sub-headings | various | **D** | already correct |

Six type treatments across nine sections is the same defect Phase 7.2 named on the record page,
propagated through the rest of the product.

## 3. Surfaces inspected

Permissions, Reports, Audit, Notifications, Notification templates, Numbering reservations, Search,
Dashboard, Document library, Document record, the 25 `AdminScreen` administration screens, and the
platform APIs for `Panel`, `Select`/`fieldBase`, `DataGrid` and `Toolbar`.

## 4. Findings

**A — REAL DEFECT (fixed):**

1. **Permissions opened at `text-lg`.** A page title at 18px, where every other page in the product
   titles itself at 24px through `PageHeader`, and no smaller than the section headings on the same
   screen. It also had no way back to the document except the browser's own button.
2. **Numbering reservations hand-drew `PageHeader`** — a wrapping flex row, `text-2xl font-semibold`
   title, dimmed description, action pinned to the end. Exactly what the component renders.
3. **Nine `Card` + `<h2>` sections** across permissions, reports, audit, notifications and templates.
4. **Five full-width `Select`s on the permissions screen.** `Select` inherits `fieldBase`, which is
   `w-full`; inside a `flex-wrap` row with no width each control claimed the whole line, so choosing
   a role and a permission meant four stacked 1180px dropdowns. **Found by the baseline added in this
   phase, not by reading the source** — read out of the compiled `fieldBase`, not inferred.

**B — PLATFORM GAP:** `Panel` body padding, `Stepper` per-step status (both §13).

**C — PRODUCT DESIGN GAP:** the two-row control area on every list screen (§6).

**D — ALREADY CORRECT — NO CHANGE:** the dashboard (§9 of the brief, and Phase 7.2's verdict re-checked
— still the best-composed surface, no concrete defect found); the 25 `AdminScreen` screens; the
document library grid; the record page; the `<h3>` sub-headings; `SelectField`'s native `<select>`,
which is a documented deliberate choice.

**E — NOT ENOUGH EVIDENCE:** search's two `<section>` headings; the four auth-screen `<h1>`s.

## 5. Changes made

| File | Change |
| --- | --- |
| `permissions-screen.tsx` | `<section>` + 18px `<h1>` → `WorkspacePage` with a breadcrumb back to the document; three `Card`s → `Panel` with icons; five `Select`s sized |
| `numbering-reservations-screen.tsx` | hand-drawn header → `Page` + `PageHeader` with `actions` |
| `reports-screen.tsx` | four `Card`s → `Panel` with icons |
| `audit-screen.tsx` | export `Card` → `Panel` |
| `notifications-screen.tsx` | preferences `Card` → `Panel` |
| `notification-templates-screen.tsx` | suppressions `Card` → `Panel` |
| `test/visual.spec.tsx` | **new** `document-permissions` surface |

Ten migrations, two page-header fixes, one density fix. Nothing else.

## 6. The library toolbar — Phase 7.2's finding CORRECTED

Phase 7.2 recorded: *"the library toolbar wraps to a second line at 1280px, putting 'Columns' alone
beneath the search box."* **That is wrong, and this is the correction.**

`ResourceList` renders a `Toolbar` (search, deleted filter, resource filters, Create) and then
`DataGrid`. `DataGrid` renders **its own** control row — verified by reading the compiled component,
not its type:

```js
searchable || columnMenu || toolbarActions ? (
  <div className="flex flex-wrap items-center gap-2">
    {searchable ? <Input …/> : null}
    {toolbarActions}
    {columnMenu ? <DropdownMenu>…Columns…</DropdownMenu> : null}
  </div>
) : null
```

So "Columns" is on its own line at **every** width, including 1440. It is not a wrap; it is two
control rows by construction. The visual symptom is real — a second row containing one small button
looks unfinished — but the diagnosis was not.

**The route to one row exists and is verified:** `DataGridProps.toolbarActions` renders *inside* that
same row, between the search box and the column menu. Passing `ResourceList`'s filters through it
would collapse the two rows into one.

**Not taken, and the reason is not budget.** `ResourceList` backs **25+ administration screens plus
the document library**; moving its controls into the grid's row changes every one of them, and it
trades away `Toolbar`'s `role="group"` + `aria-label` for the grid's unlabelled `<div>` — an
accessibility regression in exchange for a visual gain. That is a scoped change with its own visual
and accessibility verification across 26 screens, not a line to slip into a refinement phase. **§14's
DELETE > REUSE > COMPOSE > ADD and §22's "if a screen is already strong, leave it alone" both point
the same way.** Recorded as FUTURE ENHANCEMENT with the exact API and the exact trade-off.

## 7. Components deliberately not reused

- **`DataGrid.toolbarActions`** — §6.
- **`Panel` for search's saved/recent lists** — category **E**. Those two `<h2>`s head `<section>`s
  containing lists of `Card`s. Wrapping them in `Panel` would put cards inside a panel, which is the
  nesting Phase 7.2 spent its budget removing, and the right answer is probably to flatten the inner
  cards first. That is a composition decision needing its own look at the screen, and §3 says do not
  modify category E.
- **`Panel` for the auth screens** — category **E**. Login and MFA render outside the workspace shell
  as centred cards; `Page`/`PageHeader` may not be the right frame and I did not audit them.
- **`Stepper` for approval stages** — still refused, unchanged from Phase 7.2 (§13).

## 8. i18n changes — STOP, per §5's own condition

**No i18n change was made.** §5 says to determine the actual scope before implementing, and to stop
if the architecture cannot support it without a package-level design decision. Both conditions are met.

**Scope: 28 `{count}` strings**, and the catalogue already contains **two competing hedges** for the
same problem — which is itself the evidence that this needs deciding rather than patching:

```
rowCount:      '{count} rows'                    ← wrong at 1
rowCount:      '{count} row(s)'                  ← the other convention, same catalogue
inUseByTypes:  'Used by {count} document type(s). Change those first.'
inUseByMembers:'{count} person/people hold this role. Remove it from them first.'
held:          '{count} number(s) reserved.'
duplicateWarning: '…already filed {count} time(s) in this organisation:'
…22 more
```

**The obstacle is the type system, not the runtime.** `MessageKey` is `LeafPaths<Catalogue>`, which
recurses until it finds a `string`. A plural entry is an *object* — `{ one: …, other: … }` — so
`LeafPaths` would descend into it and mint keys like `admin.grid.rowCount.one`, changing the key type
that every call site in both the API and the web app depends on. The alternatives are (a) teaching
`LeafPaths` to stop at plural-shaped objects, which changes the package's core contract, or (b) a
parallel `PLURALS` record with its own `plural(locale, key, count)` function, which means two ways to
write a string. **Either is a package-level architectural decision with an owner.**

**And there is a second blocker that no amount of engineering removes.** Arabic has **six** plural
categories (`zero`, `one`, `two`, `few`, `many`, `other`). Doing this properly means 28 strings × six
Arabic forms, correctly declined. I can build the mechanism; I cannot produce 168 correct Arabic
plural forms for domain strings in a compliance product, and inventing them would be worse than the
current state — the product would look translated and be wrong. §5 forbids fixing one screen, so a
partial migration is not available either.

**BLOCKED**, with a complete hand-off: the 28-string inventory, the two competing conventions, the
exact type obstacle, the two candidate APIs, and the requirement for a native Arabic reviewer.

## 9. Responsive verification

`responsive.spec.tsx` — four surfaces × **1440 / 1280 / 1024 / 768 / 430 / 390**, real built
stylesheet, real Chromium: **passing, zero horizontal overflow.**

In the **running application** (real API, real Redis, real PostgreSQL, production build, real
Chromium): the document library and the document record at all six widths, and the phone drawer at
430/390 — **27 E2E tests passed**.

**NOT VERIFIED:** the six surfaces changed in this phase have no running-application responsive test.
`document-permissions` is covered by a static baseline at 1280 in both themes only. The permissions
screen has no E2E test and adding one would mean seeding an ACL fixture — real work, not in scope
here. Stated as not verified rather than assumed from the static render.

## 10. Accessibility verification

- **Ten new labelled regions.** Each migrated section is now `role="region"` with `aria-labelledby`
  pointing at its own title, supplied by `Panel`.
- **Heading order corrected on two screens.** The permissions screen's `<h1>` is now `PageHeader`'s,
  with `Panel`'s `<h2>`s beneath it; previously an 18px `<h1>` sat above `text-base` `<h2>`s that
  looked heavier than it.
- **axe: 102 tests passed**, unchanged from before the phase — no regression.
- Every icon is `aria-hidden`; none carries meaning its label does not.
- **NOT VERIFIED:** none of the six changed screens has its own axe test. The suite covers the
  library, folder tree, approval inbox, search, dashboard, sign-in and the record page. Adding
  coverage for permissions and reports is the obvious next increment and is named in §14 rather than
  claimed here. An axe pass is not a human accessibility audit, and this phase did not have one.

## 11. Visual regression results

**83 passed. 1 new surface, 2 baselines created, 0 existing baselines changed.**

That last number is the useful one: **ten section migrations across six screens changed no existing
image**, because none of those six screens had a baseline. That is the coverage gap, stated plainly.

`document-permissions` (light + dark) is new, and it earned its place immediately — it is what
exposed the five full-width selects, a defect three phases of source reading had walked past.

Both images were opened and inspected before promotion. No unexplained pixel changed: the only
baselines that moved were the two I created, and they moved once, for the select-width fix, which I
inspected again before accepting.

## 12. E2E results

Real API, real Redis, real PostgreSQL, two tenant databases, production Next build, real Chromium:

```
Test Files  1 passed      Tests  27 passed | 19 skipped
```

Including the signing ceremony end to end, the rate-limit refusals, and the record page at six
widths. `recovery.e2e.spec.ts` fails at `beforeAll` on an unset `DR_DEST_ADMIN_URL` — the DR
rehearsal needs a destination cluster this container has not been given. Pre-existing, identical in
Phases 7.1B/7.1C/7.2, unrelated to this phase, and **not** skipped or weakened.

## 13. Platform gaps

Both re-verified against the installed package, not carried forward on trust.

**PLATFORM ENHANCEMENT — `Panel` body padding.** Still present. Current: `<div className={cn('min-h-0
flex-1 p-4', scrollBody && 'overflow-y-auto')}>`, hard-coded; `padding` is a `SurfaceProps` prop and
stops at the outer surface. Required: a `bodyPadding`/`flush` prop defaulting to today's `p-4`.
Beneficiaries: any viewer, map, chart or inspector in any AXA product. Backwards compatible.
*Correction carried forward:* a Phase 7.2 comment claimed `padding={0}` removed the body padding. It
does not; the claim was removed in that phase rather than left in the tree.

**PLATFORM ENHANCEMENT — `Stepper` per-step status.** Still present. Current: `{ steps: StepperStep[];
current: number }`, where `StepperStep` is `{ key, title, description? }` — steps before `current`
render complete, later ones muted. Required: a per-step `status` (`complete` | `current` | `pending` |
`failed` | `skipped`). Without it a `REJECTED` approval stage renders as *complete*, which on a
compliance product is the screen asserting something that did not happen. Backwards compatible if
`status` is optional and defaults to today's index-derived behaviour.

**Not re-verified this phase:** `DataGrid` proportional column strategy and `Badge` contrast. Both
remain recorded from earlier phases; I did not re-check them, and say so rather than restate them as
current.

## 14. Remaining visual debt

1. **Pluralisation** — §8. BLOCKED, highest value on this list, needs an owner and a native Arabic
   reviewer.
2. **Two control rows on every list screen** — §6. The route is verified; the work is 26 screens.
3. **Search's two `<section>` headings** — category E; needs the inner cards flattened first.
4. **Four auth-screen `<h1>`s** — category E; not audited.
5. **No axe or E2E coverage for the six screens changed here** — §§9–10.
6. **No dialogue visual baseline** — §7 of the brief. The harness renders static markup, so no portal
   mounts and no effect runs; a screenshot of `SigningCeremony` would be a screenshot of nothing.
   **NOT VERIFIED whether this is fixable** — making the harness hydrate is a change to the test
   infrastructure's central assumption and I did not attempt it or prove it possible.
7. **`Panel` body padding** and **`Stepper` status** — §13.

## 15. Business-logic preservation

**No API change, no database change, no Prisma change, no permission change, no RBAC or ACL change,
no audit or hash-chain change, no lifecycle change, no signature change, no rate-limit change, no
storage change, no notification-delivery change, no scheduled-job change.**

The diff touches six `apps/web/src/features/**` files and one test file. `apps/api`, `packages/*` and
`prisma/*` are untouched — which is also why the integration suite was not re-run (§17).

## 16. Files changed

```
apps/web/src/features/permissions/permissions-screen.tsx
apps/web/src/features/admin-configuration/numbering-reservations-screen.tsx
apps/web/src/features/reports/reports-screen.tsx
apps/web/src/features/audit/audit-screen.tsx
apps/web/src/features/notifications/notifications-screen.tsx
apps/web/src/features/notifications/notification-templates-screen.tsx
apps/web/src/test/visual.spec.tsx
apps/web/src/test/__screenshots__/document-permissions-{light,dark}.png   (new)
```

## 17. Gates

| Gate | Result |
| --- | --- |
| `pnpm format` | clean |
| `pnpm lint` | **0 errors**, 7 warnings — all pre-existing `import()`-type-annotation warnings |
| `pnpm typecheck` | 13/13 |
| unit | web 137 · api 645 (1 skipped) · domain 164 · contracts 26 · utils 11 · i18n 4 · worker 2 |
| `pnpm build` | 9/9 |
| `pnpm verify:styles` | 10/10 |
| visual + responsive (real Chromium) | **83 passed** |
| accessibility (axe) | **102 passed** |
| **e2e — `signing.e2e.spec.ts`** | **27 passed, 0 failed** |
| e2e — `recovery.e2e.spec.ts` | env-gated failure (`DR_DEST_ADMIN_URL`), pre-existing — §12 |
| integration | **not run.** No API, package or schema code changed; it passed unchanged in Phase 7.1C. Reported as not run rather than inherited |

## 18. Before / after evidence

**Permissions screen** (`document-permissions-{light,dark}.png`, new):

- *Before*: an 18px `<h1>` with no breadcrumb, three cards with `text-base font-semibold` headings
  and no rules, and four full-width dropdowns stacked into a column to pick a role and a permission.
- *After*: breadcrumb → 24px title → description, three panels with icons and rules, and one wrapping
  row of five sized controls.
- *Platform components*: `WorkspacePage`, `Page`, `PageHeader`, `Breadcrumb`, `Panel`, `Select`,
  `Badge`, `@munaxa/icons`.

**Reports, audit export, notification preferences, suppressions, numbering reservations:** changed in
source and verified by typecheck, lint, build and unit tests, **without a rendered image**, because
none of these surfaces has a baseline. Stated as changed-and-not-visually-verified rather than
promoted to "verified".

## 19. Evidence classification

**IMPLEMENTED** — two page-header fixes, ten section migrations, five select widths, one new visual
surface. **VERIFIED** — the permissions screen in both themes as a rendered image, inspected; 83
visual/responsive tests; 102 axe tests; 27 E2E in the running application; `fieldBase`'s `w-full`,
`Panel`'s hard-coded body padding and `DataGrid`'s single toolbar row all read out of the compiled
package. **ALREADY CORRECT — NO CHANGE** — dashboard, library grid, record page, 25 `AdminScreen`
screens, `SelectField`'s native control, the `<h3>` sub-headings. **NOT VERIFIED** — running-app
responsive behaviour of the six changed screens; axe coverage for them; whether the visual harness
can be made to render dialogues. **BLOCKED** — pluralisation. **PLATFORM ENHANCEMENT** — `Panel` body
padding; `Stepper` per-step status; `DataGrid.toolbarActions` consolidation. **FUTURE ENHANCEMENT** —
search's two sections; the auth screens; coverage for the six changed screens.

## 20. Recommended next work

1. **Pluralisation**, as its own phase with a named owner and a native Arabic reviewer. It is visible
   to every user on every list screen and it is the largest remaining defect in the product's UI.
2. **Coverage for the six screens changed here** — visual baselines and axe tests. This phase's own
   evidence is the argument: the one baseline it added found a defect within minutes.
3. **The `toolbarActions` consolidation**, scoped as a change to `ResourceList` affecting 26 screens,
   with the `Toolbar` landmark preserved or its loss consciously accepted.
4. **Search and the auth screens**, audited properly rather than migrated on the strength of a grep.

## Status

**PARTIALLY COMPLETE.** Ten of twelve headings migrated, two page headers fixed, one density defect
found and fixed. Two headings deferred as category E, pluralisation BLOCKED with a complete hand-off,
and the library toolbar corrected from a misdiagnosis into a verified but out-of-scope route. The
product's section grammar is now consistent across the record page, the library rail, permissions,
reports, audit, notifications and templates — but six of those screens are consistent *in source*
and only one of them has an image to prove it.
