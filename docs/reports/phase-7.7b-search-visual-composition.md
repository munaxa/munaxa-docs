# Phase 7.7B — Search Visual Composition & Populated Results

## 1. Status

**COMPLETE.**

Every item on the phase's completion list has evidence behind it: a really-indexed document, a real
populated Search screen rendered and looked at, `Rev Rev 0` fixed, A2 implemented, A3 corrected and
then fixed at its real cause, six widths, dark, Arabic at 1280 and 390, live axe with zero critical
and zero serious, keyboard traversal, a real click that really navigated, and four regression tests
each proved able to fail. Phase 7.7A's fix and its six-width suite are intact and re-proved.

Two things are recorded as **findings rather than changes**, and neither is Search's: the E2E
fixture writes a revision label the domain would never mint (§6), and the application's page canvas
does not adopt the dark theme (§11). Both are stated with measurements.

## 2. Objective

Bring Search to the visual quality of the completed Library and Dashboard work, using the shared
platform only, and produce the first real populated-results evidence this screen has ever had.

## 3. How the screen was populated — the mechanism, once, for the record

The blocker was cleared in the previous pass and is not re-investigated here. The path:

```
browser login → edms_at cookie (the session's own access token)
  → POST http://127.0.0.1:3001/api/v1/search/rebuild      202 RUNNING
  → GET  http://127.0.0.1:3001/api/v1/search/rebuild      polled until not RUNNING
  → SearchRebuildService → SearchProjectionService → search_index_entry
  → the real Search UI → a real result
```

`lib/session.ts` keeps the access token in `edms_at` and the web app forwards it to the API, so
reading that cookie from the authenticated context is the application's own credential. Nothing was
signed, minted, bypassed or stubbed; no test-only endpoint exists; no row was written into the index
by hand. `bootstrap.ts` sets a global `api` prefix and URI versioning, which is why the earlier
attempt against the *web* origin was answered by Next.js's catch-all with HTML.

Everything below ran against real PostgreSQL 16.13, real Redis, the real API artefact, the
production web build and a real login.

## 4. The populated screen, as it was before this phase

`search-populated-1440.png`, captured last pass and **opened and inspected** at the start of this
one:

```
Status            1 of 1 results
  Draft   1       Batch release procedure                    [SOP-E2E-0001] [✎ Draft] Rev Rev 0
Type                Content indexing pending  8/11/2026
```

Three defects, none of which any previous phase could have seen:

1. **`Rev Rev 0`** — the revision named twice.
2. **The revision was clipped by the card's own right border.** The page had no horizontal
   scrollbar, so a document-level overflow check called the screen clean.
3. **Seven hundred pixels of nothing between the title and its own status.** `flex items-center`
   with a `flex-1` title pushed the number, status and revision against the right edge of an 845px
   column, so a document and its state read as two unrelated facts.

## 5. FIXED — `Rev Rev 0`, traced rather than guessed

The data flow, read end to end:

| Step | What it holds |
| --- | --- |
| `revision-label.ts` → `revisionLabelFor` | mints `Original` (ordinal 0), `R1`, `A`, `1.0` — by style |
| `prisma-revision.writer.ts` | calls it **once, at creation**, and stores the string |
| `searchHitSchema` | `revisionOrdinal: number \| null`, `revisionLabel: string \| null` |
| `search-projection.service.ts` | copies the stored label; adds nothing |
| `search-screen.tsx` | wrapped it in `search.revisionLabel` = **`'Rev {label}'`** |

So the API contract is correct and the presentation layer was not. Every label the domain can mint
is already the revision's whole name, and the prefix produced `Rev R1`, `Rev Original`, `Rev 1.0` —
and, against the E2E fixture's label, `Rev Rev 0`. The approval panel (`approval-panel.tsx:358`) and
the signature panel (`signature-panel.tsx:226`) have always rendered the label bare; Search was the
only screen adding a prefix.

**The fix is one line of presentation** — the label renders as itself — plus the removal of the now
dead `search.revisionLabel` key from the English and Arabic catalogues. No contract, no API, no
schema, no stored value changed.

### Test-proof

The prefix was restored and the suite re-run:

```
× names the revision once
× renders any revision style the domain can mint, unprefixed
  Tests  2 failed | 11 passed
```

Exactly the two revision assertions failed and nothing else. Restored; 13/13.

## 6. FINDING (not changed) — the E2E fixture mints a label the domain cannot

`scripts/e2e-signature-fixture.mjs` writes `label: 'Rev 0'` at three places by direct insert.
`revisionLabelFor(0, NUMERIC)` returns **`Original`**; no style in the product produces a label
containing "Rev". The fixture is therefore not representative, and it is the reason the duplication
read as *`Rev Rev 0`* rather than as the subtler *`Rev Original`*.

Left as-is deliberately: `signing.e2e.spec.ts` asserts the literal `Rev 0` twice,
`recovery.e2e.spec.ts` reads `fixture.revisionLabel`, and `servers.ts` exports it. Changing the
fixture is a cross-suite edit that belongs to whoever owns the fixture, not to a Search phase. The
jsdom regression test therefore uses **`R2`** — a label the domain really mints — so the assertion
is about the product rather than about the fixture.

## 7. FIXED — A2, the section grammar

| Was | Now |
| --- | --- |
| `<Card className="flex flex-col gap-1 p-3"><h3 className="text-sm font-medium">` per facet | `<Panel title={…}>` |
| `<section><h2 className="text-lg font-medium">` for saved searches | `<Section title={…} gap={2}>` |
| `<section><h2 className="text-lg font-medium">` for recent searches | `<Section title={…} gap={2}>` |
| nine `opacity-60/70/80` fades | `text-muted-foreground` |

`Panel` was chosen from the platform's own note on it — *"the building block of inspectors, **filter
panels**, side rails and property lists"* — not by defaulting every heading to it. It supplies the
shared header treatment (`font-display text-sm font-semibold`) and, because it labels the region,
each facet group becomes something a screen-reader user can jump between instead of walking every
option in all three. `Section` does the same for saved and recent searches at `text-lg`.

The opacity change is worth stating precisely: `opacity-70` fades the *rendered* pixel, so the
result depends on what is behind it and drifts between themes. `text-muted-foreground` is the
platform's own token. **No colour, font, radius, shadow, spacing token or primitive was created.**

### Test-proof

The facet `Panel` was reverted to `Card` + `<h3>`:

```
× exposes each facet group as a region a reader can jump to
× keeps one h1 and puts every section heading beneath it
  Tests  2 failed | 11 passed
```

## 8. A3 — MISDIAGNOSED, then fixed at its real cause

Phase 7.7 recorded the result count as "orphaned and centred". The previous pass, seeing a populated
screen, reported that as **wrong**. Both renders now exist, and the truth is a third thing.

**Populated (`search-populated-1440.png`):** the count sits left-aligned directly above the result
list. Nothing wrong. Not changed.

**Zero results (`search-zero-results-1440.png`, captured this phase):** `0 of 0 results` began 272px
in from the content edge with nothing beside it — the "floating in the middle" reading, exactly.

The cause is not the count. A search that matches nothing returns **no facet buckets**, `FacetGroup`
returns `null` for every one of them, and the `aside` rendered anyway — an empty `md:w-64` column
plus a `gap-4`, pushing the whole results column 272px right. Nothing was centred; an invisible
element was moving it.

So the rail is now rendered only when it has something in it — facet buckets, or an active filter,
because "Clear filters" is the way out of a search that filtered everything away and removing it
would strand the reader. The empty state also gains the full measure. **The count itself was not
moved**, which is what the populated render said to do.

### Test-proof

`facetsPresent(...)` was replaced with `true`:

```
× lays out no filter rail when a search matches nothing
  Tests  1 failed | 12 passed
```

## 9. FIXED — the populated result composition

```tsx
<Stack direction="horizontal" gap={2} align="center">
  <span className="min-w-0 truncate font-medium">…title…</span>
  <div className="shrink-0"><DocumentStatusBadge status={hit.status} /></div>
</Stack>
…body highlights, when the API returns them…
<Stack direction="horizontal" gap={2} align="center" wrap className="text-muted-foreground text-xs">
  type · number · revision · date · provenance badges
</Stack>
```

- **Two lines, as Phase 7.6B settled for the dashboard's recent documents.** The two screens read as
  the same product because they are the same composition, not because values were matched by hand.
- **The status sits beside the title, not at the far edge.** `justify="between"` is right for the
  dashboard's 400px panel and wrong for an 845px results column — the one deliberate divergence,
  and it is stated in the code.
- **The document type is new, and it is real.** `typeLabels` is already resolved for the facet rail
  and already passed into this screen; the hit carries `documentTypeId`. The label beside a result
  is the same string the `Type` facet shows above it. `folderId` has no such map, so no folder is
  shown — nothing was invented to fill the line.
- **One badge fewer.** The document number was a `Badge`; it is now plain `tabular-nums` text, like
  the dashboard's. The status badge and the content-provenance badges stay, because each is a state
  rather than a decoration.
- No card inside a card, no new border, no decorative element.

## 10. Facets, saved and recent searches

Facets are rendered from `initialResults.facets` exactly as the API returns them. **No category was
invented** — no Folders, no Metadata, no OCR tab. `searchHitSchema` is a document hit throughout,
`bodySource` is a per-hit attribute, and Phase 7.7's E2 refusal stands unchanged.

Saved and recent searches are real contracts with real create/delete actions; they moved to
`Section` and were otherwise left alone. **Search Tips and Index Status remain unbuilt and were not
invented.**

## 11. FINDING (not changed) — the page canvas does not adopt the dark theme

The dark screenshot shows a dark shell, dark panels and a dark result card over a **light page
canvas**. Measured in the running application rather than judged from the picture:

```
[dark canvas] {"html":"rgba(0, 0, 0, 0)","body":"rgba(0, 0, 0, 0)",
               "main":"rgba(0, 0, 0, 0)","dark":true}
```

All three are transparent, so the browser's default white shows through. This is **product-wide and
predates this phase**: `recent-populated-dark.png` from Phase 7.6E shows the same white canvas
behind the dashboard. It is also not visible in the visual-suite baselines, which render a screen
without the shell — `search-populated-dark.png` there is correctly dark throughout, which is how the
two can disagree.

Not fixed here. Giving the application shell a themed background is a global change, and a
Search-scoped phase is the wrong place to make it. Recorded for the phase that owns the shell.

## 12. Evidence

### Six widths, populated

`search-populated-{1440,1280,1024,768,640,390}.png`, one authenticated session resized six times.
At every width: the title, the status, the type, the number, the revision, the date and
`1 of 1 results` all present; `scrollWidth <= clientWidth`; and — the assertion the clipped revision
demanded — **every descendant of the result card measured inside the card's own bounds**, not merely
inside the page.

### Dark

Through the top bar's own toggle, never by setting a class. Content intact, revision intact, nothing
clipped. The canvas finding is §11.

### Arabic / RTL

Through the real `edms_locale` cookie, at 1280 and 390. `html[lang="ar"]`, `html[dir="rtl"]`
asserted. Inspected: the heading, the controls, the count, the title, the Arabic status
(`مسودة`), the facet panels (`الحالة` / `النوع` / `السنة`) and the metadata line all mirror, while
`SOP-E2E-0001`, `Rev 0`, `Standard operating procedure` and `8/11/2026` stay coherent LTR runs
inside the RTL line. No overflow at either width. **No Arabic wording was invented** — every string
is an existing catalogue entry, and the one key this phase touched was *removed*, not added.

### Live axe

Injected `axe-core` against the real populated page at 1440, colour-contrast left **on**:

```
0 critical, 0 serious
```

### Keyboard

The screen was actually operated. Walking forward from the query field reaches the submit button, a
facet control (`aria-pressed`) and the result link, with a visible ring at the stops. No arbitrary
number of Tab presses is asserted — that would test the DOM order rather than whether a person can
work.

### Real navigation

A real click on the real result, followed to `/documents/{id}`, asserted on the resulting URL *and*
on the document number in the destination. Not `page.goto`, not an `href` read, no router mock.

## 13. Regression tests

| # | Test | Proved able to fail by |
| --- | --- | --- |
| 1 | revision named once (2 assertions, jsdom) | restoring `Rev {label}` → 2 failed |
| 2 | facet groups are labelled regions; one h1 (A2) | reverting `Panel` → `Card` + `<h3>` → 2 failed |
| 3 | no filter rail when nothing matches (A3) | forcing the rail on → 1 failed |
| 4 | six-width bar behaviour (Phase 7.7A) | `sm:basis-auto` → **1440/1280/1024/768/640 failed, 390 passed** |
| 5 | populated result rendering — type, status, number, date, no key leak | covered by 1–3's shared render |
| 6 | real result navigation (E2E) | — |
| 7 | dark populated (E2E) | — |
| 8/9 | Arabic populated at 1280 / 390 (E2E) | — |

Test 4's result is the discriminating one: a fix for the desktop wrap that quietly undid Phase 7.1's
390px behaviour would have failed there too, and it did not. **No assertion was weakened to obtain
green**, and `PIXEL_TOLERANCE` was not lowered.

`apps/web/src/features/search/search-results.spec.tsx` is new — 13 tests.
`apps/web/src/test/e2e/search.e2e.spec.ts` grows from 9 to **23**.

## 14. Gates

| Gate | Result | Notes |
| --- | --- | --- |
| `pnpm format:check` | PASS | |
| `pnpm lint` | PASS | 13/13 |
| `pnpm typecheck` | PASS | 13/13 |
| `pnpm test` | PASS | 13/13 — API 645, web incl. the 13 new |
| `pnpm --filter @edms/web build` | PASS | rebuilt four times (change, proof, restore, final) |
| `pnpm verify:styles` | PASS | 10/10 |
| **Search E2E** | **PASS** | **23/23** against the real stack |
| `pnpm test:visual` | PASS | 97 pass / 10 fail — all ten the **pre-existing** Arabic-font surfaces |
| Integration | **NOT RUN** | no API, schema or package behaviour changed — the only package edit is the removal of one dead message key |

## 15. Baselines

| Baseline | Change | Inspected |
| --- | --- | --- |
| `search-light` / `search-dark` | zero-result state, now without the empty rail | yes — count at the content edge, empty state on the full measure |
| `search-populated-light` / `search-populated-dark` | **new** | yes — `R2` once, title dominant, metadata one quiet line, dark fully dark |

The visual suite reported 12 failures on the first run — the ten known Arabic surfaces plus these
two, which is the change this phase intended — and returned to ten after acceptance. Both changed
baselines were **opened and looked at** before acceptance, not accepted from a pixel count.

## 16. Final audit

Asked of the finished screen, against `search-populated-1440.png`:

- **Does it belong to the same system as Library, Dashboard and Document Record?** Yes — same page
  frame, same `Panel`/`Section` headers, the dashboard's own two-line document composition.
- **Can a reader tell what they searched, how many results there are, what each result is, its
  status, useful metadata, and how to open it?** Yes, in that order down the screen.
- **Is anything competing with the document title?** No. It is the only `font-medium` at full size
  on the row; everything else is `text-xs text-muted-foreground`.
- **Anything decorative without a reason?** No. Every badge is a state the contract carries.
- **Any raw i18n key?** No — asserted in both jsdom and Arabic E2E.
- **Any unsupported feature?** No. No result-type tabs, no Search Tips, no Index Status.
- **Any unexplained spacing?** No. Spacing is `Stack`/`Section`/`Panel` scale steps.

## 17. Classification

| Verdict | Item |
| --- | --- |
| **FIXED** | `Rev Rev 0`; A2 section grammar; A3 (at its real cause — the empty rail); populated result composition; nine `opacity-*` fades → the muted token |
| **VERIFIED** | real indexed document; populated UI; six widths; dark; Arabic 1280 + 390; live axe 0/0; keyboard; real click navigation; Phase 7.7A still 6/6 |
| **MISDIAGNOSED** | A3 as written ("count orphaned and centred") — corrected; the count was never moved |
| **DEFERRED** | the E2E fixture's non-domain `Rev 0` label (§6) — cross-suite, not Search's |
| **NOT VERIFIED** | axe in dark and in Arabic — run in light at 1440 only, and not claimed beyond that |
| **PLATFORM / PRODUCT GAP** | the page canvas does not adopt the dark theme (§11), product-wide; and Phase 7.7A's note that `Input`'s `w-full` makes `basis-auto` unusable in a flex row still stands |

## 18. Preserved

Phase 7.7A's `sm:basis-0` is untouched and its six-width suite passes against the real stack, with
the 390px behaviour Phase 7.1 introduced asserted explicitly. No Arabic string, API contract,
permission, facet or search semantic was altered.
