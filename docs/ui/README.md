# UI

Documents about the web client specifically — how it is verified, and what it is verified against.
Architecture lives in [`../architecture/`](../architecture/README.md); phase evidence lives in
[`../reports/`](../reports/).

| Document | Purpose |
| --- | --- |
| [Phase 5.2 — Accessibility, UI Quality & Design System Completion](./phase-5.2-accessibility-report.md) | The phase that replaced this product's static accessibility claims with automated verification, and the three defects that only running the UI could find: a dashboard link at 3.70:1 against the 4.5 AA requires, a platform `Badge` at 4.31:1 that this product may not fix and does not work around, and a collapsed navigation rail that rendered blank rows because `SidebarNav` shows only the icon and the product passed none. Also the two harness mistakes worth keeping — a `matchMedia` stub that answered `false` to everything and so tested the *mobile* shell, and axe shipping `duplicate-id` switched off since 4.10, which the brief requires on. Scores, the ten deliverables, and eleven roadmap items |

## How the UI is checked

Four gates, each answering something the others cannot:

| Gate | Question |
| --- | --- |
| `pnpm test` (jsdom) | Is the rendered markup labelled, landmarked and operable by keyboard? |
| `pnpm test:visual` (Chromium) | Does it meet contrast, and does it still look the same? |
| `pnpm verify:styles` | Did the design system's own classes reach the stylesheet at all? |
| `pnpm build` | Does it compile and route? |

The third exists because a stylesheet that is silently 64% too small is not a type error, a lint
error, a test failure or a build failure — see
[Phase 19](../reports/phase-19-shared-platform-compliance.md).
