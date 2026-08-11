# Phase 7.9 — Platform Visual Foundations

## 1. Status

**COMPLETE.**

Three objectives, three different answers, and the most valuable of them is a **retraction**.

1. **SidebarNav contrast** — there is no gap. Phase 7.8's 3.57:1 was a colour transition measured
   mid-flight. Settled, the rail is **6.89:1 in dark** and **4.97:1 in light**. The tolerance Phase
   7.8 created has been removed and the assertion tightened to AA in both themes.
2. **Account identity** — fixed properly. The name was in the domain the whole time; `/auth/me`
   simply never returned it. The chip now reads a person's name and address in the running product.
3. **Opacity** — inventoried and classified in full; **one** change made, and it is not an opacity
   change at all but the raw Tailwind palette colours the audit turned up beside it.

No new colour, font, radius, shadow, spacing token or visual primitive was introduced. The four
reference screens were not redesigned and not one visual baseline moved.

## 2. What changed

| File | Change |
| --- | --- |
| `apps/api/.../auth.controller.ts` | `/auth/me` returns `displayName` and `email` |
| `apps/web/src/app/(workspace)/layout.tsx` | the chip is given the person, then the address |
| `apps/web/src/features/revisions/revision-panel.tsx` | `bg-red-500/10` → `bg-destructive/10`, `bg-green-500/10` → `bg-success/10` |
| `apps/api/.../auth-me.spec.ts` | **new** — 4 tests |
| `apps/web/src/test/no-raw-colours.spec.ts` | **new** — 3 tests, the standing guard |
| `apps/web/src/test/e2e/shell.e2e.spec.ts` | corrected rail measurement; the chip asserts a person |

## 3. RETRACTED — the SidebarNav contrast gap does not exist

### Re-measured, as the brief requires, before changing anything

| | current item | resting items |
| --- | --- | --- |
| **light** | 4.79:1 | **4.97:1** |
| **dark** | **6.37:1** | **6.89:1** |

Both are AA. Both match `themes/docs/palette.css` to the digit: `#667085` on `#ffffff` is 4.97, and
`#98a2b3` on `#101828` is 6.89 — computed from the palette independently and equal to what Chromium
reports.

### How the wrong number was produced, and how it was caught

Phase 7.8 measured **3.57:1**. That number is real; it is just not a contrast ratio of anything the
product renders at rest. `SidebarNav` puts `transition-colors` on every item, and Phase 7.8 measured
immediately after clicking the theme control. `getComputedStyle().color` returns the *interpolated*
value while a transition runs, so the reading was the light colour part-way to the dark one.

The diagnostics that settled it, all from one run in the running application:

```
color      rgb(102, 112, 133)   ← #667085, the LIGHT muted foreground
token      #98a2b3              ← the element's own --muted-foreground, correctly DARK
probe      rgb(152, 162, 179)   ← a fresh <span class="text-muted-foreground"> in the SAME parent
```

A freshly-created element carrying only the utility resolved the dark token correctly, while the
transitioning anchor beside it still reported the light one. That is not a token gap; it is a
stopwatch problem. `#667085` on `#101828` is exactly 3.57 — the number Phase 7.8 recorded, arrived
at from the light colour on the dark surface, which is a pairing that exists for about 150ms.

Three source facts were checked along the way and all were sound: `base.css` maps the tokens with
**`@theme inline`**, so `text-muted-foreground` compiles to `color: var(--muted-foreground)` and
tracks `.dark`; the built stylesheet contains exactly one `:root` and one `.dark` declaration of the
token; and no rule anywhere sets the light value literally.

### What changed as a result

- The rail test now settles colours before measuring — two samples that agree, not a fixed sleep,
  because a sleep is a guess about a duration the platform is free to change.
- It asserts **≥ 4.5:1 in both themes**. Phase 7.8's "do not get worse than 3.57" floor is gone.
- **`text-muted-foreground` was removed from the axe tolerance list.** A tolerance for a defect that
  does not exist is worse than no tolerance, because it silently excuses every future regression
  that happens to use the same class. One entry remains — the `Badge` palette issue recorded since
  Phase 5.2 — and everything else fails the build.
- `docs/reports/phase-7.8-…md` §4 is struck through in place with the correction and a pointer here.
  The reasoning is kept rather than deleted: a retracted finding is more useful with its argument
  visible.

**Ownership:** none. Nothing in `@munaxa/theme`, `@munaxa/ui` or `SidebarNav` needs to change, and
the earlier "≈2.78:1" from before Phase 7.8 was never reproducible either.

**A note on method.** Both wrong numbers came from measuring a running application at the wrong
instant — Phase 7.8's rail during a transition, and its first `RATE_LIMITED` reading during a
throttle. Measurement beats source-reading, but only when what is measured has settled.

## 4. FIXED — the account chip shows a person

### Traced through the domain, not guessed

```
prisma/schema.prisma   model User { email  displayName  … }        ← since Phase 1
UserDirectory          contactFor(userId) → { userId, email, displayName }
auth.controller.ts     @Get('me') → { userId, tenantId, roles, permissions }   ← the gap
```

The information was never missing from the domain. `UserDirectory` — the existing and only way out
of the Identity module (`02-backend-architecture.md` §3) — already returned exactly the two fields
needed. **No new port, no new query, no schema change.**

### The change

`/auth/me` now returns `displayName` and `email`, and `(workspace)/layout.tsx` passes the name to
the chip and the address beneath it. `me.displayName ?? me.userId` keeps the identifier as the
fallback: a token need not stand for a person, and an API-key caller has a tenant and permissions
and nobody behind it. **Nothing is derived from the UUID.**

### Running-app evidence

```
before  [account chip] "0\n01a51843-66c0-421f-8aba-2e586490285f\ncfa0bddf-…"
after   [account chip] "A\nAda Lovelace\nsigner@e2e.test"
```

The avatar initial is now the first letter of a name rather than of a UUID.

### The mistake this caught, kept because it is instructive

The first version compiled, passed lint, typecheck and every unit test — and changed nothing on
screen. `requireTransaction()` throws when no unit of work is open, the API does not wrap requests in
a transaction globally, and the route's own `catch` turned that into a silent `null`. Only the E2E
saw it. The read now opens a unit of work of its own, and the `catch` is for a database that is
unreachable rather than for a mistake in wiring.

### Test-proof

- `auth-me.spec.ts` (4 tests): the name and address are returned; the directory is asked for the
  caller and nobody else; a context with no user yields nulls **and does not query**; a failing
  directory read degrades to "no name" rather than to "signed out" — which matters, because
  `(workspace)/layout.tsx` redirects to `/login` when `/auth/me` throws.
- The E2E asserts the signer's real name and email **and** that neither the user id nor the tenant id
  appears in the chip. It fails if the API stops carrying the fields, if the layout stops passing
  them, or if anybody reintroduces a name derived from the UUID — which is how the wiring mistake
  above was caught in the first place.

## 5. Opacity — the full inventory, and the one change the evidence supported

**67 usages across 19 files**, every one classified:

| Pattern | Count | Class | Verdict |
| --- | --- | --- | --- |
| `size-4 opacity-70` on an icon | 20 | **A — semantic** | A decorative glyph receding is what opacity is for, and the platform has no "muted icon" token. Left alone. |
| `text-sm / text-xs opacity-70` on text | ~30 | **C — should use a token** | `text-muted-foreground` is the product's own. Deferred; see below. |
| bare `opacity-70` on containers/controls | 11 | **D — insufficient evidence** | Each needs its own render to tell a disabled state from a muted one. |
| `opacity-50` inside `SidebarNav`'s disabled item | — | **A** | Platform-owned, and the conventional disabled treatment. |
| `opacity-80` on `<del>` in the revision diff | 1 | **A** | The fade *is* the "removed" signal, beside `<del>`'s semantics. Kept. |

**Not one of the ~30 C-class sites was changed, deliberately.** They are a consistency deviation, not
an accessibility defect: `--foreground` at 70% measures ≈5.6:1 on the light canvas and ≈9:1 on the
dark one, both above AA. Part 3 sets the bar at *"inspect the actual rendered screen"* for every
candidate; thirty sites across fifteen screens — one of them a reference screen — cannot be
inspected honestly in one phase, and a blind sweep is what the brief forbids. The inventory is here
so the next phase starts with a list rather than a grep.

### What the audit did turn up, and it is a real defect

```
revision-panel.tsx  <del className="rounded bg-red-500/10 …">
                    <ins className="rounded bg-green-500/10 …">
```

**Tailwind's own palette scales, in product code.** They are theme-blind: the same colour in light
and dark, unmoved when the Docs palette is retuned upstream, and a direct breach of
`ARCHITECTURE.md`'s "nothing in this repository may hardcode a colour". `--destructive` and
`--success` are the platform's existing semantic tokens for exactly "this was taken away" and "this
was added", and both carry dark values. Now `bg-destructive/10` and `bg-success/10`.

The meaning does not rest on the colour either way — `<del>` and `<ins>` are what tell a screen
reader which is which, and they are unchanged.

**Test-proof.** `no-raw-colours.spec.ts` scans every non-test `.ts`/`.tsx` (comments stripped, since
the code comment quotes the classes it replaced) for any of Tailwind's 22 palette scales and for
literal `#rgb`/`rgb()`/`hsl()`. Reverting one class fails it with the file and the class named:

```
+   "features/revisions/revision-panel.tsx: bg-red-500"
```

It also asserts it scanned more than 50 files, so a regex that silently stops matching cannot pass
forever.

**Not verified in a browser.** The revision comparison needs two revisions of one document, which the
E2E fixture does not create. The change is a token substitution that can only improve dark — the
value it replaces has no dark variant at all — but it has no running-app screenshot behind it and is
not claimed to.

## 6. Reference-screen regression

Every reference screen re-run in the running application after both changes:

| | Dashboard | Library | Search | Record |
| --- | --- | --- | --- | --- |
| canvas painted, light + dark | ✓ | ✓ | ✓ | ✓ |
| six widths, `scrollWidth <= clientWidth` | ✓ | ✓ | ✓ | ✓ |
| navigation reachable at every width | ✓ | ✓ | ✓ | ✓ |
| Arabic 1280 + 390, `dir=rtl` `lang=ar`, no overflow | ✓ | ✓ | ✓ | ✓ |
| live axe, both themes, 0 unrecorded | ✓ | ✓ | ✓ | ✓ |

```
[axe light library] {"unrecorded":[],"tolerated":1,"contrastNeedsReview":4}
[axe dark  library] {"unrecorded":[],"tolerated":0,"contrastNeedsReview":3}
[axe *     others]  {"unrecorded":[],"tolerated":0,…}
```

The single tolerated node is the `Badge` palette issue named since Phase 5.2. `contrastNeedsReview`
is axe's `incomplete` count — "cannot resolve the effective background", which this theme's
`color-mix` surfaces produce — logged rather than counted as a pass.

**Search 23/23 and Dashboard 19/19 still pass unchanged.** Keyboard traversal (skip link → rail →
theme → account) still passes. **Zero visual baselines moved**; the visual suite's ten failures are
the same ten Arabic-font surfaces it has reported since Phase 7.1.

## 7. Gates

| Gate | Result | Notes |
| --- | --- | --- |
| `pnpm format:check` | PASS | |
| `pnpm lint` | PASS | 13/13, 0 errors |
| `pnpm typecheck` | PASS | 13/13 |
| `pnpm test` | PASS | web 170, API 649+1 skipped, contracts 26 |
| `pnpm verify:styles` | PASS | 10/10 |
| `pnpm build` | PASS | API and web |
| **API integration** | **656/659** | the 3 failures are the MinIO presigned-upload tests — `TypeError: fetch failed`, no object store. This container has a `docker` client but **no daemon**, so MinIO cannot be started; CI starts it. Every identity/auth integration test passes, and the failures are in a module this phase did not touch |
| **Shell E2E** | **PASS** | 8/8 |
| Search E2E | PASS | 23/23 |
| Dashboard E2E | PASS | 19/19 |
| `pnpm test:visual` | PASS | 97 pass / 10 fail — the pre-existing Arabic-font surfaces |

## 8. Classification

| Verdict | Item |
| --- | --- |
| **FIXED** | `/auth/me` carries `displayName` and `email`; the account chip shows a person; `bg-red-500/10` and `bg-green-500/10` replaced with semantic tokens |
| **RETRACTED** | the `SidebarNav` dark-contrast gap — a transition measured mid-flight; the rail is 6.89:1 dark and 4.97:1 light. Phase 7.8 §4 corrected in place, the tolerance removed, the assertion tightened to AA |
| **VERIFIED** | rail contrast both themes; account chip in the running product; four reference screens at six widths, both themes, Arabic 1280/390, live axe both themes, keyboard; zero baselines moved |
| **DEFERRED** | ~30 `text-* opacity-70` sites — C-class consistency, inventoried, not swept, and not an accessibility defect |
| **NOT VERIFIED** | the revision-comparison colours in a browser (the fixture creates no second revision); 3 MinIO integration tests (no Docker daemon here) |
| **PLATFORM DECISION REQUIRED** | **none.** Both candidates Phase 7.8 raised resolved inside this repository — one because the finding was wrong, one because the domain already had the answer |

## 9. Scope kept

No reference screen was redesigned. No colour was added locally — one was *removed*. No arbitrary
CSS, no second theme system, no invented account name, no mass opacity replacement, no unrelated
business logic. `PIXEL_TOLERANCE` unchanged.
