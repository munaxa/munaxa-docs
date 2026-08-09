# Phase 6.9 — Real-Browser Workflow Completion & Production Path Verification

## 1. Executive summary

**Status: COMPLETE WITH FINDINGS.** All eight remaining workflows now execute through a real
browser against the real product. None was blocked; none required a capability to be invented.

The phase found **two P0 defects**, both of which meant screens could not be opened *at all* in a
built deployment, and both invisible to every check the repository had:

- **Twelve screens threw before rendering** — the document library and eleven administrative lists
  — because a server page cannot receive an array exported from a `'use client'` module. Next hands
  it a client *reference*, and `new Set(FILTER_KEYS)` threw `function is not iterable`.
- **`/delegations` answered `500`** for the third instance of the `pageSize: 200` defect Phase 6.6
  fixed in two other places.

Together that is **thirteen screens** that no user could open in any production build.

Both are fixed under §8's minimal-fix rule — the same remedy Phase 6.6 applied to
`EMPTY_FORM_STATE`, which is the same defect wearing a different hat. Nothing else was changed.

Four screens Phase 6.8 could not judge — notifications, search, templates and the audit timeline —
turned out to be **healthy**. Three of my own early assertions were wrong about them, and the reason
is recorded in §17 because it will catch the next person: `body.textContent` includes the RSC
payload, which embeds every error-boundary string a route could ever render.

The Phase 6.8 P0 remains fixed, and is now asserted where it would actually happen: opening a
document in the browser issues fewer than ten content URLs, against the 6,704 the defect produced.

| | Count |
| --- | --- |
| P0 | **2** (both fixed) |
| P1 | 0 |
| P2 | 1 |
| P3 | 2 |

## 2. Scope

The eight workflows Phase 6.8 left NOT VERIFIED, executed against `apps/api/dist/main.js`,
`next start` over the production build, PostgreSQL 16 across **two tenant databases**, Redis and
real Chromium. No mocked API responses on any path, positive or negative.

Out of scope and observed: no Platform change, no API contract change, no new permission, no new
workflow state, no ADR change, no redesign. The known P2s from Phase 6.8 (`Retry-After`, field-level
errors) were **not** fixed — neither blocked a workflow.

## 3. The exact eight workflows

Derived from Phase 6.8 §15, which counted eleven and marked three VERIFIED in a real browser
(login, document screen, signature ceremony). **11 − 3 = 8.** No discrepancy to reconcile: the
preview viewer, which Phase 6.8 marked "VERIFIED (defect)", is a component of the document screen
rather than a twelfth workflow, and was measured in jsdom rather than a browser — this phase moves
that measurement into the browser too.

| # | Workflow | Primary route | Primary API | Auth | Permission | Tenant | Prior coverage | Prior status | Why selected |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Document library | `/documents` | `GET /documents`, `/admin/folders` | Session | `document:view` | Yes | jsdom + axe | NOT VERIFIED | Phase 6.6 fixed a `pageSize` defect on it but never opened it |
| 2 | Document lifecycle | `/documents/[id]` | `POST /documents/:id/archive` | Session | `document:archive` | Yes | jsdom | NOT VERIFIED | A state transition with an audit event, never driven |
| 3 | Bulk operations | `/documents` | `POST /documents/bulk/*` | Session | `document:edit`/`export` | Yes | integration only | NOT VERIFIED | Phase 6.2's queued path had no UI proof |
| 4 | Notifications | `/notifications` | `GET /notifications` | Session | `notification:manage` | Yes | jsdom | NOT VERIFIED | Recipient scoping is a security property |
| 5 | Search | `/search` | `GET /search` | Session | `document:view` (+`search:all`) | Yes | jsdom | NOT VERIFIED | Result filtering is an authorization surface |
| 6 | Templates | `/admin/templates` | `GET /admin/document-templates` | Session | `template:manage` | Yes | jsdom | NOT VERIFIED | Phase 6.5 built it for a domain with no caller |
| 7 | Audit timeline | `/audit` | `GET /audit` | Session | `audit:view` | Yes | jsdom | NOT VERIFIED | Compliance evidence nobody had rendered |
| 8 | Permissions / access denied | `/documents/[id]`, `/admin/permissions` | various | Session | varies | Yes | jsdom | NOT VERIFIED | "Never rely on UI hiding" needs both sides |

## 4. Verification method

One suite, one server lifecycle. The Phase 6.6 harness was extended rather than replaced:

- the fixture now seeds a **second tenant in a second database**, a second document, and a published
  document so a legal archive transition exists;
- `servers.ts` boots the API under a two-tenant `TENANT_CATALOGUE` when a neighbour exists and a
  single-tenant pair when it does not — chosen from what was actually seeded, so a catalogue naming
  an unmigrated database can never be written;
- the signing and workflow suites were **merged into one file** after two files each booting their
  own servers raced for the same port (§17).

Every assertion is an HTTP outcome, a database row, or a rendering that could only follow from one.

## 5–7. Workflow results, positive and negative

### 1 · Document library — **VERIFIED**

| | Result |
| --- | --- |
| Positive | Both seeded documents listed by title, from a real `GET /documents` |
| Negative | Another tenant's document by identifier shows nothing of it — not the title, no SQL, no database error |
| Bounded issuance | Opening a document issues **< 10** `/preview/content` requests and **< 120** total |
| Defect | **P0-1** — the page threw before rendering in every built deployment |

### 2 · Document lifecycle — **VERIFIED**

Archive driven through the real dialogue: the reason typed, the form submitted, then

- `document.status` read from the table becomes `ARCHIVED`;
- `audit_event` contains `ARCHIVED`;
- a fresh navigation offers **Reinstate** rather than Archive — persistence proven by a server
  render, not by client state.

The fixture had to be corrected twice, and both corrections were the product refusing an impossible
state: archival is only offered from `PUBLISHED`/`EXPIRED`/`SUPERSEDED`, and
`ck_document_numbered_when_published` refused a published document with no number. Both are
controls working.

### 3 · Bulk operations — **VERIFIED**

A real selection, a real bulk export, and a new row in `bulk_operation` — which is what makes it a
resumable server-side operation rather than a loop in a browser. No progress screen was built; §12
forbids it and none exists.

### 4 · Notifications — **VERIFIED**

The screen renders for a holder of `notification:manage`. Recipient scoping asserted at the
database: `notification_message` holds no row for any recipient but the caller, and the API takes no
recipient parameter, so there is no request by which one person could read another's inbox.

### 5 · Search — **VERIFIED**

A real query renders results or an honest empty state, with no error boundary and no leaked SQL. A
query naming the neighbouring tenant's document returns nothing of it.

### 6 · Templates — **VERIFIED**

Loaded by a browser for the first time. Phase 6.5 built this screen for a domain that had no caller
anywhere in the product; it works.

### 7 · Audit timeline — **VERIFIED**

Renders for a holder of `audit:view`, with real history present in the trail by that point in the
run (the lifecycle workflow archived a document), so an empty screen would have been a finding.

### 8 · Permissions and access denied — **VERIFIED**

Three assertions: a reader is offered no Sign action; an administrative screen answers with a page
rather than a stack trace; and the neighbouring tenant's signer sees nothing of this tenant's
document — not the title, not the number. The API-side refusal (`403` on the preview route for a
reader) is asserted in the same file, so the courtesy and the control are both proven.

## 8. Tenant isolation results — **VERIFIED**

Two tenants in **two databases**, three assertions through the product:

| From | To | Result |
| --- | --- | --- |
| Tenant A signer | Tenant B document, by identifier | Nothing of it; no SQL, no driver error |
| Tenant A signer | Search for tenant B's title | No result |
| Tenant B signer | Tenant A document, by identifier | Nothing of it, including the document number |

## 9. Persistence results — **VERIFIED**

Archive survives a fresh navigation; the signature survives a full reload (carried over from Phase
6.6 and re-run here). Both read from a server render rather than from client state.

## 10. Audit results — **VERIFIED**

`ARCHIVED` written by the backend for the lifecycle transition; `DOCUMENT_SIGNED` exactly once for a
signature and never for a preview, a cancellation, a credential failure or a rate-limited request.
The UI writes no audit event of any kind.

## 11. Notification / outbox results — **KNOWN LIMITATION**

The notification *screen* is verified. The production path
`action → event → outbox → notification lane → delivery → UI` was **not** driven end to end: the
worker is a separate process that this harness does not boot, and §14 forbids proving it with
synthetic events. Recorded as NOT VERIFIED rather than implied.

## 12. Accessibility results

**KNOWN LIMITATION, stated plainly.** This phase exercised the workflows; it did not add axe passes
for each. The existing coverage stands — 126 rendered assertions including axe over the signing
ceremony's every stage, keyboard-only completion, and 36 contrast/screenshot assertions in both
themes — and the browser suite exercises real keyboard and pointer interaction on the lifecycle
dialogue. Per-workflow axe in Chromium is the obvious next increment and is recommended in §23.

## 13. Visual results — **VERIFIED, unchanged**

36 assertions pass. No new baselines: the workflows this phase executed render screens that already
had coverage or whose states are not new. Nothing was redesigned and no colour or spacing changed.

## 14. Defects found

### P0-1 — Twelve screens threw before rendering in any built deployment

**Root cause.** `DOCUMENT_FILTER_KEYS`, `USER_FILTER_KEYS` and nine others were
`export const … as const` in modules beginning `'use client'`. A server page importing a value from
a client module does not receive the value: Next replaces client-module exports with **client
references**, so `new Set(filterKeys)` received a function.

**Evidence.** From the built application's own log:

```
⨯ TypeError: function is not iterable (cannot read property Symbol(Symbol.iterator))
    at new Set (<anonymous>)
    at j (.next/server/app/(workspace)/documents/page.js:1:17540)
```

and a sweep of every workspace screen in the production build:

```
BROKEN /documents            BROKEN /admin/document-types   BROKEN /admin/users
BROKEN /admin/retention      BROKEN /admin/approval-groups  BROKEN /admin/libraries
BROKEN /admin/workflows      BROKEN /admin/working-calendars BROKEN /admin/departments
BROKEN /admin/entities       BROKEN /admin/branches          BROKEN /admin/fields
```

**Affected workflow.** #1 directly; eleven administrative screens besides.

**Severity.** P0 — the main document list of a document-control product could not be opened.

**Why the nine survivors survived.** They pass no filter keys, so `filterKeys` defaults to `[]` and
`new Set([])` is fine. A latent trap that fires the day somebody adds a filter.

**Minimal fix, applied.** All 33 constants moved to `apps/web/src/lib/admin/list-keys.ts`, a plain
module with no boundary to cross, and the 21 pages repointed. No values changed. The client screens
did not use them.

**Why the fix belongs in this phase.** Workflow #1 is mandatory and cannot be executed at all
otherwise. It is §8's "obvious runtime exception" and "broken UI/API wiring", and it is the same
remedy Phase 6.6 applied to `EMPTY_FORM_STATE`.

### P0-2 — `/delegations` answered `500`

**Root cause.** `adminGet('/admin/users?page=1&pageSize=200&status=ACTIVE')` against a
`MAX_PAGE_SIZE` of 100. The pagination schema *rejects* it, so the request 422'd and the page threw.

**Evidence.** `code: 'VALIDATION_FAILED'` from the built app at
`app/(workspace)/delegations/page.js`.

**Severity.** P0 — the third instance of a defect Phase 6.6 fixed twice. Nobody had opened the page.

**Minimal fix, applied.** `200 → 100`, with the reason recorded in place. A tenant with more than a
hundred users still needs a searching picker; that is a product decision, not this phase's.

### P2-1 — `GET /documents/:id/revisions` answers `404` for a document with no revision, unguarded

Found while building the fixture. The document screen guards `preview` with `.catch(() => null)` but
not `revisions`, so a document without one takes the whole page down. **Not proven reachable**: Phase
3 writes a document and its first revision in one transaction, so the state may not occur in
practice. Recorded rather than fixed, because fixing an unreachable case is inventing behaviour.

### P3-1 — Notification production path unproven end to end

§11. Needs the worker booted; the harness does not do that yet.

### P3-2 — Per-workflow accessibility not exercised in Chromium

§12.

## 15. Defects fixed

| Defect | Fix | Files |
| --- | --- | --- |
| P0-1 | Constants moved to a server-safe module | `lib/admin/list-keys.ts` (new), 12 client screens, 21 pages |
| P0-2 | `pageSize` 200 → 100 | `app/(workspace)/delegations/page.tsx` |

No business behaviour changed, no API contract, no permission, no ADR, no Platform package.

## 16. Defects deferred

`Retry-After` (Phase 6.8 F-2), field-level API errors (F-3), the `outbox-dispatch` sleep (F-8), the
build-time advisories (F-6), `translatorFor`'s unstable identity (F-7), and P2-1 above. None blocked
a workflow, and §2 says not to mix them in.

## 17. Harness defects — mine, and worth recording

Three of my own, because each would have been reported as a product defect by a less careful run.

**`body.textContent` includes the RSC payload.** A Next page embeds its React payload in `<script>`
tags, and that payload contains every error-boundary string the route could ever render. Asserting
"the page does not say *Something went wrong*" against `textContent` matched the **fallback text of
a boundary that never fired**, and reported four healthy screens — notifications, search, templates,
audit — as broken. Fixed with a `visibleText()` helper that reads `innerText` of the main landmark.

**Two e2e files, one port.** Each booted its own API and web server; `next start` forks a
`next-server` that outlived a process-group kill, and the second file then failed to bind. Fixed
twice over: teardown now frees the ports explicitly, and the two suites were merged into one file so
there is a single lifecycle that cannot race itself.

**A fixture in a state the product cannot reach.** The second document was seeded as a `DRAFT` with
no revision, which made the archive action legitimately absent and `GET …/revisions` legitimately
`404`. Both looked like defects and were not. The corrections are the product's own rules —
`IMPLEMENTED_TRANSITIONS` and `ck_document_numbered_when_published`.

## 18. Infrastructure issues

PostgreSQL and Redis were reclaimed once and restored by the documented procedure. Several stray
servers from manual diagnosis had to be cleared by hand, which is what prompted the teardown fix in
§17.

## 19. Test quality assessment

Every assertion added by this phase would fail if the feature were unreachable in production:

| Assertion | Could it pass while broken? |
| --- | --- |
| Both documents listed by title | No — it read `GET /documents` through the built app |
| `document.status` becomes `ARCHIVED` | No — read from the table |
| `audit_event` contains `ARCHIVED` | No — read from the table |
| A `bulk_operation` row appears | No |
| `notification_message` holds nobody else's rows | No |
| `< 10` `/preview/content` requests | No — counted at the network layer |
| Neighbour's document invisible three ways | No — two databases |
| Reader offered no Sign action; API answers `403` | No |

**24 browser assertions in total**, all against unmocked servers.

## 20. Updated risk matrix

| Finding | Severity | Status | Blocks production |
| --- | --- | --- | --- |
| P0-1 twelve screens unopenable | P0 | **Fixed** | Was yes |
| P0-2 `/delegations` `500` | P0 | **Fixed** | Was yes |
| F-5 no restore rehearsal (6.8) | P2 | Open | Operationally, yes |
| F-2 `Retry-After` (6.8) | P2 | Open | No |
| F-3 field errors (6.8) | P2 | Open | No |
| P2-1 unguarded `/revisions` `404` | P2 | Open, unproven reachable | No |
| P3-1 notification path unproven | P3 | Open | No |
| P3-2 per-workflow axe | P3 | Open | No |
| F-6/F-7/F-8 (6.8) | P3 | Open | No |

## 21. Remaining findings

**P0:** none open. **P1:** none. **P2:** four (restore rehearsal, `Retry-After`, field errors,
unguarded `/revisions`). **P3:** five.

## 22. Production readiness impact

Materially improved, and the improvement is not the tests — it is that **thirteen screens which
could not be opened now open**. Phase 6.8's largest stated risk was that eight of eleven workflows
had never been run and that every screen opened for the first time had been broken; that pattern
held for two more, and is now closed for all eleven.

What still stands between this and production is unchanged and is not code: **no restore rehearsal
has ever been performed**. That remains NOT VERIFIED.

The base rate deserves recording. Across Phases 6.6, 6.8 and 6.9, **every** screen opened in a real
browser for the first time was broken: `/login`, `/documents` (twice, two different defects), the
document screen, the preview viewer, `/delegations`, and eleven administrative lists. Nothing else
in the repository's test suite could see any of them.

## 23. Recommended next phase

1. **Boot the worker in the harness** and prove the notification path end to end (P3-1).
2. **Per-workflow axe in Chromium** (P3-2) — the infrastructure exists; only the passes are missing.
3. **Rehearse a restore** (F-5) — the one readiness gap code cannot close.
4. Carry `retryAfterSeconds` and `errors[]` through (F-2, F-3), together a small, well-scoped phase.
5. Consider a lint rule forbidding non-function `export const` from `'use client'` modules — it
   would have caught both of this phase's P0s and Phase 6.6's, mechanically.

## 24. Evidence and commands

```bash
# The eight workflows, plus the signing ceremony, in one lifecycle
pnpm test:e2e                     # 24 passed — real API, real web server, real Chromium, 2 tenants

# The production-build sweep that found P0-1 (27 routes, signed in, built app)
#   BROKEN: /documents and 11 administrative lists; /delegations by a different cause

# The defect itself, from the built application's log
#   TypeError: function is not iterable … at new Set … app/(workspace)/documents/page.js

# Bounded presigned-URL issuance, Phase 6.8's P0, now asserted in the browser
#   expect(requests.of('/preview/content')).toBeLessThan(10)
```

### Gate results

| Gate | Result |
| --- | --- |
| `pnpm format` | clean |
| `pnpm lint` | **0 errors** |
| `pnpm typecheck` | 13/13 |
| `pnpm test` | web 126 · API 644 / 1 skipped · domain 164 · contracts 26 · utils 11 · i18n 4 · worker 2 |
| `pnpm test:integration` | 36 files, **651 passed**, 0 skipped |
| `pnpm test:visual` | **36 passed** |
| `pnpm test:e2e` | **24 passed** (was 10) |
| `pnpm build` | 9/9 |
| `pnpm verify:styles` | 10/10 |

## 25. Final status

**COMPLETE WITH FINDINGS.**

All eight workflows executed through a real browser against real servers, real databases and real
Redis. Positive and negative paths verified, tenant isolation proven across two databases,
persistence and audit read back from the tables. Two P0 defects found and fixed under the minimal-fix
rule; nothing else changed. No workflow was blocked, no capability invented, no Platform touched.

## Evidence vocabulary

- **VERIFIED** — the eight workflows' positive and negative paths, tenant isolation, persistence,
  audit side effects, bounded content-URL issuance, and both P0 fixes.
- **IMPLEMENTED** — the two-tenant harness extension and the merged suite.
- **KNOWN LIMITATION** — notification production path; per-workflow axe; `outbox-dispatch` timing.
- **NOT VERIFIED** — restore rehearsal; container images; the worker process.
- **FAILED** — P0-1 and P0-2 as found, now fixed.
- **FUTURE ENHANCEMENT** — §23.
