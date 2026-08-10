# Phase 7.2 — Visual Design & Interaction Polish

## 1. Executive summary

**COMPLETE for the record page, the library rail and the signing ceremony. Deliberately narrow
everywhere else, and the reasons are stated rather than glossed.**

The audit found one defect that mattered more than the rest and explained most of what made the
product feel like an admin panel rather than a document-control platform: **the application had no
section language.** Every panel on every screen invented its own. On the record page — the screen
this product exists for — five sections carried five different heading treatments:

| Section | Before |
| --- | --- |
| Approvals | `<h2 className="text-lg font-semibold">` |
| Revisions | `<h2 className="text-lg font-medium">` |
| Signatures | `<h2 className="text-lg font-medium">` |
| Preview | `<h2 className="text-sm font-semibold">` |
| Audit trail | `<h2 className="text-sm font-medium">` |
| Properties / File | `<h2 className="text-lg font-medium">` |

Two sizes, two weights, no rule, no icon, and **not one of them a landmark**. A reader could not tell
by looking which of these were peers. The design system has shipped the answer since before this
product existed — `Panel`, a bordered region with a header, a rule and a `role="region"` labelled by
its own title — and it had **two uses in the entire application**.

Phase 7.2 is mostly that: nine hand-rolled section headers replaced by the platform component that
already existed, plus a semantic icon on each, plus the removal of two levels of card nesting and
the addition of the ceremony's missing stage indicator. No new colour, no new radius, no new shadow,
no new component, no new token, and no business behaviour touched.

The honest counterpart: **the dashboard, search, notifications, settings and the twenty-five
administration screens were not changed.** §20 says why, and it is not "ran out of time" in every
case.

## 2. Initial UI inventory

39 routes, 21 feature areas. Composition, as found:

| Composition | Count | Verdict |
| --- | --- | --- |
| `AdminScreen` (`Page` + `PageHeader` + `Stack`) | 25 screens | Consistent. Left alone. |
| `WorkspacePage` (Phase 7) | 8 screens | Consistent. Left alone. |
| Hand-rolled `<h1>`/`<h2>` outside both | **21 sites** | The defect. Nine fixed. |

Platform component adoption, counted across `features/`, `components/` and `app/`:

```
EmptyState 17   Section 3   Timeline 2   Panel 2    Toolbar 2   Split 2   StatCard 1  Skeleton 1
Surface 0       Stepper 0   KpiGrid 0    Tag 0      Tooltip 0   Avatar 0  InspectorLayout 0
```

`Panel` at 2 and `Surface`/`Stepper` at 0 is the whole finding in one line: the layer of the design
system that expresses *structure* was almost entirely unused, and the product hand-built it instead,
differently each time.

Per-screen notes are folded into §§8–13 rather than repeated as a table nobody reads.

## 3. Visual problems found

1. **No section language.** Nine hand-rolled headers, six type treatments, zero landmarks. (Fixed.)
2. **Card nesting three deep.** Record page grid → approvals `Card` → `InstanceTimeline` `Card` →
   the stage list's own bordered rows. And two empty states each wrapped in their own `Card` inside
   the panel that already had one. (Fixed.)
3. **Section actions competing with page actions.** Check out, Check in, Publish, Force check-in and
   Sign all rendered at default size — the same weight as `Download`, the record's one primary
   action. (Fixed: `size="sm"` inside panel headers.)
4. **No icons anywhere in the workspace.** `@munaxa/icons` was imported by exactly one workspace
   component (the overflow trigger). (Partly fixed: nine section icons.)
5. **The signing ceremony never said where you were.** Four internal stages, no indicator. (Fixed.)
6. **The library rail's group labels read as *less* present than the links beneath them** —
   `text-sm font-medium opacity-70` floating above a card. (Fixed.)
7. **"1 rows".** Visible on the busiest screen. (**Not fixed — §21.** It needs pluralisation the
   i18n package does not have, and an English-only patch would leave Arabic wrong in six ways.)
8. **`Panel` cannot unpad its body.** (**Platform gap — §7.**)

## 4. Design principles used

- **The design system decides, the product composes.** Every value below comes from a platform
  component or an existing token. No hex, no radius, no shadow, no font size was invented.
- **Structure is drawn by borders and rules, not by space.** Once every section is a bordered panel
  with a rule under its title, the gap between them can *shrink* — `gap-6` → `gap-4` on the record
  page, `gap-4` → `gap-3` on the rail. Twenty-four pixels between bordered regions reads as four
  disconnected objects; sixteen reads as one record with four parts.
- **One primary action per page; sections get `sm`.**
- **An icon that repeats the word beside it is decoration.** Nine icons, each marking a *kind* of
  section a reader learns once and then recognises: `ListTree` properties, `FileText` file, `Eye`
  preview, `ClipboardCheck` approvals, `GitBranch` revisions, `PenLine` signatures, `History` audit,
  `LibraryIcon`/`FolderTree`/`Star` for the three rail groups. All `aria-hidden`; none carries
  meaning the text does not.
- **Nothing visual may change what a screen means.** §19.

## 5. Screens changed

| Screen / component | Change |
| --- | --- |
| `document-screen.tsx` | Properties and File → `Panel`; grid `gap-6` → `gap-4`; metadata sub-heading → uppercase caps label |
| `preview-panel.tsx` | Hand-built `Card p-0` + `border-b` header → `Panel title actions` (~20 lines of chrome removed) |
| `approval-panel.tsx` | → `Panel`; instance `Card` → `Surface tone="muted"`; two `Card`-wrapped empty states unwrapped; header actions `sm` |
| `revision-panel.tsx` | → `Panel`; five header actions `sm` |
| `signature-panel.tsx` | → `Panel`; Sign action into the header slot at `sm` |
| `audit-timeline.tsx` | → `Panel` (already used the platform `Timeline` inside) |
| `folder-tree.tsx` | Three `Card`s + three hand-rolled labels → three `Panel`s with icons; `gap-4` → `gap-3` |
| `signing-ceremony.tsx` | `Stepper`: Review → Confirm → Signed |
| `packages/i18n` (en + ar) | Three step labels. No other string changed |

## 6. Platform components reused

`Panel` (9 new uses, from 2), `Surface` (first use), `Stepper` (first use), `Stack`, `EmptyState`,
`Badge`, `Button`, `Alert`, `Timeline`, and `@munaxa/icons`. **Nothing was added to the product's own
component layer.** The one product-level component this phase might have created — a shared
"section" wrapper — was deliberately *not* created, because `Panel` already is it, and a wrapper
around it would have been the parallel component library the brief forbids.

## 7. New platform gaps

**PLATFORM ENHANCEMENT — `Panel` cannot unpad its body.**

`Panel`'s body is `cn('min-h-0 flex-1 p-4', …)`, hard-coded. Its `padding` prop is a `SurfaceProps`
prop and reaches the outer surface, not the body — so `<Panel padding={0}>` does nothing to the
content inset. This matters for exactly one class of section: a viewport whose contents want the
full width of the surface. In this product that is the document preview, which is now inset by
sixteen pixels it does not need.

*Recorded honestly:* I passed `padding={0}` on four panels and wrote a code comment claiming it
removed the body's padding. It does not. The prop is removed and the comment corrected; the false
claim is not left in the tree.

- Is it a platform capability? Yes — an inspector, a map, a chart and a viewer all want it.
- Where does it belong? `@munaxa/platform`, on `Panel`, as a `bodyPadding` or `flush` prop.
- Docs-specific? No.
- Would it affect consumers? No, if it defaults to today's `p-4`.
- Can the platform express it without weakening anything? Yes.

Not worked around. A `[&>div]:p-0` escape hatch in this repository would be a product-specific
workaround around a design-system boundary, which §18 forbids and this repository does not do.

**PLATFORM ENHANCEMENT — `Stepper` cannot express a rejected or cancelled step.** See §11.

## 8. Dashboard improvements

**None, and this is a considered verdict rather than an omission.**

The dashboard already composes `Page` → `PageHeader` → `Section` → `Grid` with tiles that step
1→2→3→4 columns, a documented RTL pass, and exactly one tile whose tone carries meaning. It is the
best-composed screen in the product and the only one that already used `Section`. §22 says leave a
visually strong screen alone, and the acceptance criterion "dashboard hierarchy is substantially
improved" would have required manufacturing a problem to solve.

The one substitution available — its bespoke `CountStat` for the platform's `StatCard`/`KpiGrid` —
was considered and rejected: `CountStat` carries a permission-gated count, an optional link, a hint
key and a tone, and Phase 7 already recorded that migrating to platform components for appearance
alone is out of bounds. **RAISED, NOT ANSWERED:** whether `StatCard` should grow those affordances
so a future dashboard can use it, is a platform conversation rather than a Docs change.

## 9. Library improvements

**The rail.** Three `Card`s each preceded by a `text-sm font-medium opacity-70` heading became three
`Panel`s with icons and rules. The labels now read as headers rather than as captions; the links sit
inside the region they belong to; the three groups gained landmarks. The vertical gap dropped from
`gap-4` to `gap-3` because the borders now do the separating.

**The grid was left alone**, and this is the same call as the dashboard. Phase 7.1 already fixed the
column set at narrow widths, gave the title cell two lines with the number beneath it, and added
`DocumentStatusBadge`; the hierarchy the brief asks for — identity → status → metadata → time →
action — is what it already renders. The platform `DataGrid` is in use; nothing was replaced.

**Checked and found *not* to be a defect:** the filter control that looks like a raw browser
`<select>` is the platform's `Select`, reached through `SelectField`, which deliberately renders a
native control because "the values are a handful of product-defined alternatives with no searching
to do, and a native control is the one every assistive technology and every mobile keyboard already
knows". No raw form control exists in the workspace. I looked because the brief says to; there was
nothing to fix.

## 10. Record-page improvements

The screen this phase is really about.

- **Seven sections, one language.** Properties, File, Preview, Approvals, Revisions, Signatures and
  the Audit trail now share one header: an icon, the title in the display face at one size, a rule
  beneath it, and the section's own actions aligned to the end.
- **Nesting reduced from three levels to two.** The approval instance is a `Surface tone="muted"`
  rather than a `Card`; the two `Card`-wrapped empty states lost their wrappers.
- **Action weight fixed.** Nine section actions moved to `sm`, leaving `Download` as the one
  full-weight button on the page — which is what Phase 7's identity block was for.
- **The Phase 7 identity block is untouched.** Title dominant, number and revision beneath it,
  status and classification as badges below. It was already right.
- **Every section is now a landmark.** Seven labelled regions where there were none.
- **`gap-6` → `gap-4`.**

## 11. Workflow / approval experience

The stage list is unchanged in **meaning**: current, completed, pending, rejected and cancelled
stages each still render their own badge and their own tasks, with actor, timestamp, "2 of 3", due
date, on-behalf-of and auto-decided markers all intact. Only the surface around it changed.

**`Stepper` was considered for the approval chain and rejected.** Its API is `{ steps, current }` —
steps before `current` render as complete, later ones muted. A workflow stage can be `REJECTED` or
`CANCELLED`, and a stepper would draw a rejected stage as *complete*. On a compliance product that
is not a visual compromise; it is the screen asserting an approval that did not happen. §7's rule —
visual polish must never alter semantic meaning — decides it, and §25's stop condition ("a platform
component cannot express required semantics") is the right label.

**PLATFORM ENHANCEMENT:** `StepperStep` needs a per-step `status` (`complete` | `current` |
`pending` | `failed` | `skipped`) before any approval chain in any AXA product can use it. Until
then this product renders stages as an explicit list, which is honest.

## 12. Signature ceremony

The Phase 6.6 flow is untouched: the statement is still composed by the server and rendered
verbatim, re-authentication is still a stage of the confirmation rather than a step before it, no
credential is held in persistent component state, and nothing about the backend changed.

What is new is that the dialogue now **says where you are**: `Stepper` with Review → Confirm →
Signed. `Stepper` is used exactly as documented — a linear flow with a current index — and `error`
deliberately does **not** move it: a refused attempt leaves the signer on the step they were on, and
the `Alert` above carries what went wrong. The index is derived by `stepIndexFor`, a pure exported
function with the reasoning in its doc comment.

All 27 E2E tests covering the ceremony pass unchanged, including "signs, and the stored statement is
the one that was displayed" and "refuses a second signature for the same meaning".

## 13. Empty / loading / error states

**Improved where the phase touched, not rebuilt.** Two `Card`-wrapped empty states on the record
page were unwrapped; the "no approval needed" state stopped repeating the section's own title as its
heading; the signature panel's empty sentence moved from `opacity-70` to the `text-muted-foreground`
token.

The wider work Part 12 describes was **already done** and is left alone: `EmptyState` has 17 uses,
`ErrorState` backs the route boundary, Phase 7.1 replaced the route spinner with a page-shaped
skeleton, and Phase 7.1C added the rate-limited state. There is no generic "Something went wrong"
left on a path this phase could see.

## 14. Interaction improvements

Restrained to the point of being nearly nothing, deliberately. Hover, focus and open/close
transitions all come from the platform components, which already have them; nine section actions
dropping to `sm` changes their hit area and their weight but adds no motion. **No animation was
added by this phase.** Part 13 permits polish; it does not ask for it where the design system
already provides it, and adding a transition the platform did not choose would be the arbitrary
one-off convention the brief forbids.

## 15. Responsive verification

`responsive.spec.tsx` — four surfaces × six widths, real built stylesheet, real Chromium:
**1440 / 1280 / 1024 / 768 / 430 / 390, zero horizontal overflow, all passing.**

In the **running application** (real API, real database, production build, real Chromium):

| | 1440 | 1280 | 1024 | 768 | 430 | 390 |
| --- | --- | --- | --- | --- | --- | --- |
| Document library | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Document record | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Phone navigation | — | — | — | — | ✓ | ✓ |

The record-page test asserts, at every width: no overflow, the document number, the title and the
status (both read from the database), the primary action visible, the overflow trigger visible — and
then clicks it open at 390px. **No regression from Phase 7.1C.**

Mobile was inspected as an image, not inferred: at 390px the record page stacks its panels full
width, each keeping its icon, title and rule, with `Download` and the overflow trigger on their own
line beneath the identity block.

## 16. Accessibility verification

**The landmark count went up and nothing regressed.**

- Seven record-page sections and three rail groups are now `role="region"` with `aria-labelledby`
  pointing at their own titles — supplied by `Panel`, not hand-written.
- Heading order holds: `PageHeader`'s `h1` → `Panel`'s `h2` → the metadata sub-heading's `h3`.
- Every icon is `aria-hidden`; none carries meaning its label does not.
- **New coverage:** `screens.a11y.spec.tsx` gained a `document record` block — the record page had
  **no accessibility coverage at all** before this phase. Two states (with sections, and with no
  file and no sections), both axe-clean. A duplicated region name, an unlabelled region or a skipped
  heading level would fail there and pass a code review.
- Colour contrast is checked in real Chromium by the visual suite: **all 79 tests pass**, including
  every contrast assertion in both themes.
- Keyboard: the overflow menu is opened by a real click in the running application, and the
  ceremony's keyboard path is covered by the existing E2E tests, all passing.

## 17. Visual regression results

**79 passed, 15 baselines updated, 13 deliberately untouched, 1 new surface.**

| Baseline | Why it changed |
| --- | --- |
| `document-record` light/dark, `document-record-mobile` | Properties and File became panels; grid gap tightened |
| `document-record-sections` light/dark | **New surface** — see below |
| `signatures-empty`, `signatures-signed` light/dark | Panel header; Sign moved into it at `sm` |
| `document-list` light/dark, `-tablet`, `-mobile` | Rail became three panels |
| `folder-tree` light/dark | Same, in isolation |

**New surface `document-record-sections`, and the gap it closes:** `document-record` renders the
screen with all four slots *empty*, so no image had ever shown the record page's sections together —
which is precisely where this phase's defect lived. Five inconsistent headings could never have been
caught by a baseline that never put them side by side.

Every changed image was opened and inspected before promotion, in both themes and at 390px.
Deliberately unchanged: `dashboard`, `search`, `workflow-inbox`, `sidebar-nav`,
`sidebar-nav-collapsed`, `workspace-rail`, `route-loading` — those screens were not touched.

## 18. Before / after evidence

Engineering evidence, not marketing shots — the baselines themselves, in git.

**Record page, `document-record-sections-light.png`:**

- *Before*: "Properties" and "File" as plain `text-lg font-medium` headings floating inside cards
  with no rule; "Signatures" below them in a **different** treatment with a full-size `Sign` button;
  `gap-6` between three unrelated-looking boxes.
- *After*: three panels with one header language — icon, display-face title, rule — `Sign` at `sm`
  aligned to the end of its own header, `gap-4`.
- *Platform components*: `Panel`, `Badge`, `Button`, `@munaxa/icons`.

**Library rail, `document-list-light.png`:**

- *Before*: three cards, each with a small dimmed caption floating above it.
- *After*: three panels with icons and rules; links pulled to the panel edge with a logical `-mx-2`.
- *Platform components*: `Panel`, `Badge`, `@munaxa/icons`.

**Signature ceremony:** no baseline — the visual harness renders static markup and the ceremony is a
dialogue, a limitation Phase 6.6 already recorded. Verified in the running browser by 27 E2E tests.

**Not captured because not changed:** dashboard, workflow inbox, search, settings, mobile navigation.

## 19. No business logic changes

Verified for this phase: **no API change, no database change, no permission change, no workflow
semantic change, no lifecycle change, no audit semantic change, no signature semantic change, no
rate-limit change, no storage change.** The diff touches `apps/web/src/features/**`,
`apps/web/src/test/**`, and three step labels in each i18n catalogue. `apps/api` is untouched.

## 20. Files changed

```
apps/web/src/features/documents/document-screen.tsx      Properties + File → Panel
apps/web/src/features/documents/folder-tree.tsx          three Cards → three Panels
apps/web/src/features/preview/preview-panel.tsx          hand-built panel → Panel
apps/web/src/features/approvals/approval-panel.tsx       → Panel; Card → Surface; nesting removed
apps/web/src/features/revisions/revision-panel.tsx       → Panel; actions sm
apps/web/src/features/signatures/signature-panel.tsx     → Panel; action into header
apps/web/src/features/signatures/signing-ceremony.tsx    Stepper + stepIndexFor
apps/web/src/features/audit/audit-timeline.tsx           → Panel
apps/web/src/features/screens.a11y.spec.tsx              NEW record-page a11y coverage
apps/web/src/test/visual.spec.tsx                        NEW document-record-sections surface
apps/web/src/test/__screenshots__/                       15 baselines updated, 2 created
packages/i18n/src/catalogues/{en,ar}.ts                  three step labels
```

## 21. What was deliberately not changed

- **The dashboard** — §8. Already the best-composed screen; changing it would have meant inventing a
  problem.
- **The library grid** — §9. Phase 7.1 already gave it the hierarchy the brief asks for.
- **Twenty-five administration screens** — all already share `AdminScreen`. Consistent by
  construction; nothing to unify.
- **Search, notifications, settings, templates, permissions** — not audited deeply enough to change
  responsibly, and §22 is explicit that a visual phase is not a licence to rebuild working screens.
  Stated as *not done*, not as *fine*.
- **"1 rows".** A real defect, visible on the busiest screen, and **not fixed here.** `admin.grid.rowCount`
  is `'{count} rows'` and `@edms/i18n` has no pluralisation at all — no `Intl.PluralRules`, no plural
  keys, nothing. Fixing English by special-casing `1` would leave Arabic, which has six plural
  categories, wrong in five of them. The correct fix is `Intl.PluralRules` in `@edms/i18n` and a
  sweep of every `{count}` string in both catalogues. That is an internationalisation change, not
  visual polish, and inventing a half-version of it inside this phase is exactly the improvisation
  §25 says to stop for.
- **Motion.** §14.

## 22. Remaining visual debt

1. **`Panel`'s fixed body padding** — PLATFORM ENHANCEMENT, §7. The preview is inset by 16px it does
   not want.
2. **`Stepper` has no per-step status** — PLATFORM ENHANCEMENT, §11. Until it does, no approval
   chain in any product can use it.
3. **Pluralisation** — §21. FUTURE ENHANCEMENT, and the highest-value item on this list because it
   is visible to every user on every list screen.
4. **The other twelve hand-rolled headings** in search, reports, notifications, permissions and the
   numbering-reservations screen. Same defect, same one-line fix, not audited in this phase.
5. **The library toolbar wraps to a second line at 1280px**, putting "Columns" alone beneath the
   search box. Observed in the baseline, not fixed: it needs a grouping decision about which controls
   are filters and which are actions, which is a design question rather than a substitution.
6. **No visual baseline for any dialogue**, including the ceremony — the harness renders static
   markup. Recorded since Phase 6.6, still true.

## 23. Gates

Every gate re-run after the change; nothing carried over.

| Gate | Result |
| --- | --- |
| `pnpm format` | clean |
| `pnpm lint` | **0 errors**, 7 warnings — all pre-existing `import()`-type-annotation warnings |
| `pnpm typecheck` | 13/13 |
| unit | web **137** · api **645** (1 skipped) · domain 164 · contracts 26 · utils 11 · i18n 4 · worker 2 |
| `pnpm build` | 9/9 |
| `pnpm verify:styles` | 10/10 |
| visual + responsive (real Chromium) | **79 passed** |
| accessibility (axe) | **15 passed**, including 2 new record-page tests |
| **e2e — `signing.e2e.spec.ts`** | **27 passed, 0 failed** (real API, real Redis, real PostgreSQL, production build, real Chromium) |
| e2e — `recovery.e2e.spec.ts` | env-gated failure (`DR_DEST_ADMIN_URL` unset) — pre-existing, unrelated |
| integration | not re-run: **no API or package code changed** beyond three i18n strings, and the API suite passed unchanged in Phase 7.1C. Stated rather than claimed as fresh |

## Evidence vocabulary

**IMPLEMENTED** — nine sections on `Panel`, the approval instance on `Surface`, two card wrappers
removed, nine section actions at `sm`, nine semantic icons, the ceremony's `Stepper`, two tightened
grid gaps, three i18n step labels. **VERIFIED** — 79 visual and responsive tests in real Chromium
including every contrast assertion in both themes; 15 axe tests including two new ones for a screen
that had none; 27 E2E tests in the running application at six widths; every changed baseline opened
and inspected. **KNOWN LIMITATION** — the preview's 16px inset; no dialogue baseline; the toolbar
wrapping at 1280. **PLATFORM ENHANCEMENT** — `Panel` body padding; `StepperStep` status. **FUTURE
ENHANCEMENT** — pluralisation in `@edms/i18n`; the twelve remaining hand-rolled headings; `StatCard`
affordances for a permission-gated tile. **RAISED, NOT ANSWERED** — whether the dashboard's
`CountStat` should become a platform capability.
