# Phase 7.8 — Global Visual Consistency & Application Shell Modernization

## 1. Status

**COMPLETE.**

The shell was audited in the running application across Dashboard, Library, Search and Document
Record, in both themes, at six widths and in Arabic. **One product defect was found and fixed** —
the page canvas was never painted, so a dark shell sat on a white document. Two findings were
traced to shared packages and are written up as enhancements rather than patched locally, which is
what the phase principle requires. Nothing else met the bar for a change.

One product code line changed. That is the honest size of what the evidence supported.

## 2. What changed

| File | Change |
| --- | --- |
| `apps/web/src/app/layout.tsx` | `<body className="bg-background text-foreground">` |
| `apps/web/src/test/e2e/shell.e2e.spec.ts` | **new** — 8 cross-screen shell tests against the real stack |

No component was redesigned. No colour, font, radius, shadow, spacing token or visual primitive was
introduced. The four reference screens are byte-identical apart from the canvas they now sit on.

## 3. FIXED — the page canvas

### Measured, before

```
[canvas light dashboard] {"html":"rgba(0, 0, 0, 0)","body":"rgba(0, 0, 0, 0)","bodyColor":"rgb(0, 0, 0)"}
[canvas dark  dashboard] {"html":"rgba(0, 0, 0, 0)","body":"rgba(0, 0, 0, 0)","bodyColor":"rgb(0, 0, 0)","dark":true}
```

Identical on all four routes, in **both** themes. Nothing painted the document, so the browser's own
canvas showed through and the document's text colour was the browser default black rather than the
theme's foreground. In light that is invisible — the default happens to be white. In dark it left a
white page behind a dark shell, which is what Phase 7.7B saw on Search and deferred as product-wide.

### Whose it is — traced through the token architecture

1. **`AppShell` deliberately paints nothing.** It renders `<div class="flex min-h-screen">`, and its
   own docstring says why: *"The shell owns **structure** and nothing else."*
2. **No theme stylesheet carries a `body` rule.** `themes/base/base.css`, `themes/docs/index.css`
   and `themes/docs/palette.css` define tokens and nothing else — `grep` for a `body` selector
   across `@munaxa/platform/themes` and `tokens` returns nothing.
3. **The correct semantic token already exists**: `--background` (`#ffffff` light, `#0a0f1a` dark)
   and `--foreground`, exposed to Tailwind as `bg-background` / `text-foreground`.

So this is not a platform defect being patched locally. A shared package that painted every host
application's `<body>` would be deciding something the host may not want, and `<body>` is a file
this repository owns. The brief's own rule applies directly: *"If the platform already provides the
correct semantic background token, use it."*

**No colour is named in the fix.** Retuning the Docs palette upstream still reaches this product
with no change here, which is the property `globals.css` exists to protect.

### Measured, after

```
[canvas light  *] {"body":"rgb(255, 255, 255)","bodyColor":"rgb(16, 24, 40)","dark":false}
[canvas dark   *] {"body":"rgb(10, 15, 26)",  "bodyColor":"rgb(250, 251, 252)","dark":true}
```

`rgb(10, 15, 26)` is `#0a0f1a` — the theme's own dark background, arrived at through the token.
Verified on all four routes. `shell-dark-dashboard.png` was opened and inspected: the page is dark
edge to edge, the headings are light, and the white gutters visible in Phase 7.6E's
`recent-populated-dark.png` are gone.

### Test-proof

The class was removed, the app rebuilt, and the suite re-run:

```
[canvas light dashboard] {"body":"rgba(0, 0, 0, 0)", …}
× paints the canvas and passes axe in light
× paints the canvas and passes axe in dark
```

Restored, rebuilt, re-run: **8/8**.

The assertion is that the canvas is **painted**, not that it is any particular colour — a test
naming `#0a0f1a` would be this repository restating a platform token.

## 4. PLATFORM ENHANCEMENT — `SidebarNav` resting-item contrast

**Component:** `@munaxa/platform` → `ui/shell/navigation.js` → `SidebarNav`.

**Current behaviour.** A resting item is rendered with the component's own classes:

```
item.active ? 'bg-primary font-medium text-primary-foreground'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground'
```

**Measured** in the running application, computed against each link's *effective* background
(walking up past transparent ancestors):

| | current item | resting items |
| --- | --- | --- |
| light | 4.79:1 | **4.97:1** |
| dark | 4.79:1 | **3.57 – 3.67:1** |

**Expected:** ≥ 4.5:1, WCAG 2.1 AA for text below 18.66px. The dark figure moves slightly between
runs because which link is "worst" depends on which route rendered a breadcrumb.

**Affected:** every screen in this product, and every AXA product using the shell.

**Why a local workaround was rejected.** `SidebarNav` exposes `groups`, `label`, `renderLink`,
`collapsed` and `className` — `className` lands on the `<nav>`, not on the items, and the item
classes are computed inside the component. The only product-side remedies are overriding a shared
component's styling or hardcoding a colour, and `ARCHITECTURE.md` forbids the second outright while
the phase principle forbids the first. The fix belongs in the token pair — a `--sidebar-foreground`,
or a resting item on `text-foreground/80` rather than the muted token.

**Guarded meanwhile.** The suite asserts AA in light and, in dark, asserts the measured gap does not
get **worse**. When the platform raises the token the dark branch starts failing and gets deleted —
the same mechanism `visual.spec.tsx` has used for the `Badge` palette issue since Phase 5.2.

The earlier audit's "≈2.78:1" is **not** carried forward. A first run did produce 2.87 in light, but
it ran against the unpainted canvas with earlier tests aborted mid-way; the numbers above are from
clean runs and supersede it.

## 5. API ENHANCEMENT REQUIRED — no display name for the account chip

Traced end to end rather than judged from the picture:

```
auth.controller.ts  @Get('me') → { userId, tenantId, roles, permissions }
lib/session.ts      Session    → { accessToken, locale }
(workspace)/layout  displayName={me.userId ?? ''}  description={me.tenantId}
```

Rendered:

```
[account chip] "0\n01a51843-66c0-421f-8aba-2e586490285f\ncfa0bddf-aa52-4464-93a2-8500006e1ab8"
```

The leading character is `UserMenu`'s avatar initial, taken from the first character of the UUID.

**There is no display name anywhere in this application to render.** `/auth/me` returns identifiers
only, and the session cookie carries an access token and a locale. **Missing field:** a human name
on the `/auth/me` response — `displayName` (and ideally `email`), sourced from the user record the
API already holds.

Nothing was invented. The UUID was not parsed, no name was derived, authentication was not touched.
The suite pins the honest half: the control is reachable, has an accessible name, and is not empty.

## 6. Shell audit — what was inspected and what was left alone

Inspected in the running application on all four reference screens, both themes, six widths and
Arabic at 1280/390: top bar, sidebar, content frame, breadcrumbs, page header, navigation groups,
account area, theme control and mobile drawer.

**Left alone, deliberately** — each is a *valid existing composition*, not a defect:

- **Top-bar height and rhythm** are `TopBar`'s; the three actions (`NotificationBell`,
  `ThemeToggle`, `UserMenu`) already share one `gap-1` cluster and one `ghost`/`icon` sizing.
- **Rail grouping and icons** were settled in Phase 7 and read correctly at every width.
- **The active state** is `bg-primary` + `font-medium` + `aria-current="page"` — visually and
  semantically strong; measured at 4.79:1 in both themes.
- **Mobile**: at 390 the drawer trigger, bell, theme and avatar all fit one row with no collision,
  the page title and content padding are unchanged, and `scrollWidth <= clientWidth` holds.
- **RTL**: `shell-ar-1280.png` inspected — rail on the right, brand and headings mirrored, the
  collapse chevron reversed, account chip on the left, and `Batch release procedure`,
  `SOP-E2E-0001`, `2026/8/11` and `DOCUMENT_VIEWED` intact as LTR runs inside RTL lines.

Nothing here was changed because a reference image looked different, which is what §5 of the brief
asks.

## 7. Shared component audit (Part 8), classified

| Finding | Class | Verdict |
| --- | --- | --- |
| `Page`/`PageHeader` bypassed by a hand-written `<h1>` | **B** | Only in `(auth)` — login and MFA are outside the workspace shell and have no `WorkspacePage`. Valid. |
| Hand-rolled section headings (`<h2 className="text-…">`) | **B** | **4 remain**, all in dialogs or fieldsets (`signing-ceremony`, `form-section`, `document-screen`'s uppercase group label). Phases 7.2, 7.3 and 7.7B converted the screen-level ones. |
| Raw hex / `rgb()` in `.tsx` | — | **1**, and it is inside a comment. No colour is hardcoded anywhere in the product. |
| `opacity-[0-9]` as a stand-in for muted text | **A** | **67 sites across 19 files.** Deferred — see below. |
| Custom badges / status indicators | **B** | `DocumentStatusBadge` and `FormatBadge` are the single sources; no screen rolls its own. |
| Repeated card shells | **B** | `Card`/`Panel`/`Surface` throughout. |

### The one A-class finding, and why it is deferred rather than swept

`opacity-70` fades the *rendered pixel*, so the result depends on what is behind it and drifts
between themes; `text-muted-foreground` is the token the product uses for the same intent. Phase
7.7B replaced nine such sites on Search for exactly this reason.

It is **not** an accessibility defect — `--foreground` at 70% measures ≈5.6:1 on the light canvas
and ≈9:1 on the dark one, both above AA. It is a consistency defect.

Sweeping it would touch 19 files including `document-screen.tsx`, which is one of the four screens
this phase is told not to rebuild, and would require re-running four screens' worth of visual, RTL,
dark and axe verification to stay honest. That is a phase, not a footnote. The inventory is recorded
here so the next one starts with a list rather than a grep. **Not fixed; not claimed as fixed.**

## 8. Evidence

### Responsive — one session, six widths, four screens

`shell-{1440,1280,1024,768,640,390}.png`. At every width on every screen:
`scrollWidth <= clientWidth`, and at least one visible way into the navigation (the rail above `md`,
the drawer trigger below it). Inspected at 390: hamburger, bell, theme and avatar on one row, no
collision, content readable.

### Dark

Through the top bar's own control on every route — never by setting `.dark`, never by injecting CSS.
Four screenshots captured and inspected. Canvas, shell, sidebar, top bar, panels, borders and muted
text all in one palette; no clipping.

### Arabic / RTL

Through the real `edms_locale` cookie. `html[dir="rtl"]`, `html[lang="ar"]` asserted on all four
routes at 1280 and 390, with no horizontal overflow at either width. **No Arabic string was
invented, added or changed.**

### Live axe — both themes, four screens

```
[axe light dashboard] {"unrecorded":[],"tolerated":0,"contrastNeedsReview":1}
[axe light library]   {"unrecorded":[],"tolerated":1,"contrastNeedsReview":4}
[axe light search]    {"unrecorded":[],"tolerated":0,"contrastNeedsReview":1}
[axe light record]    {"unrecorded":[],"tolerated":0,"contrastNeedsReview":1}
[axe dark  library]   {"unrecorded":[],"tolerated":0,"contrastNeedsReview":3}
[axe dark  *]         {"unrecorded":[],"tolerated":0,"contrastNeedsReview":0}
```

**Zero unrecorded critical or serious violations, in both themes, with `color-contrast` left on.**
The one tolerated node is the `Badge` palette issue recorded since Phase 5.2.

`contrastNeedsReview` is axe's `incomplete` count for `color-contrast`, logged deliberately. axe
returns "needs review" rather than a violation when it cannot resolve an element's effective
background — a `color-mix` or a semi-transparent surface, both of which this theme uses. That is why
axe can be silent about the rail while this suite's own computation reports 3.57:1 in dark: the two
are answering different questions, and saying so is more useful than picking whichever result reads
better.

### Keyboard

The shell was operated, not asserted about. Walking forward from the document reaches the skip link
first, then the rail, the theme control and the account control, with a visible ring at the stops.
No number of Tab presses is asserted — that would test DOM order rather than whether a person can
work.

## 9. Regression tests

`apps/web/src/test/e2e/shell.e2e.spec.ts` — new, **8 tests**, all against the real stack.

| Test | Guards |
| --- | --- |
| canvas + axe, light | the canvas is painted; no unrecorded serious violation |
| canvas + axe, dark | the same, in dark, through the real control |
| rail readable, light | AA on the current item and the resting items |
| rail readable, dark | the recorded platform gap does not worsen |
| account control | reachable, named, non-empty |
| six widths × four screens | no overflow; navigation always reachable |
| Arabic at 1280 and 390 | `dir`/`lang` from the real cookie; no overflow |
| keyboard | skip link → rail → theme → account, focus visible |

**Test-proof:** removing `bg-background text-foreground` from `<body>`, rebuilding and re-running
failed both canvas tests with the measured `rgba(0, 0, 0, 0)` in the output; restoring gave 8/8. No
assertion was weakened.

## 10. A finding about the suite, recorded because it was mistaken for a product defect

The first version of this suite re-navigated for every width and every theme — 50-odd page loads.
The API's rate limit is 300 requests per 60 seconds by default and a dashboard render costs about a
dozen, so the product returned `RATE_LIMITED` and the route error boundary rendered:

```
[nav-failure 390 dashboard] {"url":"…/","text":"Something went wrong … 2751726509"}
```

Read naively that is "no navigation at 390px". It was the product being correct and the suite being
wrong. Each test now loads a route once and resizes or re-themes the page it already has — the
pattern Phase 7.1C established. Worth recording because the first reading was a plausible bug report
about the mobile shell that would have been entirely fictional.

Related and genuine, though not a defect worth a change: **below `md` the only way into the
navigation is client-rendered** (`SidebarTrigger` returns `null` until `useAppShell`'s `isMobile`
resolves), so a phone has no navigation at all until JavaScript runs. It resolves within a frame.

## 11. Gates

| Gate | Result | Notes |
| --- | --- | --- |
| `pnpm format:check` | PASS | |
| `pnpm lint` | PASS | 13/13 |
| `pnpm typecheck` | PASS | 13/13 |
| `pnpm test` | PASS | 13/13 |
| `pnpm verify:styles` | PASS | 10/10 |
| `pnpm --filter @edms/web build` | PASS | rebuilt three times (fix, proof, restore) |
| **Shell E2E** | **PASS** | **8/8** against the real stack |
| Search E2E | PASS | 23/23 — unchanged by this phase |
| Dashboard E2E | PASS | 19/19 — unchanged by this phase |
| `pnpm test:visual` | PASS | 97 pass / 10 fail — all ten the **pre-existing** Arabic-font surfaces |
| Integration | **NOT RUN** | no API, schema or package behaviour changed |

## 12. Baselines

**None changed.** The visual suite renders screens without the application's `<body>`, so the canvas
fix does not move a single baseline — which is the right outcome for a phase whose goal is
consistency rather than churn. The suite's ten failures are the same ten Arabic-font surfaces it has
reported since Phase 7.1.

New running-application screenshots (not baselines, not pixel-compared): `shell-{width}.png`,
`shell-dark-{screen}.png`, `shell-ar-{1280,390}.png`. Every one was opened and looked at.

## 13. Classification

| Verdict | Item |
| --- | --- |
| **FIXED** | the page canvas — `<body>` now carries the platform's `bg-background text-foreground` |
| **VERIFIED** | shell audited in the running app on 4 screens; canvas in both themes on all 4; six widths; dark through the real control; Arabic 1280/390; live axe 0 unrecorded in both themes; keyboard traversal; the four reference screens unchanged (Search 23/23, Dashboard 19/19, zero baselines moved) |
| **PLATFORM ENHANCEMENT** | `SidebarNav` resting item — 3.57–3.67:1 in dark against 4.5:1 AA, component-owned classes, no host-side prop |
| **API ENHANCEMENT** | `/auth/me` carries no display name; the account chip can only show identifiers |
| **DEFERRED** | 67 `opacity-[0-9]` sites across 19 files — an A-class consistency defect, scoped and inventoried, not swept |
| **NOT VERIFIED** | screens outside the four references (Approvals, Audit, Reports, Notifications, Administration) were not driven in the browser this phase; the shell tests cover the frame they share, not their contents |
| **REJECTED** | any change to the four reference screens' internal composition; any local override of `SidebarNav`'s styling; any derived display name |

## 14. Does the shell make these screens feel like one product?

Asked of the finished application, against the screenshots rather than the source.

Yes, and the canvas is why the answer changed. In dark the product previously read as a dark chrome
pasted onto a white page — the one flaw that made every screen look unfinished at once, regardless
of how carefully each had been composed. It now reads as one surface: rail, top bar, canvas, panels
and cards in a single palette, on all four screens, at every width, in both writing directions.

What remains between the product and "coherent" is two shared-package changes, not product work:
a rail that meets AA in dark, and a name to put in the account chip.
