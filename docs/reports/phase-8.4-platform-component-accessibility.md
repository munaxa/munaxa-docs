
# Phase 8.4 — Platform Component Accessibility Verification

## 1. Status

**COMPLETE.**

The platform now has a real-browser accessibility path with `color-contrast` enabled, proven able to
fail before its silence is trusted. It found **seven** contrast defects on its first run — none of
which the platform's own suite, or any audit of a consuming product, could have seen. All are fixed
and released as `@munaxa/platform` **1.1.0**, consumed by Docs and verified end to end.

Every item Phase 8.3 was forced to defer as "H — unable to reproduce" is now measured. **All four
were real defects.**

## 2. Objective

Move accessibility verification to the repository that owns the components, so the platform catches
its own defects before a product does. Phases 8.2 and 8.3 each found one only after it shipped.

## 3. Phase 8.3 baseline, verified before changing anything

| | |
| --- | --- |
| `main` | `45d9768` |
| Package / published | 1.0.2 / 1.0.2 |
| Docs consumed | `^1.0.2` |
| Generator fix | present (`tintedSurfaces`, `clearsAll`) |
| Generated tokens | docs `#43613c`, school `#005f56`, group dark `#9babd5`, work dark `#de95b0` |
| Phase 8.2 nav fix | present at `navigation.tsx:92` |
| `themes/palette.test.ts` | present |

Gates run before changes: all green. Nothing from 8.2 or 8.3 was modified.

## 4. Platform test architecture — the nine questions

1. **Storybook available?** Yes — `.storybook/`, 21 story files, `@storybook/addon-a11y` installed.
2. **Renders real CSS?** Yes. `preview.css` imports `tailwindcss` and the real
   `themes/base/base.css`, and `@source '../ui'` makes Tailwind scan the actual components. No mock.
3. **Real Chromium?** Not before this phase — no browser driver existed. Added `playwright`.
4. **axe against rendered DOM?** Now yes, via the new harness.
5. **Light/dark?** Yes — `preview.tsx` toggles `.dark` on the root through a global.
6. **All four brands?** Yes — `brand-themes.ts` reads each real `palette.css` and re-scopes it to
   `[data-brand="<id>"]`, so all four coexist and the toolbar swaps them by attribute.
7. **Could the runner detect contrast?** **No.** That is the gap this phase closes.
8. **Why is `color-contrast` disabled today?** Correctly: happy-dom applies no stylesheet, so every
   element resolves transparent-on-transparent and axe would fire on clean markup.
9. **Smallest correct improvement?** Add a browser driver to the component environment that already
   exists. No new component framework, no second Storybook, no mocked CSS.

## 5. The harness

`test/a11y/`, run by `pnpm test:a11y` against `vitest.a11y.config.ts`.

- `harness.ts` — serves the built `storybook-static` over loopback and drives it with Chromium.
  Stories are opened by Storybook's own `globals` query parameter, so brand and scheme arrive
  through the same code path the toolbar uses. No CSS is injected and no palette is restated.
- `measure.ts` — composited contrast through a 1×1 canvas, background collected as the whole
  painting stack up to the first opaque layer, element opacity multiplied down the ancestor chain.
  Carried from Phase 8.3's Docs instrument, including the two mistakes that shaped it.
- `components.a11y.spec.ts` — the control case, per-brand/scheme axe runs, the deferred states, and
  keyboard.

Colours are settled before every reading (`settleColours`, two agreeing samples, not a sleep).

## 6. axe configuration — the distinction, stated

| Suite | Environment | `color-contrast` | Answers |
| --- | --- | --- | --- |
| `vitest.config.ts` | happy-dom | **disabled** | structural: roles, names, focus, state |
| `vitest.a11y.config.ts` | Chromium + Storybook | **enabled** | computed visual: what is painted |

Neither replaces the other, and the second config exists rather than a project inside the first
precisely so the two cannot be conflated.

## 7. The control case — proving the instrument

A deliberately low-contrast element (~1.6:1) is injected into a rendered story; axe is required to
report it, and the assertion names what it saw when it does not. It is injected at runtime and dies
with the page — it never enters a story file or the component set.

**The first version of this test was wrong** and is recorded that way: it asserted the story started
clean, which coupled the instrument's self-check to the components being defect-free. The story was
not clean — the harness found real violations immediately — so a genuine defect looked like a broken
instrument. It now asserts the *delta*: the control must appear when injected.

## 8. Contrast measurements

### Confirmed defects, before → after (docs brand)

| Component | State | Light before | Dark before | Light after | Dark after |
| --- | --- | --- | --- | --- | --- |
| `Command` | group heading | **2.79** | **4.04** | 4.97 | 6.89 |
| `Calendar` | outside-month day | **1.71** | **2.15** | 4.97 | 7.44 |
| `Calendar` | week number | **2.79** | **4.19** | 4.97 | 7.44 |
| `Autocomplete` | option description | **2.68** | **3.70** | 4.60 | 5.99 |
| `Field` | optional label | **2.79** | **4.19** | 4.97 | 7.44 |
| `Alert` | description on danger tint | **4.31** | 6.98 | passes | passes |
| `Badge` | success / warning / danger | fail | fail | 4.67+ | 5.74+ |

### Unchanged and re-verified, not assumed

| Component | State | Light | Dark |
| --- | --- | --- | --- |
| `SidebarNav` | group title (Phase 8.2) | 4.97 | 6.89 |
| `SidebarNav` | resting item | 4.97 | 6.89 |
| `SidebarNav` | active item | 4.79 | 6.37 |
| `Badge` | default tone (Phase 8.3) | 5.93 | 5.65 |
| `Avatar` | initial (Phase 8.3) | 6.23 | 6.05 |

`Calendar`'s disabled day retains a 30% fade: WCAG 1.4.3 exempts inactive components, and no story
renders one, so it is recorded rather than changed.

## 9. Palette coverage

**All four brands, both schemes** — the question Phase 8.3 could not answer, because only Docs was
renderable there.

The status `-strong` tokens repeated 8.3's defect exactly. That phase fixed `--primary-strong` to be
chosen against the tint it ships on and left `success`, `warning` and `info` on
`darkenToAA(v, WHITE)` — the same white-only rule — because the product it measured renders only the
default `Badge` tone. The rule is now shared by the whole family, and the superseded single-background
helpers are deleted rather than left dead.

`--destructive-strong` is **added**: `success`, `warning` and `info` each had an AA-safe text form and
`destructive` did not, so danger text had to reuse the fill. That is a new token, hence a MINOR
release under `VERSIONING.md`.

`themes/palette.test.ts` now asserts the property for **every** `-strong` token in both schemes —
41 assertions — rather than only the brand's. A test that had described the property rather than the
one instance would have caught this a phase earlier.

## 10. Keyboard coverage

| Component | Interaction | Result |
| --- | --- | --- |
| `CommandPalette` | open, `ArrowDown`, `Escape` | selection moves; Escape handled |
| `SidebarNav` | `Tab` through every rail link | all links reached, focus indicator present |

Both are exercised, not inferred. `Badge`, `Avatar` and `Tag` are non-interactive, so no keyboard
claim is made about them.

## 11. Confirmed defects

Seven, all platform-owned, all fixed in 1.1.0 (§8). The worst is `Calendar`'s outside-month day at
**1.71:1** — selectable dates, so the inactive-control exemption does not apply.

## 12. Retracted / corrected findings

**Phase 8.3's `command.tsx:102` deferral is resolved, and its caution was right.** 8.3 called it
"likely the same defect… recorded as likely, not confirmed, because this phase could not render it."
Rendering confirms it: 2.79:1 light — the same as `SidebarNav` — but **4.04:1 dark, not 4.19:1**,
because the palette surface differs from the sidebar's. Had it been asserted from the class alone,
the dark figure would have been wrong.

**Phase 8.3's suspicion that `shell.stories.tsx` was clean was wrong.** The harness flagged
`.text-muted-foreground/70` in all eight brand/scheme combinations of `Shell/AppShell`. It is not a
regression of 8.2 — `navigation.tsx:92` is intact — but the story's own footer markup kept the exact
idiom 8.2 removed from the component. Fixed in the story.

Phase 8.3's report is left as written.

## 13. Deferred findings

- `Calendar` disabled day (`/30`) — exempt under 1.4.3 and not rendered by any story.
- Docs' `opacity-70` sites — settled in Phase 8.3 (6.62:1 / 8.81:1) and not reopened.
- Out of scope by instruction and untouched: `@munaxa/audit` and `@munaxa/rbac` wall-clock release
  tests, Docs' Arabic visual baselines.

## 14. False-positive discoveries — three of my own mistakes

1. **axe scoped to `#storybook-root` silently skipped every portalled layer.** Dialogs, popovers,
   dropdowns and the command palette all render outside it, so a root-scoped run reported the
   palette story clean while direct measurement read 2.79:1. Scope is now the whole document. This
   is the same shape of false confidence Phase 8.3 found in a suppression — a narrower cause.
2. **The palette test added in Phase 8.3 shipped inside the published package.** It lives in
   `themes/`, which `package.json` publishes; `package/themes/palette.test.ts` is present in the
   1.0.2 tarball on the registry. `files` now excludes it, and 1.1.0's tarball contains **0** test
   files. Introduced by my own prior work and found only by inspecting the artefact.
3. **"Not rendered" twice meant "not reached", not "cannot render".** Calendar week numbers need
   `showWeekNumbers`; the autocomplete hint needs the listbox open. Both would have been wrongly
   recorded as BLOCKED — RENDERING ENVIRONMENT. Story coverage was added for the states that had
   none, and the listbox is opened by interaction.

## 15. Test-proof

**The instrument:** injected bad contrast → axe reports it; removed → clean.

**The implementation:** `command.tsx` reverted to `/70`, Storybook rebuilt from scratch → **exactly
2 tests fail**, light and dark, with the intended assertion and the exact ratios 2.79 and 4.04; the
other 24 pass. Restored → 26/26. No assertion was weakened.

**The palette rule:** covered by `themes/palette.test.ts`, 41 assertions, which caught two dark-scheme
failures my own first fix missed (wrong `--muted` base, and tinting with the raw brand where the dark
scheme ships a lifted `--primary`).

## 16. Gates

**Platform:** `format:check` · `lint` 32/32 · `typecheck` 32/32 · `test` 26/26 (456 tests) ·
`build` 20/20 · `validate` · `verify-release.mjs` *all checks passed* · `build-storybook` ·
`test:a11y` 26/26.

**Docs**, against the registry-consumed 1.1.0 on a build with every cache cleared:

| Suite | Result |
| --- | --- |
| `consistency.e2e` | **12/12**, `[axe /documents] []` |
| `faded-text.e2e` | **4/4**, one sub-4.5 surface — the disabled `opacity-50` control, exempt |
| `shell.e2e` | 8/8 on re-run; **one flaky failure first time**, see below |

`shell.e2e` failed once on "no way to reach navigation on search at 640px", which is the signature
Phase 7.8 recorded for the API rate limit — a missing nav affordance that is really a throttled
request. Two things say it is not this release, and neither is "it passed when I ran it again":
`shell.stories.tsx` is the only shell file 1.1.0 touches, and **stories are not published** — the
installed package contains no `*.stories.*` at all, so that change cannot reach Docs. The log also
carries no `RATE_LIMITED` marker, so the precise cause is unestablished; it is recorded as flaky
rather than explained away.

## 17. Package and release

| | |
| --- | --- |
| Version | **1.1.0** (MINOR — new token) |
| Platform commit | `9d278de`, merged to `main` as `978a544` |
| Release run | `31613853013`, `dry_run=false`, ref `main` → success, **first attempt** |
| Registry | `["1.0.0","1.0.1","1.0.2","1.1.0"]`, `latest` → `1.1.0` |
| Published artefact | 0 test files; `--destructive-strong` present |
| Docs | `^1.1.0`, lockfile resolves the registry tarball with integrity hash |
| Frozen install | `node_modules` wiped → `--frozen-lockfile` → exit 0 |

No `node_modules` patch, no local tarball, no overlay.

## 18. Remaining limitations

- **Storybook is not the product.** These measurements are of components in the documentation site's
  surfaces. Where a product composes them differently — a badge on a card rather than the page — the
  background stack differs, which is exactly why Docs measured `Avatar` at 4.16:1 where the token
  read 5.07:1 against white. The platform harness lowers the chance a defect reaches a product; it
  does not remove the need for product-level measurement.
- **Coverage is story-shaped.** A state no story renders is still invisible. Three such states were
  found and given coverage this phase; others may exist.
- **`incomplete` is recorded but not asserted.** axe defers translucent-background cases, and the
  harness reports them without failing on them.
- **RTL not exercised here.** Every fix is a colour property independent of writing direction, and
  no layout or string changed.
- Four brands × two schemes were covered for Badge and the shell; the deferred states were measured
  on the docs brand only.

## 19. Recommended next phase

**Phase 8.5 — widen the harness from targeted stories to the whole story index, and gate on it.**
`storybook-static/index.json` enumerates every story; iterating it would replace the hand-listed
story IDs with complete coverage, and CI could run `test:a11y` on every change rather than on demand.
The finding that justifies it: this phase measured 12 stories and found 7 defects, and the platform
has 21 story files.

Second, cheaper: a lint rule forbidding an opacity fade of a foreground token on text. Every defect
in Phases 8.2 and 8.4 was that one idiom, written five separate times. A rule would make it
un-writable rather than repeatedly discoverable.
