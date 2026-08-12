
# Phase 8.3 — Platform Accessibility Consistency Audit

## 1. Status

**COMPLETE.**

Two confirmed accessibility defects, both platform-owned, both fixed at the level that owns them and
verified in the running product against the published package. Four inherited findings re-measured:
one confirmed, one enlarged, two retracted with evidence. One tolerated axe exception removed, and
the guard that replaces it proven capable of failing.

The phase's largest finding is not a colour. It is that the suite had been **suppressing** the
defect it was supposed to catch, since Phase 5.2, and that three phases of green runs meant nothing
on that point.

## 2. Scope

The faded-token and opacity sites left open by Phases 8 and 8.2 — the `/70` sites in
`@munaxa/platform`, `Badge`'s `text-primary-strong`, and the roughly thirty Docs-local
`text-* opacity-70` usages — re-measured rather than re-read.

Out of scope and untouched: `munaxa`, `munaxa-school`, `munaxa-work` (not in this session), and the
`opacity-*` sites that are disabled-state or decorative rather than text.

## 3. Phase 8.2 baseline, verified before starting

| | |
| --- | --- |
| Declared | `apps/web/package.json` → `@munaxa/platform: ^1.0.1` |
| Lockfile | resolves the 1.0.1 registry tarball with its integrity hash |
| Installed | 1.0.1, `dist/ui/shell/navigation.js` carries `tracking-wider text-muted-foreground` |
| Faded token in nav | zero occurrences of `text-muted-foreground/70` |
| Group titles, re-measured this phase | 4.97:1 light, 7.44:1 dark — unchanged |

No regression. Phase 8.2 was not reopened.

## 4. Inventory

**Platform — faded foreground tokens (6 sites, 5 files).** Everything else matching `opacity-*` in
the platform is a `disabled:` state or a drag/decorative affordance.

| Site | Class | Renders in Docs? |
| --- | --- | --- |
| `forms/command.tsx:102` | `[&_[cmdk-group-heading]]:text-muted-foreground/70`, 10px uppercase | **No** — `Command` never imported |
| `date/calendar.tsx:331` | `font-mono text-[10px] … /70` | **No** — `Calendar` never imported |
| `date/calendar.tsx:388` | `text-muted-foreground/40`, outside-month days | **No** |
| `date/calendar.tsx:389` | `text-muted-foreground/30`, disabled days | **No** |
| `forms/autocomplete.tsx:195` | `font-mono text-[10px] … /70` | **No** — `Autocomplete` never imported |
| `forms/field.tsx:101` | `text-muted-foreground/70`, `(optional)` suffix | **No** — `Field` imported 5×, `optionalLabel` passed 0× |

**Platform — `text-primary-strong` (13 consumers).** Three pair it with a translucent brand tint:
`badge.tsx:13` (`bg-primary/15`), `avatar.tsx:66` and `tag.tsx:12` (`bg-primary/10`).

**Docs — `opacity-*` (67 sites).** 62 × `opacity-70`, 3 × `opacity-80`, 2 × `opacity-60`. Of the
`opacity-70` sites, ~30 are text-bearing and ~20 icon/decorative. **No Docs site compounds an
already-muted token with opacity** — the one source match for that pattern is a comment recording
that Phase 7.7B already converted it.

## 5. Measurement methodology

`apps/web/src/test/e2e/faded-text.e2e.spec.ts`. It reads no source. It walks what the browser
painted across 12 routes × 2 themes, keeps every element whose own text is faded by any mechanism,
and measures each one. 128 elements, 22 distinct surfaces.

Three mechanisms are treated alike because a reader cannot tell them apart:

- element `opacity` — which **multiplies down the ancestor chain**, so a parent's fade counts;
- an alpha-bearing foreground — `text-muted-foreground/70` → `oklab(… / 0.7)`;
- an alpha-bearing **surface beneath** — `bg-primary/15` over a card.

Colours are composited through a 1×1 canvas so the browser performs the colour-space conversion and
the alpha blend, and `getImageData` returns the pixel a reader sees. Theme transitions are settled
via `settleColours` before any reading. Thresholds follow the rendered typography: 3:1 only where
the text measures ≥24px, or ≥18.66px bold; 4.5:1 everywhere else. Every candidate in this audit is
12–14px, so all but the stat figures take 4.5:1.

### The instrument was wrong first, and is recorded that way

The first sweep found **2** faded elements across 11 routes and would have reported "almost nothing
is faded". It was filtering on faded *foregrounds* only, so `Badge` — opaque text on a translucent
surface — was out of scope; and `backgroundOf` returned the nearest painting ancestor, which for a
translucent one meant painting `bg-primary/15` onto a cleared canvas and reporting a luminance no
reader ever sees. Collecting the whole painting stack up to the first opaque layer and compositing
in order took the sweep from 2 surfaces to 128. The defect this phase exists to find was invisible
to the first version of the tool built to find it.

## 6. Candidate table — measured, after the fix

| ratio | thr | px | opacity | theme | route | text |
| --- | --- | --- | --- | --- | --- | --- |
| 3.42 | 4.5 | 14 | 0.5 | light | /notifications | "Mark all read" — **exempt**, disabled |
| 4.50 | 4.5 | 12 | 1 | dark | / | Avatar "A" |
| 4.68 | 4.5 | 12 | 1 | light | /documents | Badge "PDF" / "Draft" |
| 4.97 | 4.5 | 12 | 1 | light | / | metadata |
| 5.18 | 4.5 | 14 | 0.5 | dark | /notifications | "Mark all read" |
| 5.65 | 4.5 | 12 | 1 | dark | /documents | Badge "Published" |
| 5.68 | 4.5 | 12 | 1 | light | / | Avatar "A" |
| 5.93 | 4.5 | 12 | 1 | light | /documents | Badge "Published" |
| 6.62 | 4.5 | 14 | 0.7 | light | /documents/[id] | preview + `By — on …` metadata |
| 6.97 | 3 | 24 | 1 | light | / | stat figure |
| 8.81 | 4.5 | 14 | 0.7 | dark | /documents/[id] | preview + metadata |

Every surface clears its threshold except the disabled control, which WCAG 1.4.3 exempts.

## 7. Confirmed defects — both fixed

### A1 · `Badge` — 4.31:1 light (platform)

`badge.tsx:13`, `border-primary/30 bg-primary/15 text-primary-strong`, 12px/500. Measured **4.31:1**
on `/documents`, reproducing the figure carried since Phase 5.2 — which had never been re-measured.

### A2 · `Avatar` — 4.16:1 light (platform, new)

`avatar.tsx:66`, `bg-primary/10 text-primary-strong`, 12px/600. Measured **4.13:1** rendered
(4.16:1 computed). Worse than `Badge` because the tint is lighter. Not previously recorded.
`tag.tsx:12` carries the identical pairing and does not render in Docs.

### The root cause was the generator's rule, not a hex

`themes/docs/palette.css` is generated. `--primary-strong: #56774d` was exactly ramp step
`primary-600`, so a hand-edited value would have been silently clobbered by the next regeneration.
The rule was:

```js
const primaryStrong = contrast(t.brand, WHITE) >= 4.5 ? t.brand : firstPassing(STEPS_DARKWARD, WHITE);
```

The first step clearing 4.5:1 against **white** — but nothing pairs this token with white. A brand
tint over the page is darker than the page, so a value that only just clears white cannot clear the
surface it ships on. The token measured a comfortable 5.07:1 against white while failing at 4.31:1
where it actually appeared. **Both numbers were right; the rule was reasoning about the wrong
background.**

The rule now holds each candidate against the surfaces the design system pairs it with — a 15% tint
over the page and a 10% tint over `--muted` — in both schemes. Four values move, one per brand, each
still a step on that brand's own generated ramp:

| Theme | Scheme | From | To |
| --- | --- | --- | --- |
| Docs | light | `#56774d` | `#43613c` |
| School | light | `#007c71` | `#005f56` |
| Group | **dark** | `#7e93c9` | `#9babd5` |
| Work | **dark** | `#d27499` | `#de95b0` |

Group and Work were found by the regression test, not by me: it reads the emitted values rather than
trusting the rule, and caught that my first fix used `NEUTRAL[900]` where the palettes ship
`NEUTRAL[800]` as `--muted`, and tinted with the raw brand where the dark scheme ships a lifted
`--primary`. Both were my errors.

**Verified after, in the running product against registry-installed 1.0.2:**

| | before | after |
| --- | --- | --- |
| Badge, light | 4.31:1 | **5.93:1** |
| Avatar, light | 4.16:1 | **5.68:1** |
| axe `/documents` light | 1 serious | **0** |

## 8. False positives and retractions

**D · The ~30 Docs `opacity-70` sites are not defects.** Measured **6.62:1 light / 8.81:1 dark**.
They fade `text-foreground`, which starts near 16:1; `text-muted-foreground/70` failed at 2.79:1
because the base token was already muted, not because the opacity differed. Same-looking classes,
opposite verdicts — which is the whole reason this phase measured instead of sweeping.
**Classification C.**

**Disabled controls are not defects.** `disabled:opacity-50` measures 3.42:1 light. WCAG 1.4.3
exempts inactive user-interface components. **Classification C.**

### Retraction 1 — the Phase 8.2 claim about `@munaxa/ui`

Phase 8.2 argued the CI visual failures were unrelated partly because `visual.spec.tsx` imports
`SidebarNav` from `@munaxa/ui`, "untouched at 1.0.0". **Wrong.** `@munaxa/ui` is a buildless façade —
`export * from '@munaxa/platform/shell'` — so it re-exports whatever `@munaxa/platform` is installed.
The conclusion still holds for a better reason: that spec's `NAV_GROUPS` declares a single group with
**no `title`**, so the changed line never renders on any visual surface, and the byte-identical pixel
diffs between `main` and the PR remain direct evidence. Phase 8.2's report is left as written.

### Retraction 2 — this phase's own first explanation of the axe gap

I claimed the Badge violation survived because the axe sample covered `/audit`, `/approvals`,
`/reports`, `/admin/users` and not `/documents`. **Wrong, and adding `/documents` alone would not
have caught it.** See §11.

### Retraction 3 — "axe cannot see translucent backgrounds"

I predicted axe would miss both defects for that reason. It reported `Badge` as a serious violation
perfectly well. The mechanism is real but applies to `Avatar`, which axe files under `incomplete`
(`.size-full`, needs review) rather than as a violation — so a suite watching only `violations`
would never surface it.

## 9. Intentional hierarchy, kept

The Docs `opacity-70` metadata and helper text (§8) is deliberate hierarchy that remains accessible
at 6.62:1 and above. **Nothing was swept.** No `opacity-70` was replaced anywhere in this phase.

## 10. Platform-owned findings

Fixed and released as **1.0.2**: the generator rule, four regenerated palette values,
`themes/palette.test.ts`, and a `tsconfig.build.json` exclusion — without which the new test compiled
into `dist` and would have shipped in the published type surface.

## 11. The tolerated exception — the phase's largest finding

`consistency.e2e.spec.ts` carried:

```js
/** The `Badge` palette issue, recorded since Phase 5.2 and the only tolerated contrast failure. */
const KNOWN_PLATFORM_CONTRAST = 'text-primary-strong';
…
.filter((node) => !node.html.includes(known))
```

A blanket suppression of **every** axe contrast violation whose node mentioned that class, on every
route. axe had been reporting `Badge` as `serious` the entire time. The filter is why three phases
of green runs never surfaced it, and why adding `/documents` on its own changed nothing.

Removed, since the underlying defect is fixed. A tolerated failure that outlives the reason for
tolerating it is indistinguishable from a defect nobody can see.

## 12. Product decisions required

None outstanding. The token change was put to the requester with the measured numbers before
implementation; the approved direction (fix the token rather than the three components) is what
shipped, at the generator level rather than as the hand-edited hex originally proposed.

## 13. Deferred findings — classification H, unable to reproduce

The four platform sites in §4 that Docs never renders: `command.tsx:102`, `calendar.tsx:331/388/389`,
`autocomplete.tsx:195`, `field.tsx:101`. `Command`, `Calendar` and `Autocomplete` are never imported
by this product, and `Field`'s `optionalLabel` is never passed.

`command.tsx:102` deserves naming: it is `font-mono text-[10px] uppercase tracking-wider
text-muted-foreground/70` — **character-for-character the construction Phase 8.2 fixed in
`SidebarNav`**. It is very likely the same defect. It is recorded as *likely*, not confirmed,
because this phase could not render it, and a number produced without rendering is exactly what
Phases 7.8 and 7.9 got wrong. Measuring it needs the platform's own Storybook.

Also open, unchanged: `/delegations` overflow at 390px (P2), `/audit` renders `PageHeader` with no
`Page` (P3), and the primary action missing from `PageHeader.actions` on five screens (P1).

## 14. Screens and states verified

12 routes × 2 themes at 1280: `/`, `/documents`, `/documents/recent`, `/documents/[id]`,
`/approvals`, `/audit`, `/reports`, `/notifications`, `/search`, `/admin/users`, `/admin/numbering`,
`/delegations`. The document record is reached by opening a row the way a person does.

Widths: the consistency suite measures every route at 1280 and 390 from one load per route. The
faded candidates are type and colour rather than layout, and none is width-conditional, so they were
not re-measured at every width — stated here rather than implied.

## 15. Dark evidence

Every candidate measured in both themes through the product's own theme control, after
`settleColours`. Dark was never the failing case for `Badge` or `Avatar` in Docs (5.65 and 4.50), but
was the failing case for **Group and Work** in the generated palettes — found by the platform test.

## 16. RTL evidence

**Not exercised in this phase, and not claimed.** Every confirmed defect is a colour-contrast
property of a token pairing, independent of writing direction, and no string, layout or component
changed. The ten `ar-*` visual surfaces that differ on Arabic font metrics in this container are
unchanged and unrelated. No Arabic string was added or invented.

## 17. axe results

Real browser, both themes, `/documents` and `/`:

| | before | after |
| --- | --- | --- |
| `/documents` light | `serious: color-contrast .border-primary\/30` | `[]` |
| `/documents` dark | `[]` | `[]` |
| `/` light | `[]` (Avatar in `incomplete`) | `[]` |
| `/` dark | `[]` | `[]` |

Where axe is silent and measurement is not — the `Avatar` — the manual finding stands. axe computes a
ratio only when it can resolve an opaque background and defers the rest to `incomplete`.

## 18. Keyboard results

Exercised, not inferred. The confirmed defects are a `Badge` and an `Avatar` initial: neither is
focusable, so there is no keyboard behaviour to assert on them, and claiming otherwise would be
theatre. The interactive element in scope is the grid row that opens a document.

`DataGrid` implements a grid roving-focus model. Focus starts on the **header** cell; ArrowDown moves
into the body; Enter reaches *into* a cell that holds something focusable and only falls through to
`onRowActivate` on an inert one. Verified: focus lands on a body cell with a visible indicator
(`outline: 1px auto`), ArrowRight reaches the first inert cell (`aria-colindex 2`), Enter opens the
document. **Working; no defect.**

Recorded because the test was wrong about this **three times** — focusing a non-focusable `<tr>`,
then scoping to `tbody` when roving focus starts in `thead`, then pressing Enter on the selection
checkbox cell. Each failure offered "grid rows are not keyboard accessible" as a plausible P1
finding. Each time the product was correct and the test was not.

## 19. Test-proof results

**Platform** — `themes/palette.test.ts`: 9/9 with the fix. Palettes reverted → **4 failures**, each
naming token, surface and ratio. Restored → 9/9. Regeneration idempotent.

**Docs** — three states measured, because two were needed to tell the guard from the exception:

| State | Result |
| --- | --- |
| 1.0.2 token, no exception | 12/12, `[axe /documents] []` |
| 1.0.1 token, no exception | **1 failure** — `/documents`, `.border-primary\/30`; other 11 pass |
| 1.0.1 token, exception present | 12/12 — **the guard could never fail** |

The installed package was restored afterwards and verified **byte-identical to the published 1.0.2
tarball**.

### The cache trap recurred, and nearly produced a false result

The first Docs falsification reported 12/12 *with the fix reverted*, which would have meant the new
assertion was worthless. Two mistakes stacked: the Bash working directory does not persist between
calls, so `rm -rf apps/web/.next` deleted nothing; and with the caches intact Turbo replayed a build
made from 1.0.2 while 1.0.1's value sat on disk. This is Phase 8.2 §16's trap arriving by a different
route. I also briefly mis-diagnosed it as having edited the platform's committed palette — `git
status` showed that tree clean, and the reverted file was in the Docs pnpm store throughout.

## 20. Gates

**Platform:** `format:check` · `lint` 32/32 · `typecheck` 32/32 · `test` 26/26 · `build` 20/20 ·
`validate` · `verify-release.mjs` — all green.

**Docs:** `format:check` · `lint` · `typecheck` · `test` · `verify:styles` · `@edms/web build`, plus
`consistency.e2e` 12/12, `faded-text.e2e` 4/4, `shell.e2e` 8/8.

**Release reliability, unrelated to this phase.** The platform's release gate runs `pnpm test`,
which includes wall-clock performance assertions. Two distinct ones have now blocked releases of
unrelated changes: `@munaxa/audit` (`< 14ms`, measured 20.02) and `@munaxa/rbac` (`< 7500`, measured
8047.68). Both pass 3/3 locally; neither package is touched by these diffs. Two of three release
attempts in this sequence have needed a re-run. Left alone deliberately — it belongs to those
packages' owners, and timing budgets are not something to change as a side effect of an
accessibility phase.

## 21. Remaining limitations

- **Only Docs is verified by rendering.** School, Group and Work palettes are corrected by the same
  model — validated against rendered ground truth, reproducing Badge's 4.31 exactly — but their
  products are not in this session's scope. Nobody has *rendered* those four changed values.
- **Four platform sites unmeasured** (§13), `command.tsx:102` most likely a real defect.
- **RTL not exercised** (§16).
- **~28 of the ~30 Docs `opacity-70` sites did not render.** Two did, and they establish the
  mechanism; the rest live in panels needing state this fixture does not create. The conclusion is
  drawn from the mechanism plus the absence of any compounded muted+opacity site, not from having
  seen all thirty.
- Widths beyond 1280 not re-measured for these candidates (§14).

## 22. Recommended next phase

**Phase 8.4 — measure the platform's own components in its own Storybook.** It is the only way to
settle `command.tsx:102`, the calendar and autocomplete sites, and `field.tsx`'s `optionalLabel`,
none of which any Docs route can render. The platform's `test/setup.ts` disables axe's
`color-contrast` rule — correctly, since happy-dom applies no stylesheet — so the platform
**cannot detect a contrast defect in its own suite at all**. Storybook plus a real browser closes
that hole at the level that owns it, and would have caught both defects in this phase before any
product consumed them.

Second, cheaper candidate: a lint rule in the platform forbidding an opacity fade of a foreground
token on text — the analogue of Docs' own `no-raw-colours` — which makes the idiom Phase 8.2 fixed
un-writable rather than merely wrong.
