# Phase 9.2 — Production Environment & Enforcement Closure

## 1. Objective

Close what Phase 9 and Phase 9.1 left open: prove a deployment by deploying, prove a rollback by
rolling back, and prove enforcement by enforcing it. Everything below that is described as measured
was measured against running containers on this machine. Nothing in this report is simulated,
inferred from source, or reconstructed from a build log.

The phase found **five defects**. Three are code, two are the runbook. Every one of them was
invisible to a gate that was passing, and every one was found the same way: by running the thing
instead of reading it.

## 2. Starting certified state

Phase 9.1 ended at `c0a551b` with CI green, the health probes moved to the paths every runbook
polls, and four blockers open: branch protection on both repositories, a real deployment, a real
rollback, and a stray branch that could not be deleted.

Phase 9.2 began by building the three images from `78c6a59` and standing the product up.

## 3. The deployment target

There is no cloud deployment target attached to this session and none was invented. What exists is a
Docker daemon on this host, and that is what was used:

| Component | Image / container | Notes |
| --- | --- | --- |
| PostgreSQL 16 | `postgres:16-alpine` → `prod-postgres` | two tenant databases, cluster roles `edms_owner` / `edms_app` |
| Redis 7 | `redis:7-alpine` → `prod-redis` | |
| API | `munaxa-docs-api` → `prod-api` | published on `13001` |
| Web | `munaxa-docs-web` → `prod-web` | published on `13000` |
| Worker | `munaxa-docs-worker` → `prod-worker` | see §8 |

**This is not a production environment and is not claimed to be one.** It is a real deployment of
the real images against a real database, which is the property every finding below depends on, and
it is exactly the step that had never been taken before. A hosted environment would additionally
exercise TLS termination, a load balancer, DNS and secret management, none of which are tested here.

## 4. Building the images, and what it took

The images build from `Dockerfile` unchanged, but not with the command `deployment.md` prints — this
host's egress goes through an authenticating agent proxy, and three separate failures had to be
worked through before a build completed: corepack could not reach npmjs without `--network=host`,
apt failed `405` because the proxy rejects plain HTTP, and corepack failed again because
`registry.npmjs.org` sits in the inherited `noProxy`. The working invocation:

```bash
docker build --network=host \
  --build-arg HTTPS_PROXY="$HTTPS_PROXY" \
  --build-arg NO_PROXY="localhost,127.0.0.1" \
  --target <api|web|worker> \
  --secret id=npmrc,src="$HOME/.npmrc" \
  -t "munaxa-docs-<target>:<sha>" .
```

Those three arguments are properties of *this host*, not of the product, and are recorded so the
next person does not rediscover them. `deployment.md` is correct for a normal network.

## 5. Defect 1 — the query engine the image ships is not the one it needs

**Severity: release-blocking. The product could not authenticate a single user.**

Measured, on the deployed container:

```
readiness  → HTTP 200, {"status":"DOWN", "database:e2e4f45e82f25":"DOWN",
                        "database:e2ed938be1a87":"DOWN", "cache":"UP"}
login      → HTTP 500
log        → Prisma Client could not locate the Query Engine for runtime "debian-openssl-3.0.x".
             This happened because Prisma Client was generated for "debian-openssl-1.1.x".
```

Root cause, measured rather than guessed:

```
node:22-bookworm-slim (the build stage): 0 libssl files, no openssl binary
munaxa-docs-api image (runtime stage):   libssl.so.3, OpenSSL 3.0.20
engine actually shipped:                 libquery_engine-debian-openssl-1.1.x.so.node
prisma/schema.prisma:                    no binaryTargets
```

Prisma chooses an engine by detecting libssl **at generate time**. The build stage has no libssl to
detect, so it falls back to 1.1.x. The runtime stage installs `ca-certificates`, which brings
OpenSSL 3, so the deployed process asks for an engine the image does not contain. Every database
call fails.

**The Dockerfile predicted this in a comment** — "the OpenSSL version a Prisma binary is compiled
against is the classic source of a container that builds and cannot connect" — and nothing asserted
it. That is the whole lesson of this phase in one line.

**Owner:** `prisma/schema.prisma`. The schema is where this product declares which engines it ships,
and leaving it to detection is what failed.

**Fix:** `binaryTargets = ["native", "debian-openssl-3.0.x"]`. `native` stays first so a developer's
own machine still gets its own engine.

Installing `openssl` in the build stage was the alternative and is worse: it fixes today's detection
and leaves the next base-image change free to break it again, silently, in exactly the same way.

**Guard:** the `images` CI job previously asserted only that the images build. It now loads the API
image and asks it the question the deployment asks — *which engine does your runtime require, and do
you carry it?* No database and no network needed.

```
against munaxa-docs-api:78c6a59  → FAIL, "no libquery_engine-debian-openssl-3.0.x.so.node"   exit 1
against munaxa-docs-api:478a7d8  → OK                                                        exit 0
```

The worker image carried the identical defect and is fixed by the same schema change (verified
independently: `FAIL` at `78c6a59`, `OK` at `478a7d8`).

## 6. Defect 2 — readiness answered 200 while its own body said DOWN

**Severity: release-blocking. It is the defect that would have let defect 1 into production.**

Measured on the deployed container, before the fix:

```
GET /api/health/ready → HTTP 200
body                  → {"status":"DOWN", …two databases DOWN…}
```

`deployment.md` gates a release on "`/api/health/ready` green on every instance before the load
balancer is opened". A load balancer does not read JSON; it reads the status line. The probe
returned 200 whatever it found, so the gate could not distinguish a healthy instance from one that
could not reach a single database — and a release engineer following the runbook to the letter would
have opened the load balancer onto the completely broken deployment described in §5.

**Owner:** `HealthController.ready`. `live()` had an explicit `@HttpCode(HttpStatus.OK)`; `ready()`
had no status mapping at all and took Nest's default.

**Fix:** 503 when the report is `DOWN`, 200 otherwise.

`DEGRADED` deliberately stays 200. It means nothing is down and something is slow, and pulling every
instance from rotation for it empties the pool during a degradation — the same argument liveness
already makes for not touching dependencies.

The code is set on the response rather than thrown, because `AllExceptionsFilter` converts every
throw to `application/problem+json` and would replace the dependency list with a generic detail
string. The orchestrator needs the status line and the operator needs to know *which* dependency;
this is the only shape that gives both.

**Proof, on the deployed stack, by taking a real dependency down:**

| Action | `/api/health/ready` | `/api/health/live` |
| --- | --- | --- |
| steady state | **200**, `UP` | 200 |
| `docker stop prod-postgres` | **503**, `DOWN`, both databases named | **200** |
| `docker start prod-postgres` | **200**, `UP` | 200 |

Liveness holding at 200 throughout is the property the design argues for, now observed rather than
asserted: a database outage must not restart every pod.

## 7. Defect 3 — every refusal was logged and metered as a server error

**Severity: high. An alerting defect, not a cosmetic one.**

Found while investigating §5: a login attempt answered `401` on the wire, and the access log for the
*same request* recorded `"status":500`. Reproduced deliberately with a wrong password.

**Root cause:** `RequestObservabilityInterceptor.statusOf` was `error instanceof HttpException ?
error.getStatus() : 500`. Almost nothing in this product throws an `HttpException` — refusals are
`DomainError`s, which `AllExceptionsFilter` maps through `STATUS_BY_CODE`. So `UNAUTHENTICATED`,
`FORBIDDEN`, `NOT_FOUND`, `VALIDATION_FAILED`, `RATE_LIMITED` and every other domain code were all
recorded as 500.

The log line is the smaller half. `statusClass()` reads the same number, so **the `5xx` class of
`HTTP_REQUEST_DURATION` counted every refusal in the product** — and 17 §9 alerts on the
server-error rate. On these numbers a user mistyping a password pages an on-call, and a genuine 5xx
is invisible in the noise it creates.

**Owner:** the interceptor. **Fix:** it now imports `STATUS_BY_CODE` from the filter rather than
keeping a second copy. A copy would have fixed today's drift and guaranteed tomorrow's.

**Proof, on the deployed stack:** a wrong-password login answers 401 and the access log for that
request now reads `logged status 401`.

## 8. Defects 4 and 5 — two release steps that cannot be performed as written

Both were found by following `deployment.md` literally, and both are documentation defects. Neither
is fixed by changing code, and changing code for either would be the scope expansion this phase was
told not to make.

**Step 2 cannot run inside an image.** `scripts/migrate-tenants.mjs` shells out to `pnpm exec
prisma`; the runtime images carry neither pnpm nor the Prisma CLI, and running it inside one fails
with `spawnSync pnpm ENOENT`. The migration was therefore run from the host checkout — what a
release engineer with a working copy would do — and the runbook now says that is what it is.

**Step 3 tells the operator to deploy a container that exits immediately.** `prod-worker` started,
printed `Worker started. Queues: 13, scheduled jobs: 13. Consumers run in the API process, by
configuration.` and **exited 0**. That is by design: every consumer runs in the API process gated on
`QUEUE_CONSUMERS_ENABLED`, and `apps/worker/src/main.ts` is a seam for the day that changes. But
`deployment.md` says "workers first: they drain", and an orchestrator expecting a long-running
container reads a clean immediate exit as a crash loop. The runbook now describes the process that
exists.

The readiness line of the release checklist was also corrected, since §6 changed what it means.

## 9. Change control

Five defects, five smallest-possible fixes, each at the layer that owns the decision:

| Defect | Owner | Change |
| --- | --- | --- |
| 1 · query engine | `prisma/schema.prisma` | one `binaryTargets` line |
| 2 · readiness code | `health.controller.ts` | status set from the report |
| 3 · refusal status | `request-observability.interceptor.ts` | share `STATUS_BY_CODE` |
| 4 · migration runner | `docs/operations/deployment.md` | describe where it runs |
| 5 · worker step | `docs/operations/deployment.md` | describe what it does |

No authentication was weakened, no rate limit disabled, no test bypass added, no RLS relaxed, no
audit trigger touched, no timeout increased, no wall-clock budget changed, and no Arabic visual
baseline regenerated. The platform package was not republished: nothing in `@munaxa/platform`
changed, and publishing a no-op version to have something to point at is the thing this programme
has repeatedly refused to do.

## 10. Revert proof

Each fix has a guard that fails without it, with the symptom that was measured in the deployment:

| Fix reverted | Guard | Failure |
| --- | --- | --- |
| readiness status | `health.controller.spec.ts` | `expected 500 to be … − 503 / + 200` — the deployment's exact symptom |
| refusal status | `request-observability.interceptor.spec.ts` | 5 of 7 red: `expected 500 to be 401 / 403 / 404 / 422 / 429` |
| `binaryTargets` | the CI image check | `FAIL — no libquery_engine-debian-openssl-3.0.x.so.node` |

In every case the fix was restored immediately and the guard returned green. The two tests that stay
green under revert are deliberate: an `HttpException` still reports its own status, and an
unrecognised failure is still a 500 — the fix must not trade one blind spot for another.

## 11. Deployed smoke — authentication, authorisation, tenant isolation, audit

Run against the deployed containers over the published port, with real fixture identities in two
tenants. **10 of 10 passed.**

| Check | Expected | Actual |
| --- | --- | --- |
| anonymous cannot list documents | 401 | 401 |
| a signed-in user can list documents | 200 | 200 |
| reader may read its own document | 200 | 200 |
| reader is refused the signing statement | 403 | 403 |
| signer is granted the signing statement | 200 | 200 |
| acme cannot read the neighbour's document | 404 | 404 |
| the neighbour cannot read acme's document | 404 | 404 |
| a neighbour token cannot reach acme by id | 404 | 404 |
| the audit trail is readable | 200 | 200 |
| the audit trail is not empty | > 0 | 7, then 11 |

Tenant isolation is asserted in **both directions**, and the audit count rising between the two runs
is the trail recording the reads the smoke suite itself performed.

Below the API, in the deployed database:

- **77 of 77** business tables have row-level security both **enabled and forced**.
- With `app.tenant_id` set correctly, `document` returns **3** rows; set to a foreign tenant id, the
  same query on the same connection returns **0**.
- `UPDATE audit_event` → `ERROR: audit_event is append-only: UPDATE is not permitted`.
- `DELETE FROM audit_event` → `ERROR: audit_event is append-only: DELETE is not permitted`.

Both refusals were produced as the table **owner**, which is the case that matters — the guarantee
does not depend on the application connecting as a restricted role.

The web tier serves `/login` at 200 and redirects `/` at 307 against the deployed API.

## 12. Rollback — executed, not described

A real image swap in both directions, timed, on the running deployment.

| Step | Result |
| --- | --- |
| roll back `478a7d8` → `78c6a59` | liveness answering in **2 s**; `docker inspect` confirms `munaxa-docs-api:78c6a59` |
| behaviour of the rolled-back version | readiness **200** with body `DOWN`; login **500** |
| roll forward `78c6a59` → `478a7d8` | readiness **200 / UP** in **2 s** |
| smoke after the round trip | **10 / 10** |

No schema rollback was required, and that is not luck: `git diff 78c6a59 478a7d8 -- prisma/migrations`
is **0 files**, which is the expand-only rule doing its job.

The rolled-back version's behaviour is worth stating plainly rather than glossing: **the previous
image is not a viable rollback target.** It cannot reach a database. Phase 9.2 is the first time any
image of this product has run, so there is no earlier known-good version to fall back to, and the
drill proves the *mechanism* — swap, verify, swap back, re-verify — rather than the existence of a
safe harbour. The first deployment of `478a7d8` establishes that harbour; from the next release
onward, the drill and the target coincide.

It also demonstrates the point of §6 from the other side: the broken version answered `200` on
readiness, so the release gate as written would have admitted it.

## 13. Enforcement — still blocked, and not by anything this session can do

Measured earlier in this phase and unchanged:

- `protected: false` on the default branch of **both** repositories.
- `GET` and `PUT` on the branch-protection API → **403**.
- `POST` to the rulesets API → **403**, "Write access … not permitted through this proxy".
- Repository permissions for this session: `admin: false`.
- The GitHub MCP surface available here exposes no branch-protection tool.
- The sole administrator is `tam2om`.

No proxy workaround was attempted and the identical unauthorised call was not retried. **Branch
protection cannot be claimed and is not claimed.** The stray branch `claude/phase-9-certification`
(`08b7c65`) also cannot be deleted — 403 — and remains; its one commit was already cherry-picked
onto the designated branch, so it carries nothing unique.

## 14. Final regression

| Suite | Result |
| --- | --- |
| API unit | **659 passed**, 1 skipped, 57 files |
| Workspace `typecheck` + `lint` + `test` (turbo) | **27 / 27 tasks** |
| Format check | clean (see §17) |
| Integration · real PostgreSQL, two tenants | **green** in CI |
| E2E · recovery and the data grid | **green** in CI |
| E2E · signing, faded text, search / the screens | see §17 |
| Product isolation | **green** in CI |
| Deployed smoke | **10 / 10**, twice |

The two new specs add 10 tests (3 readiness, 7 interceptor).

## 15. Corrections to the record

**A 401 I reported as a defect was my own error.** Mid-investigation I recorded that login returned
401 with correct credentials after the engine fix. It did — because I was passing the tenant as an
`x-tenant-slug` header, and this API takes it in the request body. With the correct call the same
credentials return 200. The genuine pre-fix symptom is **500**, confirmed again during the rollback
drill in §12. No product change followed from the mistaken reading.

**Phase 9.1's report described the health-probe fix as verified against a production-mode boot.**
That was accurate as far as it went; Phase 9.2 verified the same fix inside a deployed container —
`/api/health/live`, `/api/health/ready` and `/api/health` all 200, `/api/v1/health/ready` 404 — which
is the stronger evidence, obtained here for the first time.

Nothing in an earlier report has been rewritten.

## 16. What this phase did not prove

- **Branch protection and merge enforcement.** Blocked administratively (§13).
- **A hosted production environment.** TLS termination, a load balancer, DNS, managed secrets and
  multi-instance rolling replacement are untested; this was one host with Docker.
- **A rollback to a known-good previous version** (§12) — the mechanism is proven, the safe harbour
  begins with this release.
- **Load and capacity.** `infra/loadtest/run.mjs` has still never recorded a baseline.
- **Backup restore within the quarter.** Not exercised here.

## 17. Final status

CI run **232** on `471be82`, the last code-bearing commit of this phase. **All seven jobs green on
the first attempt** — no re-run, no retry, nothing disclosed as flaky.

| Job | Result |
| --- | --- |
| Lint · Typecheck · Test · Build (incl. format, platform stylesheet, contrast and visual regression) | **success** |
| Integration · real PostgreSQL, two tenants | **success** |
| End-to-end · signing, faded text and search | **success** |
| End-to-end · recovery and the data grid | **success** |
| End-to-end · the screens | **success** |
| Container images · three targets from one commit | **success** |
| └ *The API image carries the query engine its own runtime asks for* | **success** — the new gate, passing on the fix and failing on the commit before it |
| Product isolation | **success** |

The report commit on top of it is Markdown only, and the workflow's `paths-ignore: '**/*.md'` means
it correctly fires no run. `471be82` is the commit this certification is about.

### Cleanup

Every container, the `munaxa-prod` network, the `prod-storage` volume and the seeded smoke tenants
were removed after the evidence was collected. The smoke fixture file, its credentials and the
scratch scripts were deleted. Six local image tags remain on this host as build artefacts; they were
never pushed to a registry, because choosing a registry is a deployment decision this repository has
not made.

## 18. Blockers

| # | Blocker | State |
| --- | --- | --- |
| 1 | Deployment proven by deploying | **CLOSED** — §5–§11 |
| 2 | Rollback proven by rolling back | **CLOSED as to mechanism** — §12; no known-good previous target existed, and this release creates one |
| 3 | Branch protection on both repositories | **OPEN** — administratively blocked, §13 |
| 4 | Stray branch `claude/phase-9-certification` deleted | **OPEN** — 403, carries nothing unique, §13 |

## 19. Administrative actions required

Only `tam2om` can perform these; nothing in this session can, and no further unauthorised attempt
was made after the state was established.

1. Enable branch protection on `main` in **`munaxa/munaxa-docs`** and **`munaxa/munaxa-platform`**:
   require a pull request, require the CI checks named in §17, and forbid direct pushes.
2. Delete the branch `claude/phase-9-certification` (`08b7c65`) in `munaxa/munaxa-docs`.

Until (1) is done, "every gate is blocking" is a convention this repository follows rather than a
rule it enforces, and a single direct push to `main` can bypass every check in §17.

## 20. Final decision

# NOT PRODUCTION READY

The product is now materially closer than it has ever been, and the reason for the answer is narrow
and specific rather than a general lack of confidence.

**What changed in this phase's favour.** The images had never been run. Running them found a defect
that made the product completely non-functional — no user could sign in — and a second defect that
would have let the first one past the release gate unnoticed. Both are fixed, both are guarded, and
both fixes were verified on a running deployment rather than argued from source. Authentication,
authorisation, tenant isolation in both directions, audit immutability and row-level security were
all exercised against real containers and a real database. Rollback was executed rather than
described.

**Why the answer is still no.** Phase 9 set the rule that this phase is bound by: *do not call it
ready if branch protection is absent.* It is absent, on both repositories, and this session cannot
add it. That is not a technicality. Every guarantee in §17 rests on checks that nothing currently
requires anybody to pass, and the defect in §5 is a live demonstration of what an unenforced gate is
worth — the `images` job existed for phases and asserted the one property that could not catch it.

There is no "ready except". The single action in §19(1) is what stands between this state and a
different answer, and it takes an administrator a few minutes.

## 21. Recommended next phase

**Phase 9.3 — Enforcement and first hosted deployment.** Two items, in this order:

1. Branch protection enabled by the administrator and then *proven* — an attempted direct push to
   `main` that is refused, and a pull request that cannot merge with a red check. Claimed only when
   the refusal has been observed.
2. A hosted deployment of `471be82` or later: TLS termination, a load balancer polling the readiness
   probe that now means something, DNS, managed secrets, and a multi-instance rolling replacement.
   §12's rollback drill repeated against it, this time with a known-good previous version.

`infra/loadtest/run.mjs` still has no baseline and the quarterly restore test has not been
exercised. Both are real gaps and neither blocks §19(1), which is why they follow rather than lead.
