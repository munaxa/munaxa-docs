# Phase 9 — Production Readiness & Release Certification

## 1. Executive decision

**MUNAXA DOCS IS NOT PRODUCTION READY.**

Every code-level gate that could be executed in this environment **passed**, and one Phase 8
disposition turned out to be better than recorded (§17). The decision is negative for two reasons,
neither of which is a defect in the product:

1. **CI enforces nothing.** Neither repository protects `main`. The certifying session holds
   `admin: false`, the protection API answers `403`, and the API proxy additionally refuses writes to
   that path. Gate 16 cannot be satisfied from here, and §34 of the brief is explicit: absent branch
   protection, the answer is NOT PRODUCTION READY.
2. **Deployment, post-deployment smoke and rollback were never executed.** There is no Docker daemon
   and no production-equivalent environment in this session. Gates 21, 22 and 23 are unproven, and
   §40 forbids certifying on a local build alone.

Both are **environmental and administrative**, and both have named remedies. Nothing found in Phase 9
requires a change to Munaxa Docs' code.

## 2. Certification scope

The Docs application, the API, the worker, the shared platform package as consumed, the verification
pipeline, and the operational procedures as documented. Excluded: any environment this session cannot
reach — production, staging, the container registry, and repository administration.

## 3. Exact commits and versions

| | |
| --- | --- |
| Docs `main` / designated branch / local | **`1f0c8d6`** (merge of PR #40) |
| Platform `main` | **`61810a6`** |
| Platform package | **`@munaxa/platform@1.5.1`**, registry `latest`, one copy in the store |
| Docs default branch | `main`, **unprotected** |

## 4. Environment

Certified on a Linux container: Node 22, pnpm 10.33.0, PostgreSQL 16 on 5433 (source) and 5434 (DR
destination), Redis 7, Chromium 1194. **No Docker daemon.** No staging or production target. Zero
Arabic fonts (`fc-list`) — which matters less than Phase 8 believed (§17).

## 5. Gate matrix

| Gate | Requirement | Evidence | Status | Blocker? |
| --- | --- | --- | --- | --- |
| 0 | Repository state | Docs `1f0c8d6` = remote; Platform `61810a6` = remote; both trees clean | **PASS** | no |
| 1 | Version & package integrity | wiped `node_modules`, `--frozen-lockfile` → **1 copy**, 1.5.1, registry tarball, 0 local protocols, 0 `.tgz`; installed dist carries `modal = false` | **PASS** | no |
| 2 | Build integrity | lint, typecheck, build, `verify:styles` all green; no test artefacts, fixtures, credentials or debug routes in `dist`/`.next` | **PASS** | no |
| 3 | Component certification | **52/52**, 106 stories × 4 brands × 2 schemes, 620s; Phase 8 guards present and asserting | **PASS** | no |
| 4 | Application accessibility | **177 unfiltered measurements → 0 findings at any impact** | **PASS** | no |
| 5 | Responsive | 320 and 390 across 33 routes + RTL: **0 horizontal overflow** | **PASS** | no |
| 6 | Keyboard & focus | menus and dialogues: focus entry, containment, Escape, restoration — 12/12; no focus inside hidden subtrees | **PASS** | no |
| 7 | Overlay contract | menus `modal=false`, **0** hidden focusables; dialogues `aria-modal="true"`, 0 tab escapes | **PASS** | no |
| 8 | Authentication | limiter 10/300s ip+identity, untouched since Phase 6.7; no bypass in production code; wrong-credential and session paths asserted in `signing.e2e` | **PASS** | no |
| 9 | Authorization / RBAC | server-side refusals asserted **at the API**, not just the UI — statement preview and signing refused to a reader; a screen the caller may not have renders a refusal | **PASS** | no |
| 10 | Tenant isolation | RLS **forced on 77 of 79 tables** in both databases; cross-tenant document, search and notification access all refused | **PASS** | no |
| 11 | Data integrity | four `.catch(() => …)` in API production code, each classified (§10); none hides a persistence failure | **PASS** | no |
| 12 | Audit / security logging | `trg_audit_event_append_only` enabled; logger redacts password, hash, token, secret at the sink; read-audit flush failure **is** logged at `error` | **PASS** | no |
| 13 | Database migrations | databases **dropped and recreated**, roles applied, `migrate-tenants.mjs` → 79 tables, RLS forced, trigger enabled, suite green on the fresh schema | **PASS** | no |
| 14 | Recovery / DR | **19/19**, destination verified empty (0) before and 2 restored after; `countsSql` intact; no timeout raised | **PASS** | no |
| 15 | Fixture safety | fixture created → cleaned → **0 `e2e*` tenants**, with `real-customer` **surviving**; RLS forced and trigger enabled afterwards; no leaked `app.tenant_id` | **PASS** | no |
| 16 | **E2E enforcement / branch protection** | `protected: false` on **both** repos; `GET` protection → **403**; `PUT` → **403** (proxy); repo permissions `admin: false` | **ADMINISTRATIVE** | **YES** |
| 17 | PR enforcement proof | cannot be attempted — Gate 16 unsatisfied | **NOT APPLICABLE** | consequence of 16 |
| 18 | CI completeness | 7 job instances, none `continue-on-error`, none conditional, none skipped; all ran on the PR head and reported | **PASS** | no |
| 19 | E2E authentication budget | shards measured at **7 / 8 / 4** against 10 per 300s; no limiter, timeout, counter or session change | **PASS** | no |
| 20 | Visual certification | `pnpm test:visual` **passes in CI** — 107/107 on the PR #40 run; local 93/14 is the documented, intended cost of baselines pinned to the gating environment (§17) | **PASS** | no |
| 21 | Deployment | **not executed** — no Docker daemon, no production-equivalent target | **ENVIRONMENTAL** | **YES** |
| 22 | Post-deployment smoke | **not executed** — depends on 21 | **ENVIRONMENTAL** | **YES** |
| 23 | Rollback | **not executed** — depends on 21; procedure documented and expand-only migrations make it coherent, but unproven | **ENVIRONMENTAL** | **YES** |
| 24 | Observability | health probes (`live`, `ready`, detail), token-guarded metrics, redaction at the logger | **PASS** | no |
| 25 | Operations | deployment, backup/restore, DR and pen-test procedures exist and name real commands; the DR procedure is exercised by `recovery.e2e` | **PASS** with a caveat (§22) | no |

**Failed code gates: none. Blocking gates: 16, 21, 22, 23 — all administrative or environmental.**

## 6. Accessibility certification

177 measurements, full axe ruleset, **no impact filter**, at commit `1f0c8d6`:

| Scope | Pages | Findings |
| --- | --- | --- |
| Signer, 1280 light | 33 | 0 |
| Parameterised routes | 2 | 0 |
| 320 / 390 | 66 | 0 (and 0 overflow) |
| Dark | 33 | 0 |
| Arabic RTL (`dir="rtl"`) | 33 | 0 (and 0 overflow) |
| Reader session | 8 | 0 |
| Anonymous `/login`, `/mfa` | 2 | 0 |

Plus the component matrix at **52/52**. The two documented exceptions (the Radix portal wrapper, the
`/documents` landmark pair) do not appear in a resting page sweep and are re-affirmed in §23.

## 7. Authentication certification

`auth.login` remains `windowSeconds: 300, limit: 10, by: ['ip','identity']`;
`apps/api/src/core/security/` has not been modified since Phase 6.7, long before this audit. A search
of production code for `NODE_ENV === 'test'`, E2E env reads, `skipAuth` and `bypass` returns only
prose describing *emergency delegation* — a product control with its own audit trail, not an auth
escape. The wrong-credentials path is asserted (`creates nothing when the credentials are wrong`),
and the ceremony's rate limit is asserted at the API with a refusal that names no infrastructure.

## 8. Authorization / RBAC certification

Proven **server-side**, which is the requirement the brief sets. The fixture's two roles differ in
exactly one permission — `document:sign` — which makes the discriminator sharp:

- `does not offer signing to somebody who may only read` — the UI
- `refuses the statement preview to that same reader, **at the API**`
- `refuses the signing action to a reader, **in the browser and at the API**`
- `renders a refusal rather than a broken page on a screen the caller may not have`

UI hiding is never the only evidence; each has an API-level counterpart, and all run in CI.

## 9. Tenant isolation certification

- **77 of 79 tables** carry `FORCE ROW LEVEL SECURITY` in both tenant databases, verified after a
  clean migration and again after the full suite.
- `shows another tenant's document to nobody, by identifier`
- `refuses a query carrying another tenant's identifier, by returning nothing of it`
- `gives the neighbouring tenant nothing of this one`
- `renders the caller's own notifications and nobody else's`
- The neighbour lives in a **separate database**, so the claim is about the architecture rather than
  a `WHERE` clause.

## 10. Data-integrity certification

Every `.catch(() => …)` in API production code, classified:

| Location | What it swallows | Verdict |
| --- | --- | --- |
| `auth.controller.ts:133` | a display-name lookup for the account chip; falls back to the identifier | acceptable — presentational |
| `buffered-read-audit.writer.ts:243` | **nothing** — the failure is logged at `error` inside `flush()`; this only stops an unhandled rejection killing the reschedule timer | acceptable |
| `libreoffice.converter.ts:61` | a missing conversion output, which becomes a proper error | acceptable |
| `smtp-session.ts:123` | the `QUIT` command during teardown | acceptable |

No critical persistence failure can become a silent success. The audit trail is append-only by
database trigger, not by convention.

## 11. Audit / security certification

`trg_audit_event_append_only` is enabled in both databases after migration, after the full suite, and
after fixture cleanup. The logger redacts `password`, `passwordHash`, `token`, `secret` and their
siblings at the sink rather than at call sites. Security-sensitive refusals are observable: the rate
limiter logs its reason for an operator and returns nothing about infrastructure to the caller.

## 12. Database / migration certification

Executed rather than asserted: both tenant databases were **dropped**, recreated, the cluster roles
applied, and `scripts/migrate-tenants.mjs` run — the same runner an operator uses, reading the same
catalogue the API reads. Result: 79 tables, 77 RLS-forced, append-only trigger enabled, and the full
E2E suite green against that fresh schema. Migration ordering is enforced by the runner; the
post-migration SQL gate ran as part of it.

## 13. Recovery / DR certification

**19/19.** The destination cluster was re-`initdb`'d and verified to hold **0** `edms` databases
before the run and **2** after; the source was unaffected; the audit chain verified across the
restore; `countsSql` (Phase 8.18) intact; no timeout raised. This is the documented DR procedure
executed, not described.

## 14. Fixture safety certification

Proven first-hand at the certified commit:

```
tenants before : real-customer
seed           : e2e5205db0eee, real-customer
cleanup exit 0 : real-customer
e2e* remaining : 0
```

RLS forced (77) and the append-only trigger enabled afterwards; `app.tenant_id` unset in a fresh
session. A non-fixture tenant is untouched, and the teardown still refuses any slug not beginning
`e2e`.

## 15. CI enforcement certification

**This is the blocking gate.**

| Question | Answer |
| --- | --- |
| Do the jobs exist? | yes — 7 instances |
| Do they run on pull requests? | yes — all seven ran on PR #40's head |
| Is any allowed to fail? | **no** — none has `continue-on-error`, a condition, or a skip |
| Do they report status? | yes |
| **Do they gate the merge?** | **no** |
| `munaxa-docs` `main` protected | **false** |
| `munaxa-platform` `main` protected | **false** |
| `GET …/branches/main/protection` | **403** — "Resource not accessible by integration" |
| `PUT …/branches/main/protection` | **403** — "Write access to this GitHub API path is not permitted through this proxy" |
| Session repository permissions | `{admin: false, maintain: false, push: false, triage: false, pull: false}` |

PR #40 was merged only after all seven checks were green — but that was a **decision**, not a
control. The same merge would have succeeded with every check red. Two independent barriers prevent
this session from configuring protection, and neither was worked around.

## 16. E2E certification

161/161 at the certified commit, run as the three CI shards:

| Shard | Files | Tests | Logins | Budget |
| --- | --- | --- | --- | --- |
| signing, faded text, search | 3 | 56 | 7 | 10 |
| the screens | 4 | 83 | 4 | 10 |
| recovery and the data grid | 2 | 22 | 8 | 10 |

Run against a **freshly migrated** database, and green in CI on the PR head. No limiter change, no
timeout inflation, no counter deletion, no shared-session assumption.

## 17. Visual certification — and a correction to Phase 8

**PASS.** `pnpm test:visual` runs in CI as *Accessibility contrast and visual regression* and
**passed on the PR #40 run** — 107/107 in the environment the baselines are for.

Phase 8.21 through 8.25 recorded the 14 local Arabic failures as an unresolved environmental
prerequisite awaiting a "canonical font environment". The canonical environment already existed and
was already documented — in `visual.spec.tsx`'s own comment, which predates this audit:

> These ten baselines are generated on CI, not locally, and that is deliberate. … The baseline is the
> one from the environment that gates: CI. The cost is that these ten fail on a developer machine
> whose Arabic fallback differs, and the failure looks like a regression when it is a font.
> Regenerating them locally is the wrong repair — it moves the failure to CI.

So the local 93/14 is the **designed** cost of pinning baselines to the gating environment, not an
open prerequisite. Phase 8 was right to refuse to regenerate them and right that the cause was
environmental; it was wrong to carry this as something Phase 9 had to resolve before certifying.

The residual is real but smaller, and the repository already names it: nothing pins a font, so
`--font-arabic` and its Latin siblings resolve to whatever the host offers. The platform delegates
font loading to the application by design, and Munaxa Docs supplies none. The suite's own comment
calls the fix "font determinism (vendor the face, point fontconfig at it for the visual run)". That
is a **product typography decision**, listed in §26 — not a release gate, since real clients supply
Arabic system fonts and the gating environment is deterministic.

## 18. Deployment certification

**NOT EXECUTED.** `docker info` fails — there is no daemon and no `/var/run/docker.sock` — so the
three images cannot be built or run here, and no staging or production target is reachable from this
session. `docs/operations/deployment.md` describes a coherent path (build per target, migrate, then
workers → API → web, with `/api/health/ready` gating the load balancer), and the images **do** build
in CI on every commit. But an image that builds is not a deployment that serves, and §40 forbids
certifying deployment from a local build.

One deployment-configuration note, measured rather than assumed. I hypothesised that the web image
bakes `http://localhost:3001` as its API URL and would ship broken; **the measurement refuted it** —
the built server chunk contains `process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001"`, a
runtime read, and 0 client chunks reference it because the browser never calls the API directly. So
container environment does take effect. The residual is that an *unset* variable degrades silently to
localhost rather than refusing to boot, where the API refuses placeholder drivers in production. Worth
a deployment-time assertion; not a defect.

## 19. Post-deployment smoke certification

**NOT EXECUTED** — depends on §18. The smoke content is defined and already automated: the E2E suite
performs sign-in, document open, search, dialogue and menu interaction, audit verification and
cross-tenant refusal, and would need only a base URL to run against a deployed environment.

## 20. Rollback certification

**NOT EXECUTED** — depends on §18. The documented position is coherent and unusually explicit: a
rollback is a redeployment of the previous images, made safe by migrations being **expand-only until
the release after the one that stopped needing the old shape**, with any exception documenting itself
in its own SQL and shipping with a maintenance window. What a rollback does not undo — rows written
by the new code — is stated rather than glossed. It remains unproven until executed against a real
environment.

## 21. Observability certification

Health probes are separated by purpose: `live` touches nothing deliberately, so a database incident
cannot restart every pod; `ready` samples every tenant placement and Redis; the detail endpoint
carries no tenant data and no connection string; `/api/metrics` requires a bearer token. Redaction
happens at the logger. Failed security operations are logged for operators without returning
infrastructure detail to callers.

## 22. Operations certification

`docs/operations/` covers deployment, backup and restore, disaster recovery and penetration testing,
naming real commands. The DR procedure is genuinely exercised — `recovery.e2e` is that procedure —
and the release checklist treats every item as a blocking gate.

**Caveat, stated because the brief forbids documenting untested procedures:** the deployment,
rollback and staging-smoke sections describe steps that this session could not execute. They are
plausible and consistent with the artefacts, but Phase 9 has not proven them.

## 23. Accepted limitations

| Item | Why accepted |
| --- | --- |
| Radix portal wrapper counted by axe's `region` | one positioning element, no role, `tabIndex −1`, gone when closed; wrapping a transient menu in a landmark would be worse for the person the rule protects |
| `doc-kit` ×12 `scrollable-region-focusable` | excluded from the package `files` and absent from the 1.5.1 tarball — unshipped |
| `/documents` anonymous `<aside>` + nameless `<section>` | 2 of 271 landmarks; the aside wraps a *named* navigation, the section is not a landmark at all; both inside `main`, orphaning nothing |
| ContextMenu's unmeasured sub-parts | the platform ships it; this product renders none |

## 24. Environmental dependencies

1. **A container runtime and a production-equivalent target** — required for Gates 21–23.
2. **Arabic font determinism for local runs** — optional; CI is already deterministic and green.
3. **CI runner speed variance** — platform wall-clock budgets hold with ~92% headroom locally and
   have tripped on slow runners; watch, do not raise.

## 25. External dependencies

The platform's Cloudflare `Workers Builds: platform-storybook` check, red since PR #8, owned outside
both repositories and outside the release chain.

## 26. Post-launch items

`Combobox` ArrowDown (an APG enhancement with no product evidence of a defect); a second viewport in
the component matrix; `aria-errormessage`, currently unused; the optional `/documents` landmark
tidy-up; and **vendoring a font face for typography determinism**, which would close the same latent
gap for Latin.

## 27. Remaining blockers

| # | Blocker | Evidence | Owner | Required action | Code or administrative | Verification required |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `main` unprotected on **both** repositories | `protected: false`; `GET`/`PUT` protection → 403; `admin: false` | repository administrator | Configure branch protection requiring the seven Docs checks and the platform's CI + façade checks | **administrative** | Gate 17: prove a red required check cannot be merged |
| 2 | Deployment unproven | no Docker daemon; no staging or production target | release engineering | Deploy the three images built from `1f0c8d6` to a production-equivalent environment | **environmental** | health probes green; version recorded |
| 3 | Post-deployment smoke unproven | depends on 2 | release engineering | Run the E2E smoke against the deployed base URL | **environmental** | sign-in, documents, search, audit, isolation |
| 4 | Rollback unproven | depends on 2 | release engineering | Execute the documented rollback to the previous images | **environmental** | previous version healthy, data intact |

No blocker is a defect in Munaxa Docs' code.

## 28. Final decision

**MUNAXA DOCS IS NOT PRODUCTION READY.**

The product code is in the strongest state this programme has measured: 177 unfiltered accessibility
measurements with zero findings, 52/52 on the component matrix, 161/161 end-to-end against a
freshly migrated database, 19/19 recovery with a verified-empty destination, RLS forced on 77 of 79
tables, server-side authorization proven at the API, and every silent-catch in the API classified.
Twenty-one of twenty-five applicable gates pass; **none fails on code**.

It is not production ready because a release is not only software. Certification requires that the
pipeline **control** merges and that deployment and rollback be **executed**, and this session can do
neither: repository administration is refused at two layers, and there is no runtime to deploy into.

The distinction Phase 8.25 drew still holds and is now decided in the other direction: *ready for
certification* was true; *production ready* is not, and the gap is entirely outside the codebase.

## 29. Evidence and commands

```
git rev-parse HEAD                        → 1f0c8d6 (docs) · 61810a6 (platform)
rm -rf node_modules && pnpm install --frozen-lockfile → 1 platform copy, 1.5.1, 0 local protocols
pnpm lint · typecheck · build · verify:styles         → all 0
pnpm test:a11y (platform)                             → 52/52, 620s
psql DROP/CREATE + 01-roles.sql + migrate-tenants.mjs → 79 tables, 77 RLS-forced, trigger enabled
vitest --project=e2e (3 shards)                       → 56 + 83 + 22 = 161/161
recovery.e2e                                          → 19/19; destination 0 → 2
fixture seed + --cleanup                              → e2e* = 0, real-customer survives
GET  /repos/munaxa/{docs,platform}/branches/main      → protected: false
GET  …/branches/main/protection                       → 403
PUT  …/branches/main/protection                       → 403 (proxy)
GET  /repos/munaxa/munaxa-docs (permissions)          → admin: false
Actions run 31909976439 (PR #40)                      → 7/7 success, incl. visual 107/107
docker info                                           → no daemon
```

## 30. Corrections

Previous reports are not edited.

**Phase 8.21–8.25 overstated the visual gate.** All four carried the 14 Arabic failures as an
unresolved environmental prerequisite requiring a "canonical font environment" before Phase 9 could
certify. The canonical environment already existed — CI — was already documented in
`visual.spec.tsx`, and the suite has been passing there throughout, including 107/107 on the PR #40
run. Phase 8 was right not to regenerate baselines and right about the cause; it was wrong to treat
this as an open prerequisite. Gate 20 **passes**.

**Phase 8.25's inventory listed the Arabic font environment as an entry gate.** On this evidence it
is not a gate at all: it is a post-launch typography decision (§26). One of the three items Phase
8.25 handed to Phase 9 dissolves on measurement.

**A Phase 9 hypothesis of my own, refuted and recorded.** I expected the web image to bake
`http://localhost:3001` into client bundles and ship unable to reach a real API. The built output
shows a runtime `process.env` read and zero client-side references. The hypothesis was wrong and the
measurement is what settled it (§18).
