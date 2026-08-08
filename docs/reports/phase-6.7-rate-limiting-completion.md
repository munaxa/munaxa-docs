# Phase 6.7 — Rate Limiting Completion (Part A)

**Status: PARTIALLY COMPLETE**

Distributed rate limiting is implemented, bound and proven at the guard layer against real Redis
across two independent instances. One requirement of §17 is **not** met — the proof does not run
through the full HTTP pipeline via a booted Nest app — so `COMPLETE` would overstate it.

| Objective | Outcome |
| --- | --- |
| Existing `RATE_LIMIT_RULES` wired | ✅ |
| Redis is the authoritative shared state | ✅ `CachePort.increment` → `INCR` + `EXPIRE NX` |
| Two independent instances share one budget | ✅ proven |
| Tenant isolation | ✅ proven — and a real defect was found doing it |
| Signature limited to 5 / 15 min | ✅ |
| Credential routes fail closed on Redis failure | ✅ proven both ways |
| No enumeration introduced | ✅ keyed on the submitted address, never resolved |
| No process-local fallback | ✅ none exists |
| `@nestjs/throttler` removed | ✅ proven unused first |
| **End-to-end HTTP-pipeline test** | ❌ **not written** |

---

## 1. Call graph — before and after

```
before: request → Authentication → TenantIsolation → Rbac → Acl → handler
after:  request → RateLimit → Authentication → TenantIsolation → Rbac → Acl → handler
```

`RateLimitGuard` is registered as an `APP_GUARD` in `app.module.ts` **before** `AuthenticationGuard`,
deliberately: sign-in must be limited by address before an identity exists, and a limiter that only
ran for authenticated callers would leave the one endpoint credential stuffing actually targets
unprotected.

## 2. Coverage matrix

| Rule | Window / limit | Route | Guard | Redis | Test | Status |
| --- | --- | --- | --- | --- | --- | --- |
| `auth.login` | 300 s / 10, ip+identity | `POST /v1/auth/login` | ✅ | ✅ | ✅ | **ENFORCED** |
| `document.sign` | 900 s / 5, tenant+identity+revision+purpose | `POST /v1/documents/:id/signatures` | ✅ | ✅ | ✅ | **ENFORCED** |
| `search` | 60 s / 60, identity | `GET /v1/search` | ✅ | ✅ | ✅ (fail-open) | **ENFORCED** |
| `upload.presign` | 60 s / 120, identity+tenant | `POST /v1/uploads` | ✅ | ✅ | — | **ENFORCED** |
| `export` | 3 600 s / 10, identity+tenant | `GET /v1/audit/export`, `POST /v1/reporting/:id/run` | ✅ | ✅ | — | **ENFORCED** |
| `default` | 60 s / 300, identity | everything else | ✅ | ✅ | — | **ENFORCED** |
| `auth.password-reset` | 3 600 s / 5 | *none* | — | — | — | **UNUSED — ROUTE DOES NOT EXIST** |

`auth.password-reset` is retained, not deleted: there is no password-reset endpoint in the product
(`UserAdminService.setPassword` is an administrative act behind `user:manage`), and §1 says not to
create one to satisfy the catalogue.

## 3–5. CachePort, binding and distributed enforcement

The counter is `CachePort.increment(key, windowSeconds)`, which `RedisCacheAdapter` implements as
`INCR` plus `EXPIRE … NX` inside one `MULTI`. That gives three properties for free: the increment is
atomic *across connections*, so instances share a counter; `EXPIRE … NX` sets the window on first
touch without extending it later, so the window is fixed rather than sliding; and every key carries
a TTL, so cardinality is self-cleaning.

**There is no `Map`, no in-process counter and no local fallback anywhere in the guard.** That is the
property the two-instance test protects, and a process-local limiter would fail it.

## 6. Key design

`rl:{rule}[:t:{tenant}]:{dimension}:{value}` — and for `document.sign`, `:{revision}:{purpose}`.

**A defect was found here and fixed.** The first version namespaced only the `tenant` dimension, so
`rl:{rule}:identity:{user}` was a *global* bucket: two tenants whose identifiers ever coincided would
share it, and one customer could deny service to another. The tenant-isolation test caught it by
exhausting one tenant and finding the next refused. Every key produced under a known tenant is now
namespaced by it. An unauthenticated request has no tenant and is keyed without one, which is
correct — sign-in happens before a tenant is known.

Never in a key: password, TOTP code, access or refresh token, reset token, `Authorization` header,
or any raw credential. The signature key's extra dimensions — `revisionId` and `purpose` — are
ordinary request identifiers, and narrowing to them means a fumbled attestation does not spend the
budget for a different one.

## 7–8. Sensitive endpoints and the signature limit

`document.sign` is the one rule added, and it is added because Phase 6.6 established the requirement:
the endpoint accepts a password and a TOTP code and answers one undifferentiated refusal, which is
only a defence if the guesses are bounded. **5 attempts / 15 minutes**, keyed on tenant + signer +
revision + purpose, per the decision handed down with this phase. No conflicting signature policy
exists in the repository — checked before adding it.

## 9–10. Tenant isolation and enumeration

Isolation is proven: one tenant exhausts its budget, another with the same signer is still allowed.

Enumeration safety is structural. The login key is the **submitted** address, lower-cased and taken
verbatim — never resolved to an account first. Resolving it would make the response depend on
whether the account exists, which is the oracle the login design avoids. A real address and a
fictitious one are counted identically and refused identically, and the test asserts a limit is
reached using an address that certainly does not exist. **No account lockout and no per-account
throttling were added.**

## 11. Redis failure policy

Implemented as decided, and asserted in both directions:

| Route class | Behaviour when Redis is unreachable | Test |
| --- | --- | --- |
| Credential-sensitive (`auth.login`, `document.sign`) | **Refused** — `429`, no infrastructure detail | ✅ |
| Everything else | **Allowed** — availability preserved | ✅ |

The refusal carries `retryAfterSeconds` and a generic message; the reason is logged for an operator
and never returned. The test asserts the message mentions no Redis, connection or `ECONNREFUSED`.

## 12–13. Test report

`apps/api/src/core/security/__tests__/rate-limit.integration.spec.ts` — 9 tests, real Redis.

| Assertion | Result |
| --- | --- |
| **Two independent adapters + guards (two instances) share one budget**, requests alternating | ✅ |
| Both instances refuse once the budget is spent | ✅ |
| Refusal carries the retry window and leaks nothing about infrastructure | ✅ |
| One tenant cannot consume another's budget | ✅ |
| One attestation cannot consume another's (different revision / purpose) | ✅ |
| Login counted by submitted address without resolution | ✅ |
| Every request up to the limit allowed; the next refused | ✅ |
| **Concurrency**: 2× the budget fired at once, exactly `limit` pass | ✅ atomic, not read-then-write |
| Credential route refused when the limiter is unreachable | ✅ |
| Non-credential route still served when the limiter is unreachable | ✅ |

**What is not proven, and why it keeps the status at PARTIALLY COMPLETE.** §17 requires at least one
test driving N requests and an N+1 rejection *through the real HTTP pipeline*. These tests construct
a genuine `ExecutionContext` and exercise the guard exactly as Nest invokes it, with real Redis and
real tenant context — but they do not boot the Nest application and issue HTTP requests. The guard's
*binding* is asserted by inspection of `app.module.ts` rather than by a request traversing it. That
is a real gap in the proof, not a formality, and it is the one thing standing between this and
COMPLETE.

## 14. Dependency report

`@nestjs/throttler` **removed**. Proven unused first: `grep -rn "throttler|Throttler"` across
`apps/api/src`, `apps/worker/src` and `packages` returned zero imports and zero runtime bindings
before removal. Nothing else was touched.

## 15. Configuration compatibility

No environment variable renamed, no unit changed, no default changed. `RATE_LIMIT_WINDOW_SECONDS`
and `RATE_LIMIT_MAX_REQUESTS` (60 s / 300) remain parsed and remain unread — they duplicate the
`default` rule's values, and the rule table is authoritative per §1. Recorded rather than removed.

## 16. 2026 hardening review

| Control | State |
| --- | --- |
| Distributed enforcement | ✅ proven across two instances |
| Atomic counter updates | ✅ `INCR`, proven under concurrency |
| TTL correctness | ✅ `EXPIRE NX` — fixed window, self-cleaning |
| Tenant isolation | ✅ proven; a defect was found and fixed |
| Race safety | ✅ no read-then-write |
| Signature credential protection | ✅ 5 / 15 min |
| Enumeration resistance | ✅ submitted address, never resolved |
| Fail-closed credential routes | ✅ proven |
| No process-local fallback | ✅ none exists |
| Bounded key cardinality | ✅ closed rule and dimension sets, TTL on every key |
| No sensitive values in keys or logs | ✅ |
| Observable limiter failures | ✅ `error` on a credential refusal, `warn` otherwise |
| **End-to-end HTTP proof** | ❌ |

## 17. Validation

| Gate | Result |
| --- | --- |
| install | pass (lockfile updated for the removal) |
| format:check | pass |
| lint | 0 errors, 5 pre-existing warnings |
| typecheck | 13/13 |
| test | 636 API, 164 domain, 97 web, 26 contracts, 11 utils, 4 i18n, 2 worker |
| build | 9/9 |
| verify:styles | 10/10 |
| **integration** | **634 passed, 35 files, 0 skipped** (was 625/34 — +9) |

PostgreSQL was reclaimed by the container a third time mid-phase and Redis twice; both were
restarted and the suite re-run. The databases survived, the migration from Part B was verified still
present, and no test was weakened. **One run's mass failure was caused by the reclaim, and that was
confirmed by restarting the infrastructure and re-running to a clean 634 — not assumed.**

## 18. Architecture compliance

| Rule | Held |
| --- | --- |
| No second rate limiter | ✅ this is the first |
| No process-local state | ✅ |
| `@nestjs/throttler` not used | ✅ removed |
| No new cache/Redis abstraction | ✅ existing `CachePort` |
| Platform not modified | ✅ |
| Existing rules unchanged | ✅ one added, none altered |
| ADR-0017, signature domain, UI untouched | ✅ |

## 19. Phase 6.6 unblock assessment

| Blocker | State |
| --- | --- |
| 1 — signature endpoint unlimited | 🟡 **Substantially closed.** Limited to 5 / 15 min, Redis-backed, distributed across instances, fails closed, tenant-isolated, concurrency-safe — all proven. The HTTP-pipeline proof §19 of the 6.6 brief would want is the remaining gap |
| 2 — concurrent live signatures | ✅ Closed by Part B |

**I am not stating "Phase 6.6 is now unblocked."** The criteria require real HTTP rate limiting
proven end to end, and the proof stops at the guard. The security property is very likely correct —
the guard is bound in the composition root and the mechanism is proven against real Redis — but
"likely correct" is what Phase 6.6 refused to accept about the previous two controls, and it would
be inconsistent to accept it here.

## 20. Phase 6.7 Final Status

**PARTIALLY COMPLETE.**

Part B is complete and proven. Part A is implemented, bound, and proven at the guard layer against
real Redis with two instances, tenant isolation, concurrency, boundary and fail-closed behaviour —
and is one test short of the standard this sequence has held itself to.

**To reach COMPLETE:** boot the Nest application in an integration test, issue N real HTTP requests
to `POST /v1/documents/:id/signatures` and assert the N+1 receives `429`. That single test converts
"the guard is registered and works" into "the route enforces it", and closes Blocker 1 outright.
Estimated: half a day.
