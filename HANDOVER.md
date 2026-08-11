# Handover — Phase 8.2, blocked on platform repository access

**Written at commit `4e4d842`, branch `claude/enterprise-feature-audit-y30g5o`. Tree clean.**

Read this first, then `docs/reports/phase-8.2-sidebar-nav-group-title-contrast.md`. Everything below
is a pointer into work that is already done — **do not redo the investigation.**

---

## 1. Where things stand

Phases 7.5 through 8.1 are complete and pushed. **Phase 8.2 is the only open item**, and it is
blocked on one thing: this session cannot reach `munaxa/munaxa-platform`.

| Phase | Status |
| --- | --- |
| 7.5 – 7.7B | COMPLETE — visual modernization of Dashboard, Library, Search, Document Record |
| 7.8 | COMPLETE — page canvas painted from the platform token |
| 7.9 | COMPLETE — `/auth/me` returns the caller's name; the 7.8 rail-contrast finding retracted |
| 8 | COMPLETE — cross-screen audit, 5 findings, roadmap |
| 8.1 | COMPLETE — `/documents/recent` keeps its page frame when empty |
| **8.2** | **BLOCKED** — needs a change in `@munaxa/platform` |

## 2. The one open task, in full

**Defect.** `SidebarNav` renders its navigation group title as:

```jsx
<p className="px-3 pb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
```

`text-muted-foreground/70` is a *fade of* the muted token. Measured in the running application on
`/admin/users`, with theme transitions settled, composited through a canvas:

| | measured | AA needs (10px text) |
| --- | --- | --- |
| light | **2.79:1** | 4.5:1 |
| dark | **4.19:1** | 4.5:1 |

Both fail.

**The fix — one class, no new token:**

```diff
- text-muted-foreground/70
+ text-muted-foreground
```

**Expected after: 4.97:1 light, 6.89:1 dark.** Those are not projections — that exact class on those
exact surfaces is already measured in this product, because it is what `SidebarNav`'s *resting
items* use.

Do **not** change: resting items, active items, font, size, tracking, uppercase, padding,
background, collapsed rail, mobile drawer, RTL, or navigation semantics.

## 3. What is blocking it, and how to tell it is unblocked

The component lives in `@munaxa/platform` — a **published dependency**, not a workspace package
(`.npmrc`: `@munaxa:registry=https://npm.pkg.github.com`; lockfile pins `1.0.0`).

Every route was tried, three separate times across two sessions:

```
git clone / ls-remote  …/munaxa-platform  → fatal: could not read Username
  …the same command against …/munaxa-docs → returns refs   ← the control
mcp__github__list_branches                → Access denied: repository not configured
                                             for this session. Allowed: munaxa/munaxa-docs
add_repo(read) and add_repo(push)         → MCP tool call requires approval
pnpm view @munaxa/platform versions       → ["1.0.0"]      ← nothing newer to consume
```

The control matters: the same token and transport work for `munaxa-docs`, so this is scope, not
tooling. A credential prompt is what GitHub returns when a token cannot see a repository at all.

**Before doing anything else, run these two checks:**

```bash
git ls-remote https://github.com/munaxa/munaxa-platform     # must return refs
pnpm view @munaxa/platform versions --json                  # is there a >1.0.0?
```

If the first still fails, **stop and report BLOCKED.** Do not build a Docs-side workaround — three
were considered and each is forbidden by the architecture or the brief (overriding the class through
`renderLink`, setting `--muted-foreground` locally, or suppressing the admin group titles).

The scope list appears to be fixed when the session's token is minted, so a grant made mid-session
may only take effect in a **fresh session**.

## 4. The sequence once access exists

1. Clone `munaxa/munaxa-platform`. Inspect it before editing — do not assume it is clean; if there
   are unrelated changes, leave them and report them.
2. Make the one-class change in `SidebarNav`'s group title.
3. Add the smallest platform-level test for it, reusing that repo's existing test infrastructure.
   Do not build a parallel one.
4. Run that repo's own gates (format, lint, typecheck, tests, build).
5. Patch release (`1.0.1` unless its conventions say otherwise) and publish.
6. In `munaxa-docs`: bump the dependency, install, and **verify the installed artefact** —
   `grep 'text-muted-foreground/70' node_modules/.../dist/ui/shell/navigation.js` must find nothing.
7. `apps/web/src/test/e2e/consistency.e2e.spec.ts`:
   - replace the temporary floors (`2.75` light, `4.15` dark) with **`>= 4.5` for both**;
   - **delete** the `RECORDED_AXE['/admin/users']` entry — all six violations should be gone.
8. Verify in the running application (§5), then update
   `docs/reports/phase-8.2-sidebar-nav-group-title-contrast.md` with a completion section. **Leave
   the existing BLOCKED narrative intact** — it is historically accurate and the history is the
   point.

## 5. How to run the real stack

Everything below is established and works; `/tmp/…/scratchpad/stack.sh` may be gone in a new
container, so here it is.

PostgreSQL 16 and Redis are installed as binaries (no Docker daemon in this container):

```bash
export PGBIN=/usr/lib/postgresql/16/bin
export NODE_ENV=test LOG_LEVEL=fatal
export REDIS_URL=redis://127.0.0.1:6379
export JWT_ACCESS_SECRET=ci-only-secret-at-least-thirty-two-characters
export CORS_ORIGINS=http://localhost:3000
export STORAGE_DRIVER=NONE SEARCH_DRIVER=POSTGRES OCR_DRIVER=NONE MAIL_DRIVER=NONE AV_DRIVER=NONE
export DATABASE_URL=postgresql://edms_app@127.0.0.1:5432/ci_edms_acme
export DATABASE_MIGRATION_URL=postgresql://edms_owner@127.0.0.1:5432/ci_edms_acme
export SECOND_DATABASE_URL=postgresql://edms_app@127.0.0.1:5432/ci_edms_rival
export SECOND_DATABASE_MIGRATION_URL=postgresql://edms_owner@127.0.0.1:5432/ci_edms_rival
export CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome

chown -R postgres /tmp/edms-pg
su postgres -c "$PGBIN/pg_ctl -D /tmp/edms-pg -l /tmp/edms-pg.log \
  -o '-c listen_addresses=127.0.0.1' start"
redis-server --daemonize yes --save ''
```

If `/tmp/edms-pg` does not exist, `initdb` as user `postgres` (never as root), create roles
`edms_owner` and `edms_app`, create `ci_edms_acme` and `ci_edms_rival`, then run
`node scripts/migrate-tenants.mjs`.

**PostgreSQL is reaped between tool calls.** Source the environment and run the suite in **one**
command, or the run will fail for reasons that are not about the code.

## 6. Suites and their current numbers

Run them; do not quote these as current results.

```bash
pnpm --filter @edms/web exec vitest run --project=e2e src/test/e2e/<file>
```

| Suite | Last known |
| --- | --- |
| `shell.e2e.spec.ts` | 8/8 |
| `search.e2e.spec.ts` | 23/23 |
| `dashboard.e2e.spec.ts` | 19/19 |
| `recent-empty.e2e.spec.ts` | 15/15 |
| `consistency.e2e.spec.ts` | 11/11 — contains the group-title measurement to update |
| `recovery.e2e.spec.ts` | 19 **skipped** — needs `DR_DEST_ADMIN_URL`; environment, not failure |

Gates: `pnpm format:check`, `lint`, `typecheck`, `test`, `verify:styles`, `build`.
`pnpm test:visual` reports **97 pass / 10 fail** — the ten `ar-document-list-*` surfaces differ by
Arabic font metrics in this container and have since Phase 7.1. Not a regression.
API integration: **656/659** — the three failures are the MinIO presigned-upload tests; this
container has a `docker` client but **no daemon**. Environment, not product.

## 7. Conventions that are load-bearing

These were each learned expensively. Breaking one produces a plausible-looking wrong answer.

- **Measure, do not read.** Every visual claim in these phases came from the running application.
  Two contrast findings were wrong precisely because they were not measured properly.
- **Settle transitions before measuring colour.** `SidebarNav` has `transition-colors`;
  `getComputedStyle().color` mid-flight returns an interpolated value. Use `settleColours` from
  `apps/web/src/test/e2e/theme.ts`. Phase 7.8 turned one such reading into a platform finding that
  was not real.
- **Composite through a canvas** for any faded colour — `color` comes back as `oklab(… / 0.7)` and
  naive parsing silently yields black.
- **Navigate as little as possible.** The API's rate limit is 300 requests/60s and a dashboard render
  costs a dozen. One page load per route, then resize. A suite that re-navigated per width drove the
  product into a real `RATE_LIMITED` boundary that looked exactly like a missing nav control.
- **Prove every regression test can fail** — revert the fix, watch the *right* assertion break,
  restore. A test that fails on everything is asserting the wrong thing.
- **Never hardcode a colour**; `no-raw-colours.spec.ts` enforces it across all 22 Tailwind scales.
- **No invented data, Arabic, or names.** If something cannot be produced by the product's own
  mechanism, say so.
- **Open the screenshots.** Several defects survived source review and died on sight.

## 8. Known-open findings, deliberately not fixed

From the Phase 8 audit (`docs/reports/phase-8-platform-consistency-audit.md` §8), in priority order:

| # | Finding | Owner |
| --- | --- | --- |
| P1 | group-title contrast — **this handover** | platform |
| P1 | primary action not in `PageHeader.actions` on Reports, Notifications, Recycle bin, Delegations, Audit | product, 5 screens |
| P2 | `/delegations` overflows at 390px — diagnose before proposing a cause | product |
| P3 | `/audit` renders `PageHeader` with no `Page` | product |
| P4 | ~30 `text-* opacity-70` sites — consistency, not accessibility | product |
| — | `Badge` `text-primary-strong` 4.31:1, open since Phase 5.2 | platform |
| — | the two `SidebarNav` consumers disagree about group titles (main rail suppresses, admin renders six) — decide **after** the platform fix | product decision |

## 9. Do not

Open a PR unless asked. Push to any branch other than
`claude/enterprise-feature-audit-y30g5o`. Rewrite historical reports — Phase 7.9's retraction and
Phase 8's finding must both stay readable as written. Move the platform fix into this repository.
