# Phase 7.6C — Dashboard Running-App Verification & Responsive Closure

**Verdict: PARTIALLY COMPLETE — but the blocking gap is closed.** The dashboard now runs against a
real PostgreSQL, a real Redis, a real API, a real production web build and a real login, in real
Chromium, at all six widths. Two findings came out of it, one of which only the running application
could have produced. Arabic RTL in the running app and the recent-document *row* remain unverified,
for reasons given in §8.

---

## 1. The dependencies existed all along

Phase 7.6B reported this blocked because `pg_isready` and `redis-cli ping` failed. That was true and
the conclusion drawn from it was wrong: the **servers were not running**, but the **binaries were
installed**.

```
/usr/lib/postgresql/16/bin/…      PostgreSQL 16.13
/usr/bin/redis-server              Redis 7.0.15
```

No infrastructure was created. No service was added, no compose file written, no CI job changed. The
cluster was started by hand following the repository's own documented CI procedure, and the tenant
databases were built by the repository's own runner.

**Correction to the previous phase, stated plainly:** 7.6B should have checked for the binaries
before declaring the requirement blocked. "The service is not answering" and "the service cannot
exist here" are different claims, and I reported the second while only having evidence for the first.

---

## 2. Dependency verification

| Dependency | Evidence | Result |
| --- | --- | --- |
| PostgreSQL | `select version()` → `PostgreSQL 16.13 (Ubuntu 16.13-0ubuntu0.24.04.1)` | PASS |
| Cluster roles | `infra/sql/cluster/01-roles.sql` → `DO`, `ALTER ROLE`×2 | PASS |
| Tenant databases | `CREATE DATABASE ci_edms_acme`, `ci_edms_rival` | PASS |
| Migrations | `node scripts/migrate-tenants.mjs` → "Migrated 2 tenant database(s)" incl. all four post-migration SQL files | PASS |
| Redis | `redis-cli ping` → `PONG` | PASS |
| API | NestJS booted under the E2E harness | PASS |
| Web | production build served by the harness | PASS |
| Authentication | `signInAndCapture` — real `/login` form, real credentials, real session cookie. **No mock, no bypass, no test-only route.** | PASS |

Two boot failures occurred and were fixed as *configuration*, not as bypasses:

1. `JWT_ACCESS_SECRET: Required` — the harness expects the environment CI supplies. Provided the
   same values `ci.yml` uses.
2. `Executable doesn't exist at …chromium_headless_shell-1234` — Playwright's resolver wanted a
   build this image does not carry. Pointed at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`,
   which is exactly the accommodation `src/test/browser.ts` already makes, with `existsSync`
   fallback so the file still works where the default resolver is correct.

No timeout was raised, no sleep added, no retry introduced, no assertion weakened.

---

## 3. E2E result

`src/test/e2e/dashboard.e2e.spec.ts` — **12 tests, all passing, 6.6s.**

- loads the dashboard rather than the login screen or an error boundary
- renders "My work" and "Recently opened"
- **never shows a raw translation key** — now asserted against the *real API's own enum values*
  rather than a fixture's
- logs **no console errors**
- does not fan out — the browser makes **at most one** `/dashboard` call
- fits the viewport at 1440, 1280, 1024, 768, 640 and 390
- keeps the recent-document panel reachable on a phone

**One sign-in, one page, six `setViewportSize` calls.** Six logins and six page loads to measure a
layout would spend real rate-limit budget for no reason — which is precisely the failure Phase 7.1C
spent a phase diagnosing. The layout is CSS; it does not need a new request to be re-measured.

The overflow assertion is `document.documentElement.scrollWidth <= clientWidth` at every width. That
is the check a screenshot cannot make without a human, and it passed at all six.

---

## 4. What the running application confirmed

- **The 7.6A grouping holds against real data.** Three wide tiles, then four; no ragged gap.
- **The 7.6A key-leak fix is proven.** The Users tile renders **"Active 2"** and Documents renders
  **"Draft 2 / Published 1"** — real enum values from a real database, resolved to real words. The
  earlier evidence was a fixture; this is the product.
- **Empty states are correct, not broken.** "Nothing opened yet.", "You have not marked anything as
  a favourite.", "No cover is in place." — the screen degrades honestly with a fresh tenant.
- **The shell, bell and theme toggle all fit at 390**, with the rail behind a hamburger.

---

## 5. Finding — the account chip renders raw UUIDs (CONFIRMED, P2)

Phase 7.5 recorded this from source inspection. The running application shows it:

```
e56b815a-28ce-4a3d-8c20-c26ea3a78bb3
d28954af-6e75-448d-9cf2-f5101869d59c
```

Two UUIDs where a person's name and their organisation belong, in the top-right of every screen.

**Not fixed here, deliberately.** `/auth/me` returns `userId`, `tenantId`, `roles`, `permissions` —
no display name and no email — so the fix is an API change, which §12 of this brief forbids and
which is not a dashboard concern. Classified **P2, PRE-EXISTING**, and now backed by a screenshot
rather than an argument.

---

## 6. Request-count evidence

| Measure | Result |
| --- | --- |
| Browser → API `/dashboard` calls | **≤ 1** (asserted); the route is server-rendered, so the browser should make none |
| Requests triggered by resizing | **0** — six viewport changes, no new request |
| Failed requests | none observed |
| Console errors | **0** |

Phase 7.6B's "zero requests added" is preserved, and is now measured in a browser rather than argued
from the diff.

---

## 7. Gates

| Gate | Status |
| --- | --- |
| `pnpm format:check` | RUN — PASS |
| `pnpm lint` | RUN — PASS 13/13 |
| `pnpm typecheck` | RUN — PASS 13/13 |
| `pnpm test` | RUN — PASS 13/13 |
| `pnpm verify:styles` | RUN — PASS 10/10 |
| `pnpm test:visual` | RUN — 93 pass / 10 fail, all ten **PRE-EXISTING** Arabic-font surfaces |
| **Dashboard E2E** | **RUN — PASS 12/12** |
| axe | PRE-EXISTING PASS (via `pnpm test`; not re-run against the live page — §8) |

No baseline changed in this phase. Nothing was regenerated, because nothing in the UI was modified.

---

## 8. NOT VERIFIED — read before treating this as closed

- **The recent-document row was never exercised.** The seeded tenant has no "recently opened"
  history and no favourites, so both panels rendered their empty states. Every 7.6B improvement —
  status badge, folder, format, date — is therefore **still only verified statically**. Producing a
  view event would mean driving the library and opening a document, which is a bigger E2E than this
  phase's closure goal; recorded rather than faked.
- **Arabic RTL was not driven in the running app.** The `edms_locale` cookie is the mechanism and it
  is reachable, but I did not get to it. Static RTL evidence from 7.6B stands; running-app RTL does
  not.
- **axe was not run against the live page.** It passes against the same components in jsdom.
- **`FormatBadge` still unexercised visually** (carried from 7.6B) — the fixture document has no
  file.
- **Dark theme was not captured in the running app**; light only.

---

## 9. Deliberately not changed

The dashboard UI. §12 says not to redesign unless the running application reveals a defect, and it
revealed one (§5) that is out of scope by the same brief's §12 rule against API changes. Everything
else behaved correctly, so nothing was touched.

---

## 10. Commands executed

```
initdb -D /tmp/edms-pg -U edms_owner --auth-local=trust --auth-host=trust     # as user postgres
pg_ctl -D /tmp/edms-pg -l /tmp/pg.log -o '-p 5432 -h 127.0.0.1' start
redis-server --daemonize yes --port 6379 --bind 127.0.0.1
psql … -c 'CREATE DATABASE ci_edms_acme OWNER edms_owner' -c 'CREATE DATABASE ci_edms_rival …'
psql … -f infra/sql/cluster/01-roles.sql
TENANT_CATALOGUE='…' node scripts/migrate-tenants.mjs
pnpm exec vitest run --project e2e src/test/e2e/dashboard.e2e.spec.ts
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm verify:styles
pnpm --filter @edms/web test:visual
```

---

## 11. Verdict

**PARTIALLY COMPLETE.**

Met: PostgreSQL · Redis · real API · real production web build · real authentication · dashboard
loads with real data · 1440 · 1280 · 1024 · 768 · 640 · 390 all verified **in the running
application** · request fan-out measured in the browser · no console errors · E2E passes · gates run
· report written and indexed · tree clean · committed · pushed · no PR.

Not met: **Recent Documents not exercised** (empty tenant) · running-app Arabic RTL · running-app
dark theme · axe against the live page.

The three-phase blocker is closed. What remains is a smaller, well-defined gap: seed a tenant with a
view history so the row this sequence spent two phases improving can finally be seen in the product.
