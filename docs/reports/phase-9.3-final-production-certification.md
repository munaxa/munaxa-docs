# Phase 9.3 — Final Administrative Enforcement & Production Certification

## 1. Starting state

| | |
| --- | --- |
| Docs HEAD | `e56c6f4` — the Phase 9.2 closure report |
| Docs last code-bearing commit | `471be82` — CI run 232, all seven jobs green, first attempt |
| Docs branch | `claude/sidebar-nav-contrast-fix-nhpu3b` |
| Platform HEAD | `61810a6` |
| Platform package | `@munaxa/platform@1.5.1` — **unchanged, and no release was cut** |
| Docs `main` | `1f0c8d6`, `protected: false` |
| Platform `main` | `72009f2`, `protected: false` |

No product code was modified in this phase. No Platform version was published. The engineering and
operational certification established in Phase 9.2 is carried forward unchanged and unre-run: nothing
in this phase changed anything that evidence depends on.

## 2. Repository permissions — the precise finding

This is where the phase's answer comes from, and the shape of it is more specific than "no admin
access".

**The authenticated identity is `tam2om`** — the account that owns both repositories. That identity
is not the constraint. The constraint is that this session acts through a **GitHub App
installation**, and the API refuses on two independent layers:

| Call | Result | Refused by |
| --- | --- | --- |
| `GET /repos/munaxa/munaxa-docs/branches/main/protection` | **403** `Resource not accessible by integration` | **GitHub** — the App installation has no `administration` permission |
| `GET /repos/munaxa/munaxa-platform/branches/main/protection` | **403** `Resource not accessible by integration` | **GitHub**, same |
| `GET /repos/munaxa/munaxa-docs/rulesets` | **200**, `[]` | — readable |
| `POST /repos/munaxa/munaxa-docs/rulesets` | **403** `Write access to this GitHub API path is not permitted through this proxy` | **the agent proxy**, before the request reaches GitHub |
| `GET /repos/munaxa/munaxa-docs` → `permissions` | `{admin: false, maintain: false, push: false, triage: false, pull: false}` | — |
| `git push origin --delete claude/phase-9-certification` | **403** over the git transport | the git proxy |

Two different systems refuse for two different reasons, and neither is a retry-able condition. The
branch-protection endpoints are outside the App's granted permission set, so no number of attempts
changes the answer; the rulesets write is blocked upstream of GitHub entirely, so the App's
permissions are not even consulted. Exactly one attempt was made against each surface. No workaround
was attempted, and none should be.

The MCP GitHub tool surface available to this session was searched and exposes **no**
branch-protection or ruleset tool — `create_branch`, `create_repository`, `fork_repository` and
`list_repository_collaborators` are the nearest matches, and none of them configures protection.

## 3. Branch protection configuration

**Not configured. Not configurable from this session.** Both default branches remain
`protected: false`, and the docs repository's ruleset list is empty (`[]`).

The ruleset that *would* have been applied was written and is recorded here so the administrator can
apply the equivalent without re-deriving it: target the default branch, enforcement `active`, with
four rules — `deletion`, `non_fast_forward`, `pull_request`, and `required_status_checks` with
`strict_required_status_checks_policy: true` and the seven contexts in §4.

Nothing about it is claimed to be in force. It is a specification, not a state.

## 4. Required checks — the exact context strings

Read from the check-runs GitHub actually recorded on `471be82`, not from the workflow file, because
the required-check context is the check-run name and a workflow rename would silently orphan a
required check.

**`munaxa/munaxa-docs`** — all seven, all `success`, app `github-actions`:

```
Lint · Typecheck · Test · Build
Integration · real PostgreSQL, two tenants
End-to-end · signing, faded text and search
End-to-end · recovery and the data grid
End-to-end · the screens
Container images · three targets from one commit
Product isolation
```

The separator is U+00B7 MIDDLE DOT with a space either side. It must be copied exactly.

**`munaxa/munaxa-platform`** — three certification checks on `61810a6`, all `success`:

```
Lint · Typecheck · Test · Build
Accessibility · contrast and keyboard, every story, four brands, light and dark
Façades match the platform surface
```

Two checks on the platform's head are deliberately **excluded** from that list:

- `Publish @munaxa/* to GitHub Packages` — a release job, not a merge gate. Requiring it would make
  every merge wait on a publish.
- `Workers Builds: platform-storybook` — a **Cloudflare Workers** preview build, and it is currently
  **failing** on the platform's head (build `c727023f`, app `cloudflare-workers-and-pages`). It is a
  third-party preview deployment rather than a certification check, it is not produced by
  `ci.yml`, and requiring it would couple every platform merge to Cloudflare's availability. It is
  flagged here so it is not swept into the required set by accident, and separately because a red
  check sitting on a default branch is worth somebody's attention on its own terms.

## 5. Merge enforcement proof

**None. Not attempted, and deliberately so.**

Proving enforcement means demonstrating that a maintainer *cannot* merge a pull request while a
required check is failing. With no protection configured, any such demonstration would prove the
opposite of what certification requires, and a passing-looking narrative built on an unprotected
branch is exactly the fabricated evidence this programme has refused throughout.

No test pull request was opened. Opening one would demonstrate that a PR can be created, which is
not in question, and would leave a branch behind for the administrator to clean up.

**This is the missing link in the chain, and it is the whole of the phase's answer.**

## 6. Stray branch cleanup

`claude/phase-9-certification` (`08b7c65`) still exists. Deletion returned **403** over the git
transport — one attempt, not retried.

Before attempting it, the branch was confirmed to carry nothing unique: `git cherry HEAD
origin/claude/phase-9-certification` prefixes its single commit with `-`, meaning a patch-equivalent
commit is already on the designated branch. Deleting it loses nothing; leaving it costs nothing but
tidiness.

Classification: **ADMINISTRATIVE CLEANUP.** Not a production-code blocker, and not a factor in §15.

## 7. Existing production deployment evidence

Carried from Phase 9.2, unchanged and not re-run.

The three images were built from one commit and **actually executed** against a real PostgreSQL 16
and Redis 7, with two tenant databases migrated by the real runner. Running them is what exposed the
five defects Phase 9.2 fixed — a Prisma engine mismatch that made every database call fail, a
readiness probe that answered 200 while reporting DOWN, domain refusals metered as 5xx, and two
runbook steps that could not be performed as written.

Health, measured on the deployed container:

```
/api/health/live    200        /api/health          200
/api/health/ready   200        /api/v1/health/ready 404   (the Phase 9.1 path fix, in a real deployment)
```

Readiness under a real dependency outage — postgres stopped, then restarted:

```
running   → 200 UP        stopped → 503 DOWN, both databases named        restored → 200 UP
liveness  → 200 throughout
```

## 8. Existing smoke evidence

Deployed smoke **10/10**, run twice — before and after the rollback round trip.

Authentication (anonymous refused 401, session accepted 200), RBAC (reader refused the signing
statement 403, signer granted 200), tenant isolation **in both directions** (404 each way, plus a
neighbour token refused against an acme document by id), and audit readable and non-empty — the
count rising 7 → 11 between runs, which is the trail recording the smoke suite's own reads.

Below the API, in the deployed database:

```
RLS                77/77 tables enabled AND forced
tenant scoping     app.tenant_id correct → 3 document rows;  foreign → 0
audit UPDATE       refused: "audit_event is append-only: UPDATE is not permitted"
audit DELETE       refused: "audit_event is append-only: DELETE is not permitted"
```

Both audit refusals were produced **as the table owner**, which is the case that matters: the
guarantee does not depend on connecting as a restricted role.

## 9. Existing rollback evidence

Executed, both directions, on the running deployment:

```
478a7d8 → 78c6a59    liveness answering in ~2 s, image confirmed by docker inspect
78c6a59 behaviour     readiness 200 with body DOWN; login 500   (the pre-fix state, reproduced)
78c6a59 → 478a7d8    readiness 200 / UP in ~2 s
smoke after           10/10
migrations between    0 files
```

The honest limit, restated rather than smoothed over: `78c6a59` cannot reach a database, so it is
not a viable rollback *target*. The drill proves the **mechanism**. `471be82` is the first version
of this product that has ever run, and it is therefore the first safe harbour; from the next release
onward the drill and the target coincide.

## 10. Final CI state

**Docs** — run 232 on `471be82`, all seven jobs `success`, first attempt, no re-run and nothing
disclosed as flaky. Commits after it are Markdown only, and `paths-ignore: '**/*.md'` correctly
fires no run.

**Platform** — on `61810a6`, the three `ci.yml` certification jobs are `success` and the publish job
is `success`. The Cloudflare preview build is `failure` (§4). No Platform change was made and no
release was cut, so the version stands at `1.5.1`.

## 11. Final certification matrix

| Dimension | State | Enforced? |
| --- | --- | --- |
| Component matrix 52/52 | PASS | not enforced |
| Application · 177 measurements, 0 findings | PASS | not enforced |
| Responsive · 0 overflow | PASS | not enforced |
| Overlays · 12/12 focus contracts | PASS | not enforced |
| E2E 161/161 | PASS | not enforced |
| Recovery 19/19 | PASS | not enforced |
| Fixture tenants · 0 | PASS | not enforced |
| Visual 107/107 canonical CI | PASS | not enforced |
| Tenant isolation · both directions | PASS | not enforced |
| RLS 77/77 enabled and forced | PASS | not enforced |
| Health · live / ready proven | PASS | not enforced |
| Deployment · executed | PASS | not enforced |
| Smoke 10/10 | PASS | not enforced |
| Rollback · both directions | PASS (mechanism) | not enforced |
| CI · seven jobs green | PASS | **not enforced** |
| **Merge enforcement** | **ABSENT** | **—** |

The right-hand column is the point. Every row above the last is a genuine measurement, and every one
of them currently rests on checks that nothing obliges anybody to pass.

## 12. Remaining limitations

1. **Merge enforcement absent on both default branches.** The only certification blocker.
2. **No hosted production environment.** Phase 9.2 deployed to a Docker daemon on one host. TLS
   termination, a load balancer polling the readiness probe, DNS, managed secrets and multi-instance
   rolling replacement remain untested.
3. **No known-good previous version to roll back to** — created by this release, not before it.
4. **No load baseline.** `infra/loadtest/run.mjs` has still never recorded one.
5. **Quarterly restore test not exercised** in this programme.
6. **A red Cloudflare preview build on the platform's default branch** (§4) — outside the
   certification set, but unexplained.
7. **`claude/phase-9-certification` still present** — cosmetic (§6).

## 13. Administrative actions required

Only a repository administrator acting **outside this session** can do these. Items 1–3 are the
certification blocker; item 4 is cleanup.

1. **Protect `main` on `munaxa/munaxa-docs`** — require a pull request, require the seven contexts in
   §4 verbatim, require the branch to be up to date, forbid direct pushes, forbid force pushes,
   forbid deletion.
2. **Protect `main` on `munaxa/munaxa-platform`** — the same, with the three contexts in §4.
3. **Prove it**, rather than stopping at `protected: true`: open a harmless pull request and confirm
   that it cannot be merged while a required check is pending or failing, and can be merged once all
   are green. Do not bypass the protection to demonstrate it.
4. Delete the branch `claude/phase-9-certification` in `munaxa/munaxa-docs`.

If instead the intent is for a future session to perform this, the change is to the **GitHub App
installation**: grant it `administration: write` on both repositories, and permit writes to the
rulesets path at the proxy. Both layers must change; granting one leaves the other refusing.

## 14. Corrections

**The commit roles in the Phase 9.3 brief are transposed.** It lists `478a7d8` as the latest
engineering fix and `78c6a59` as the Phase 9.2 closure report. `78c6a59` is the **pre-fix** commit —
the one carrying the broken Prisma engine, used in Phase 9.2 as the rollback target and as the
negative case for the new CI gate. The actual commits are: engineering fix `478a7d8`, formatting
`471be82` (the last code-bearing commit and the one CI certified), closure report `26649bf`, and
decision `e56c6f4`. Nothing followed from the transposition; it is recorded so the chain of custody
stays accurate.

**"Repository admin access is required" is true but imprecise.** The account identity in this
session *is* the repository owner, `tam2om`. What lacks administrative rights is the GitHub App
installation the session acts through, and a second, independent block sits at the agent proxy
(§2). Anyone reading "admin access required" as "log in as the owner" would try it and still be
refused.

**Phase 9.2 recorded repository permissions as `admin: false` without distinguishing the layers.**
That reading was correct as far as it went; §2 supersedes it with the mechanism.

Nothing in Phase 9.2 has been rewritten.

## 15. Final decision

# PHASE 9.3 — NOT PRODUCTION READY

## MUNAXA DOCS IS NOT PRODUCTION READY BECAUSE REQUIRED CI CHECKS ARE NOT ADMINISTRATIVELY ENFORCED.

The distinction is exact, and it is not a hedge:

```
application:     certified
deployment:      certified
rollback:        certified
CI:              passing
CI enforcement:  not configured
```

The product is not being called unsafe. It has been measured more thoroughly than most software
ships having been, it has been deployed and run rather than argued about, and the two defects that
would have made its first production release a failure were found and fixed by running it. The
engineering work is finished and the operational work is finished.

What is missing is governance. `main` on both repositories accepts a direct push today, and every
guarantee in §11 could be bypassed by one commit that never faced a single check. A certification
that says "these gates pass" without "and nothing may merge that fails them" is a description of one
moment, not a property of the repository.

Phase 9 set this rule before the evidence was in, and it holds now that the evidence is in: do not
call it ready if branch protection is absent. It is absent, this session cannot add it, and the four
actions in §13 are what close the last link:

```
CODE → TESTED → CI → DEPLOYED → SMOKE TESTED → ROLLED BACK → RESTORED → [ MERGE ENFORCEMENT ] → PRODUCTION READY
```

Everything to the left of the bracket is done. The bracket needs an administrator, not another
engineering phase.
