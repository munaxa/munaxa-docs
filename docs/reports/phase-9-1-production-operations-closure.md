# Phase 9.1 — Production Operations & Enforcement Closure

## 1. Objective

Close the four blockers Phase 9 left open — branch protection, deployment, post-deployment smoke and
rollback — plus the stray-branch cleanup, and issue the final production decision.

**Result: none of the four could be closed from this session, and a fifth defect was found and
fixed.** The decision is unchanged: **NOT PRODUCTION READY**.

## 2. Starting certified state

| | |
| --- | --- |
| Docs `main` | `1f0c8d6` |
| Docs branch (before this phase) | `0e61b50` |
| Platform | `61810a6` · `@munaxa/platform@1.5.1` |
| Phase 9 result | 21/25 gates pass, 0 code failures, 4 blockers |

Both trees clean at the start; no unexpected change since Phase 9.

## 3. Branch protection

Re-tested from scratch, every mechanism available:

| Check | `munaxa-docs` | `munaxa-platform` |
| --- | --- | --- |
| Repository permissions | `{admin: false, maintain: false, push: false, triage: false, pull: false}` | same |
| `branches/main` → `protected` | **false** | **false** |
| `GET …/branches/main/protection` | **403** — "Resource not accessible by integration" | **403** |
| `GET …/rulesets` | 200 → **`[]`** (no rulesets either) | 200 → **`[]`** |
| `PUT …/branches/main/protection` | **403** — "Write access to this GitHub API path is not permitted through this proxy" | — |
| `POST …/rulesets` (alternative mechanism) | **403** — same proxy refusal | — |
| `gh` CLI | not installed | — |

Two independent barriers: the session's token holds no administrative permission, **and** the API
proxy refuses writes to those paths regardless. The rulesets endpoint is readable and empty, so this
is not protection configured by another mechanism — there is none.

**Status: ADMINISTRATIVE BLOCKER.** No workaround was attempted.

## 4. Required checks

Recorded for whoever configures protection. These are the exact check names from the green run on
`c0a551b` (run `31929384850`) — not invented, not obsolete:

```
Lint · Typecheck · Test · Build
Integration · real PostgreSQL, two tenants
End-to-end · signing, faded text and search
End-to-end · recovery and the data grid
End-to-end · the screens
Container images · three targets from one commit
Product isolation
```

The platform repository's equivalents are `Lint · Typecheck · Test · Build`, `Façades match the
platform surface`, and `Accessibility · contrast and keyboard, every story, four brands, light and
dark`.

## 5. Merge enforcement proof

**Not attempted, and deliberately so.** §9 of the brief asks for proof that a red required check
cannot be merged. That proof requires protection to exist first; with `protected: false` there is
nothing to prove and a test PR would demonstrate only that an unprotected branch accepts anything —
which Phase 9 already established when PR #40 merged on an operator's judgement rather than on a
control.

## 6–8. Deployment target, configuration and evidence

**Not executed.**

| Prerequisite | State |
| --- | --- |
| Container runtime | `docker info` → no daemon; `/var/run/docker.sock` absent; `podman` not installed |
| Orchestration target | none; `infra/docker-compose.yml` declares itself "the local development stack… Nothing here is production configuration" |
| Staging or production environment | none reachable from this session |

The documented release path (`docs/operations/deployment.md`) builds three images from one commit and
rolls workers → API → web. The images **do** build in CI on every commit, which is evidence that the
Dockerfile is sound — and is not evidence of a deployment. No deployment was simulated and no
synthetic result was recorded.

**Status: ENVIRONMENTAL BLOCKER.**

### What was done instead, labelled precisely

A **production-mode boot of the certified API artefact on the certification host** — not a
deployment, and not offered as one. It exists because it can be done honestly and it turned out to
matter (§9).

| Probe | Result |
| --- | --- |
| `NODE_ENV=production` with placeholder drivers | **refused to boot**, naming `STORAGE_DRIVER`, `MAIL_DRIVER`, `AV_DRIVER` — the production guard is real in the shipped artefact, not just in source |
| `NODE_ENV=production` with `AV_DRIVER=CLAMAV` | refused — the valid set is `NONE \| ICAP \| HOSTED` |
| `NODE_ENV=production` without `MFA_TOTP_SEALING_KEY`, with `OPENAPI_ENABLED` | refused on both — "Authenticator secrets need their own sealing key in production", "The OpenAPI explorer is not served in production" |
| A complete, valid production configuration | **booted** — `Nest application successfully started` |
| Anonymous `GET /api/v1/documents` | **401** |
| `GET /api/health/live`, `/api/health/ready`, `/api/health` | **404, 404, 404** ← §9 |

## 9. The defect this phase found

**Every health probe in the operational runbooks answered 404.**

The `HealthController` took the global `defaultVersion: 'v1'`, so the probes were served at
`/api/v1/health/…`. Three operational documents describe the unversioned path:

- `deployment.md` — the probe table, and the release checklist gate: "`/api/health/ready` green on
  every instance before the load balancer is opened"
- `disaster-recovery.md` — "Confirm `/api/health/ready` on the replacement"
- `penetration-testing.md` — the unauthenticated surface: `/api/health/live`, `/api/health/ready`,
  `/api/health`

Measured on the running artefact:

| Path | Before | After |
| --- | --- | --- |
| `/api/health/live` | **404** | **200** |
| `/api/health/ready` | **404** | **200** |
| `/api/health` | **404** | **200** |
| `/api/v1/health/ready` | 200 | **404** |

**Impact.** A cluster configured from the runbook would have had liveness and readiness failing on
every instance — a rollout that never goes healthy, or, if the probe were configured to accept any
response, a false green in front of a broken deployment. The release checklist's gate could never be
satisfied as written.

**Ownership: the API.** Not the documents. `MetricsController` had already made the argument in its
own docstring — an operational endpoint is a contract with the deployment's monitoring rather than
with a customer's integration, and a scrape job needing an edit at a major version "would be an
alerting gap on the day of a release". A readiness URL pinned to `v1` breaks the day `v1` retires.
Health is now `VERSION_NEUTRAL`, exactly as metrics already was, and the three runbooks are correct
as written.

**Why nothing caught it:** no test asserted the health route, at any level. The guard added here runs
through `configureApp` — the production prefix, versioning and guard order — and asserts the three
documented paths answer without a credential, and that the versioned path does not.

| | Fix | Reverted |
| --- | --- | --- |
| liveness at the documented path | ✓ | ✗ `expected 404 to be 200` |
| readiness at the documented path | ✓ | ✗ `expected 404 to be 200` |
| operator detail at the documented path | ✓ | ✗ `expected 404 to be 200` |
| probes kept off the versioned surface | ✓ | ✗ `expected 200 to be 404` |

Committed as `c0a551b`. **CI: 7/7 green**, including the Integration job that runs this guard against
a real PostgreSQL.

## 10–13. Smoke, authentication, authorization, tenant isolation, audit

**Not executed against a deployment** — they depend on §6–8.

What is proven, and where: authentication, server-side authorization refusals, cross-tenant refusals
and the audit trail are all asserted by the E2E and integration suites, which run in CI on every
commit (Phase 9 §7–§11). The production-mode boot adds one deployment-shaped data point: an anonymous
request to a protected route was refused **401** by the artefact under production configuration.

That is not a substitute for smoke-testing a deployment, and is not offered as one.

## 14–16. Rollback, post-rollback verification, re-deployment

**Not executed.** All three depend on a deployment existing. The documented strategy remains coherent
— a rollback is a redeployment of the previous images, made safe by expand-only migrations — and
remains unproven.

## 17. Branch cleanup

`claude/phase-9-certification` at `08b7c653` — a branch this session created in error during Phase 9,
against the standing instruction to develop only on `claude/sidebar-nav-contrast-fix-nhpu3b`.

| Attempt | Result |
| --- | --- |
| `git push origin --delete` | `fatal: the remote end hung up unexpectedly` |
| `DELETE /repos/…/git/refs/heads/claude/phase-9-certification` | **403** — "Write access to this GitHub API path is not permitted through this proxy" |

Still present. Its content is identical to `0e61b50` on the designated branch, so nothing is lost by
deleting it and nothing is gained by keeping it.

**Status: ADMINISTRATIVE CLEANUP.** It is recorded rather than quietly dropped, because it was this
session's mistake.

## 18. Final regression

Everything re-measured after the code change, at `c0a551b`:

| | Result |
| --- | --- |
| lint · typecheck · production build · `verify:styles` | green |
| Unit: api / web / domain / contracts | 649 (+1 skipped) / 179 / 164 / 26 |
| Integration (CI, full stack) | **success** |
| E2E, three shards (CI) | **success** — all nine files |
| Container images | **success** |
| Product isolation | **success** |
| Docs CI overall | **7/7 green** |

Locally, five integration tests fail and were classified rather than waved through: three
presigned-upload tests need **MinIO**, and two queue tests need a **worker** — both provided by
Docker in CI and absent here. All five **reproduce on a clean tree with the change stashed**, and
CI's Integration job passes with the full stack, so they are environmental and not caused by this
change.

Phase 9's other measurements are unaffected by a route change and stand: component matrix 52/52,
177 unfiltered accessibility measurements with 0 findings, recovery 19/19, fixture tenants 0/0,
visual 107/107 in CI.

## 19. Final gate matrix

| Gate | Requirement | Evidence | Status |
| --- | --- | --- | --- |
| 0 | Repository state | trees clean; Docs `1f0c8d6` → `c0a551b` on the designated branch; Platform `61810a6` | PASS |
| 1 | Package integrity | 1 copy, 1.5.1, registry tarball, 0 local protocols | PASS |
| 2 | Build integrity | lint/typecheck/build/styles green; no test artefacts or credentials in output | PASS |
| 3 | Component matrix | 52/52 | PASS |
| 4 | Application accessibility | 177 measurements, 0 findings | PASS |
| 5 | Responsive | 0 overflow at 320/390/RTL | PASS |
| 6 | Keyboard & focus | 12/12 contracts | PASS |
| 7 | Overlays | menus non-modal, dialogues `aria-modal` | PASS |
| 8 | Authentication | limiter intact; no bypass; 401 anonymous under production config | PASS |
| 9 | Authorization / RBAC | refusals proven at the API | PASS |
| 10 | Tenant isolation | RLS forced 77/79; cross-tenant refusals | PASS |
| 11 | Data integrity | four catches classified, none hides a write | PASS |
| 12 | Audit / security logging | append-only trigger; redaction at the logger | PASS |
| 13 | Migrations | clean-database migration → 79 tables, suite green | PASS |
| 14 | Recovery / DR | 19/19, destination empty → restored | PASS |
| 15 | Fixture safety | `e2e*` → 0, `real-customer` survives | PASS |
| 16 | **Branch protection** | `protected: false` both repos; 403 by permission and by proxy; no rulesets | **ADMINISTRATIVE** |
| 17 | Merge enforcement proof | cannot exist until 16 | **N/A** |
| 18 | CI completeness | 7 jobs, none allowed to fail, all run on PR head | PASS |
| 19 | E2E login budget | 7 / 8 / 4 against 10 per 300s | PASS |
| 20 | Visual | 107/107 in the canonical CI environment | PASS |
| 21 | **Deployment** | no daemon, no target; not simulated | **ENVIRONMENTAL** |
| 22 | **Post-deployment smoke** | depends on 21 | **ENVIRONMENTAL** |
| 23 | **Rollback** | depends on 21 | **ENVIRONMENTAL** |
| 24 | Observability | probes now at the documented paths (§9); redaction; token-guarded metrics | PASS |
| 25 | Operations | runbooks name real commands; **the health-probe paths they name now exist** | PASS |
| — | Stray branch | deletion refused by proxy | **ADMINISTRATIVE** |

**21 PASS · 1 N/A · 2 ADMINISTRATIVE · 3 ENVIRONMENTAL · 0 FAIL.**

## 20. Remaining limitations

Unchanged from Phase 9 §23–§26: the Radix portal wrapper, `doc-kit` (unshipped), the `/documents`
landmark pair, ContextMenu's unused sub-parts; CI runner variance; the Cloudflare Storybook check;
and the post-launch list. None was touched.

## 21. Administrative actions required

1. **Protect `main` on `munaxa/munaxa-docs`** — require the seven checks in §4, require a pull
   request, forbid force-push and deletion.
2. **Protect `main` on `munaxa/munaxa-platform`** — require its three checks.
3. **Prove enforcement** — open a throwaway PR, confirm it is unmergeable while a required check is
   pending or red, and mergeable only when all are green.
4. **Delete `claude/phase-9-certification`** (`08b7c653`).
5. **Provide a production-equivalent environment** — a container runtime and a target — so Gates
   21–23 can be executed.

Items 1–4 need a repository administrator. Item 5 needs infrastructure.

## 22. Corrections

Previous reports are not edited.

**Phase 9 recorded Gate 25 (Operations) as "PASS with a caveat".** The caveat was that deployment,
rollback and staging-smoke steps were undocumented-by-execution. It was too generous in one specific
way: the runbooks did not merely describe untested steps, they described **health-probe URLs that did
not exist**. Phase 9 read those documents and checked that they named real commands; it did not probe
the endpoints. Phase 9.1 did, and found three documents wrong about the same fact — or rather, the
code wrong and the documents right. Gate 25 passes now because the code was changed to match them.

**A note on this session's own error, repeated so it is not lost.** The stray branch
`claude/phase-9-certification` was created against a standing instruction. It could not be deleted
here and is listed as an administrative action rather than left unmentioned.

## 23. Final production decision

# PHASE 9.1 — NOT PRODUCTION READY

**MUNAXA DOCS IS NOT PRODUCTION READY.**

| # | Blocker | Evidence | Owner | Code / Admin / Infra |
| --- | --- | --- | --- | --- |
| 1 | `main` unprotected on both repositories | `protected: false`; 403 by permission **and** by proxy; rulesets empty | repository administrator | **administrative** |
| 2 | Deployment unproven | no container runtime, no target | infrastructure | **infrastructure** |
| 3 | Post-deployment smoke unproven | depends on 2 | release engineering | **infrastructure** |
| 4 | Rollback unproven | depends on 2 | release engineering | **infrastructure** |
| 5 | Stray branch `claude/phase-9-certification` | deletion refused | repository administrator | **administrative** |

None is a defect in Munaxa Docs' code. The one code defect this phase found — health probes 404 at
every path the runbooks poll — was fixed at the owning layer, guarded, and verified green in CI.

That defect is the argument for this phase. It survived eight audit phases, a full certification
sweep, 161 end-to-end tests and seven CI jobs, and was found in the first minute of doing the one
thing nobody had done: starting the shipped artefact in production mode and asking it for the URL the
runbook says to poll. **Deployment configured is not deployment verified** — and until Gates 21–23
are executed against a real environment, the same class of defect may still be waiting.
