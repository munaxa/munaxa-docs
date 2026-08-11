# Phase 8.1 — Recent Documents Empty-State Frame & Accessibility

## 1. Status

**COMPLETE.** One defect, one owner, one fix, one evidence package.

`/documents/recent` had no page at all when the list was empty. It does now, and every completion
criterion is met with running-application evidence.

## 2. The original defect

Phase 8 measured, across twelve screens:

```
[grammar recent] {"reachable":true,"h1":null,"h1Count":0,…}
```

**One screen in twelve had no `<h1>`,** and it was the only one.

## 3. Root cause

`RecentScreen` returned the empty state *before* it reached its own frame:

```tsx
if (rows.length === 0) {
  return <EmptyState title={…} description={…} />;   // no Page, no PageHeader, no breadcrumb
}
return <WorkspacePage title={…} breadcrumb={…}> … </WorkspacePage>;
```

So a person who had opened nothing got a page with **no `Page`, no `PageHeader`, no `<h1>` and no
breadcrumb**. A screen reader had nothing to announce it by, and the only way back to the library
was the navigation rail.

It survived six phases of verification because every one of them populated the list first. An empty
Recently-opened screen is what a real person meets on their **first day**, and it was the one state
nobody had rendered.

### Is it unique? — checked, and yes

Every file containing `EmptyState` was scanned for the same early-return shape. Two matched:

| File | Verdict |
| --- | --- |
| `documents/recent-screen.tsx` | **the defect** — its own frame is below the early return |
| `approvals/inbox-screen.tsx` | **not a defect** — its route wraps it in `AdminScreen`, so the early return is already inside a frame. Phase 8 measured `/approvals` at `h1Count: 1`, which confirms it |

No scope expansion, and the check is recorded so a later phase does not repeat it.

## 4. The implementation

The branch moved inside the frame. Nothing else changed — not `EmptyState`, not the populated
content, not a translation key, not a prop, not the API.

```tsx
return (
  <WorkspacePage
    title={translate('documents.nav.recent')}
    breadcrumb={[
      { label: translate('nav.documents'), href: '/documents' },
      { label: translate('documents.nav.recent') },
    ]}
  >
    {rows.length === 0 ? (
      <EmptyState
        title={translate('documents.recent.empty')}
        description={translate('documents.recent.emptyHint')}
      />
    ) : (
      <ul className="flex flex-col gap-2"> … unchanged … </ul>
    )}
  </WorkspacePage>
);
```

Both branches now share one heading. `WorkspacePage` already supplies the landmark, the `<h1>` and
the breadcrumb — the four existing translation keys are the same four.

## 5. Regression tests

**`features/documents/recent-empty-state.spec.tsx`** — new, 6 tests, jsdom.

Empty: exactly one `<h1>` whose text is the existing title; the breadcrumb's first crumb links to
`/documents`; both empty-state strings still render; no document link. Populated: the same single
heading and breadcrumb, and each row still links to its document with its number and folder — so the
tests also prove the populated state is unchanged.

They assert the **frame**, not the components that build it: a rewrite that keeps the heading and the
trail keeps them green.

**`test/e2e/recent-empty.e2e.spec.ts`** — new, 15 tests, against the real stack.

## 6. Test-proof

The old early return was restored and the suite re-run:

```
× keeps exactly one page heading
    → Unable to find an accessible element with the role "heading"
× keeps the breadcrumb back to the library
    → Unable to find an accessible element with the role "navigation" and name "Breadcrumb"
✓ still shows the empty state itself
✓ renders no document list when there is nothing to list
✓ … populated, unchanged … (2)
  Tests  2 failed | 4 passed
```

Restored: **6 passed**.

This is the discriminating shape. Exactly the two *frame* assertions failed; the empty-state
assertions kept passing, because the empty state was never the thing that was broken. A test that
had failed on all four would have been asserting the wrong thing.

One assertion was corrected during writing rather than after: `queryAllByRole('listitem')` counted
the **breadcrumb's** crumbs, so it would have demanded the frame be *absent*. It now counts document
links. The test was wrong; the product was not.

## 7. The real state, not an arranged one

The signer this suite creates has **opened nothing**. `RecentDocument` rows come from
`DocumentService.open()` recording a view — the path Phase 7.6D established — so a session that never
opens a document has a genuinely empty list. **Nothing was deleted, truncated, stubbed or inserted**
to produce the state; it is simply what a new account sees.

The suite asserts the precondition before anything else, so a future fixture that pre-populates
recents fails loudly rather than making the rest of the evidence meaningless.

## 8. Running-application evidence

```
[recent empty headings] ["Recently opened"]
```

### Responsive — six widths, one session

`scrollWidth <= clientWidth` **and** `h1Count === 1` asserted at 1440, 1280, 1024, 768, 640 and 390.
The heading is checked at every width because a frame that collapses on a phone is the same defect
arriving later.

`recent-empty-1280.png` **inspected**: breadcrumb `Documents › Recently opened`, the `<h1>`
*Recently opened* beneath it, and the empty state centred in the content column — the same rhythm as
the four reference screens.

### Dark — through the real toggle

`recent-empty-dark.png` **inspected**. Rail, top bar, breadcrumb, heading and both empty-state lines
all in the dark palette, nothing clipped. The suite also asserts `body` is painted
(`!== rgba(0, 0, 0, 0)`), because this screen is nearly all page and would show the Phase 7.8 canvas
defect more plainly than any other.

### Arabic / RTL — through the real `edms_locale` cookie

At 1280 and 390: `html[dir="rtl"]`, `html[lang="ar"]`, exactly one `<h1>`, no overflow, and no raw
`documents.*` key.

`recent-empty-ar-390.png` **inspected**: `الوثائق › فُتحت مؤخرًا` right-aligned with the separator
pointing the right way, `فُتحت مؤخرًا` as the heading, and `لم تُفتح أي وثيقة بعد` /
`ستظهر هنا الوثائق التي تفتحها، الأحدث أولًا` beneath. All four strings are existing reviewed
catalogue entries. **No Arabic was invented, added or changed, and none looked wrong** — so no
`ARABIC REVIEW REQUIRED` is raised.

### Live axe

```
[axe recent-empty] []
```

**0 critical, 0 serious**, `color-contrast` left on. No exception was added.

### Keyboard

The frame is *reachable*, not merely present: walking forward from the top of the document reaches
the skip link and then the breadcrumb's `Documents` link — matched by role, href and text — with a
visible ring at the stops. A separate test **clicks** that crumb and waits for `/documents`, so the
way back is proved to work rather than to exist.

## 9. Phase 8's own suite closes the finding

`consistency.e2e.spec.ts` recorded this screen in `RECORDED_FINDINGS.noPageHeading`. **The entry is
deleted, not crossed out**, so the assertion is unconditional again — and its companion test, which
asserts the recorded gaps are "still there and still only there", now asserts that no screen is
missing a heading. Re-measured through that suite:

```
[grammar recent] {"h1":"Recently opened","h1Count":1,
                  "pageFrame":{"paddingTop":"24px","maxWidth":"1280px"},…}
```

`24px / 1280px` is the reference frame exactly — the same numbers `/approvals` reports. The screen is
not merely fixed, it is measurably the same shape as the rest of the product.

## 10. Visual baselines

**None changed.** `RecentScreen` has no surface in `visual.spec.tsx`, so no baseline could move, and
none did: the suite reports the same 97 pass / 10 fail it has since Phase 7.1 — the ten known
Arabic-font surfaces. `PIXEL_TOLERANCE` untouched.

## 11. Gates

| Gate | Result |
| --- | --- |
| `pnpm format:check` | PASS |
| `pnpm lint` | PASS — 13/13, 0 errors |
| `pnpm typecheck` | PASS — 13/13 |
| `pnpm test` | PASS — web **176** (170 + the 6 new), API 649 + 1 skipped, worker 2, contracts 26 |
| `pnpm verify:styles` | PASS — 10/10 |
| `pnpm build` | PASS |
| **Recent-empty E2E** | **15/15** |
| Consistency E2E | **9/9** — with the recorded finding removed |
| Shell E2E | **8/8** — unchanged |
| `pnpm test:visual` | PASS — 97/10, the pre-existing Arabic-font surfaces |
| Integration | **NOT RUN** — no API, schema or package behaviour changed. The only files touched are one web screen and three test files |

## 12. Not verified

- **Populated Recent in this phase.** Its jsdom coverage is here and Phase 7.6D verified it in the
  running application; this phase did not re-drive it in a browser, and does not claim to.
- **Widths other than 1280 and 390 visually.** The other four are asserted numerically
  (`scrollWidth`, heading count) but were not looked at, which is what the brief asked for.
- **axe in dark or Arabic on this screen.** Run in light at 1280 only.

## 13. Contradictions with earlier phases

**None.** Phase 8's finding was correct as measured, its root cause was correct as stated, and the
fix is the one it recommended. The only correction made here is to a **test assertion of my own**
(§6), not to a product conclusion.
