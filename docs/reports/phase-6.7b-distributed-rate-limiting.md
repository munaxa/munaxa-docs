# Phase 6.7B — Distributed Rate Limiting Completion

**Status: PARTIALLY COMPLETE** (unchanged from Phase 6.7 — Part A remains unimplemented)

**Phase 6.6 is still blocked.** Blocker 2 (signature concurrency) stays closed by Phase 6.7 Part B.
Blocker 1 (rate limiting) is not closed.

This phase performed the §1 survey and stopped there, because the survey overturned the brief's
central premise. No code was written. What follows is the verified state and the design the next
attempt should build, so that nothing here has to be rediscovered.

---

## The premise correction: `@munaxa/security` does not exist

The brief instructs, repeatedly, to use "the existing `@munaxa/security` RateLimiter and
`CachePort`", not to "duplicate the Platform security implementation", and to "import Platform
internals" never. That instruction cannot be followed, because the package it names is not part of
this workspace.

| Check | Result |
| --- | --- |
| `grep '"@munaxa/' apps/api/package.json` | Only `@munaxa/config-eslint`, `@munaxa/config-typescript` |
| `ls node_modules/.pnpm/@munaxa*` | `config-eslint`, `config-typescript`, `icons`, `platform`, `theme`, `tokens`, `ui` |
| `@munaxa/security` | **Does not exist** |
| `@munaxa/cache` | **Does not exist** |
| `@munaxa/platform` `exports` map | `.`, `./tokens`, `./typography`, `./themes`, `./icons`, `./hooks`, `./patterns`, `./layouts`, `./shell`, `./date`, `./charts`, `./css/tokens` |
| Does the **API** depend on `@munaxa/platform`? | **No** — it is a frontend package, consumed only by `apps/web` |

So there is no Platform rate limiter to wire, no Platform `CachePort` to reuse, and no Platform
`RateLimitTarget` whose expressiveness could be assessed. §4 and §22 both name this exact situation
and instruct: *"If the Platform cannot express the required distributed rate-limit semantics: STOP
and report the exact Platform limitation"* and *"Do not modify the Platform from this Docs phase."*

**The exact API gap:** `@munaxa/platform` is a UI package. It ships no server-side security surface
of any kind — no limiter, no cache abstraction, no request-classification primitive. Closing this
gap in the Platform would mean adding a server-side entry point to a package that currently has
none, which is a Platform architecture decision and explicitly outside this phase.

### But this does **not** make the work blocked

The product has the primitive already, in its own tree rather than the Platform's:

```ts
// apps/api/src/ports/cache.port.ts
increment(key: string, ttlSeconds: number): Promise<number>;
```

```ts
// apps/api/src/infrastructure/cache/redis-cache.adapter.ts
async increment(key: string, ttlSeconds: number): Promise<number> {
  const [count] = await this.client.multi()
    .incr(key).expire(key, ttlSeconds, 'NX').exec()
    ...
}
```

That is a **Redis-backed, atomic, TTL-bounded counter** — precisely and exactly what a distributed
fixed-window limiter needs, already bound and already used in production paths (`federation.service`,
`http-oidc.discovery`). `INCR` is atomic across connections and therefore across instances;
`EXPIRE … NX` sets the window on first touch without extending it on later ones, which is what makes
the window fixed rather than sliding-by-accident.

So a guard built on `CachePort` would be **the first rate limiter in this product, not a second**.
§3's prohibition targets duplicating an existing implementation, and there is nothing to duplicate.
It would also not touch the Platform.

**This is therefore a scoping decision for you, not a technical blocker**, and I am naming it rather
than choosing silently: the brief says to use a Platform component that does not exist, and the
correct substitute is a product-local guard over the existing `CachePort`.

## 1. Rate-Limit Call-Graph Report

```
request
  → AuthenticationGuard → TenantIsolationGuard → RbacGuard → AclGuard → handler
```

No rate-limit guard, middleware or interceptor exists at any point. `RATE_LIMIT_RULES` and `ruleFor`
are exported from `core/security/index.ts` and have **zero consumers** — re-verified this phase.
`@nestjs/throttler` remains declared and imported nowhere.

## 2. `RATE_LIMIT_RULES` Coverage Matrix

Every rule is in the same state, so the matrix is uniform and short. Statuses are per §2's required
vocabulary.

| Surface | Rule | Window / limit | Actual route(s) | Guarded? | Redis-backed? | Test | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Sign-in | `auth.login` | 300 s / 10, ip+identity | `POST /v1/auth/login` | ❌ | ❌ | ❌ | **BLOCKED** — no guard exists |
| Password reset | `auth.password-reset` | 3 600 s / 5, ip+identity | *no route exists* | ❌ | ❌ | ❌ | **BLOCKED** — and see note |
| Search | `search` | 60 s / 60, identity | `GET /v1/search` | ❌ | ❌ | ❌ | **BLOCKED** |
| Presign | `upload.presign` | 60 s / 120, identity+tenant | `POST /v1/uploads` | ❌ | ❌ | ❌ | **BLOCKED** |
| Export | `export` | 3 600 s / 10, identity+tenant | `/v1/reporting/*`, `/v1/audit/export` | ❌ | ❌ | ❌ | **BLOCKED** |
| Everything else | `default` | 60 s / 300, identity | all | ❌ | ❌ | ❌ | **BLOCKED** |
| **Signature** | **none** | — | `POST /v1/documents/:id/signatures` | ❌ | ❌ | ❌ | **No rule defines its protection** |

Two findings from building this matrix:

- **`auth.password-reset` has no route.** There is no password-reset endpoint in the product;
  `UserAdminService.setPassword` is an administrative act behind `user:manage`. The rule is
  therefore **reserved for a capability that does not exist**, and wiring it would protect nothing.
  Recorded rather than deleted, per §2.
- **The signature endpoint has no rule.** §9 is explicit that a number must not be invented
  silently, so none is proposed here. What the rule needs to be is a small product-security decision
  — see §7 below.

## 3–5. Guard binding, Redis integration, distributed design

**Not implemented.** The design the next attempt should follow, derived from what exists:

- **Seam:** a fifth `APP_GUARD` in `app.module.ts`, ordered **before** `AuthenticationGuard` for
  unauthenticated surfaces (login must be limited by IP before identity exists) and re-consulted
  after it where a rule is keyed on identity. The simplest correct arrangement is one guard that
  reads whatever context is available and keys on what the rule names.
- **Rule selection:** deterministic, from a route→rule map declared beside `RATE_LIMIT_RULES`, with
  `default` as the fallback `ruleFor` already implements.
- **Key shape:** `rl:{rule}:{dimension}:{value}` — `dimension` from the rule's own `by` array, so
  `auth.login` produces two keys (ip and identity) and both must pass. Bounded cardinality: rules
  are a closed set, dimensions are a closed set, and every key carries the rule's TTL.
- **Counter:** `CachePort.increment(key, rule.windowSeconds)` — one atomic round trip, no
  read-then-write, no process-local state anywhere.
- **Tenant safety:** `tenant` is already one of the `by` dimensions; keys must include it wherever
  the rule names it, and identity-keyed buckets are naturally per-tenant because user ids are.
- **Response:** `429` with `Retry-After`, which `15 §5`'s error table already specifies — so no new
  API contract.

## 6. Redis Failure Policy — **the decision that must be made first**

`CachePort` has **no defined failure policy**. `RedisCacheAdapter` lets errors propagate; callers
today (`federation.service`, OIDC discovery) treat a cache miss as a miss, which is fail-open and
harmless *for a cache*. It is not harmless for a limiter.

§6 forbids silently choosing either direction, and I have not. The options, stated so the decision
can be made with the trade-off visible:

| Policy | Consequence |
| --- | --- |
| Fail-open everywhere | A Redis outage silently removes the only brute-force control from login **and** the signature ceremony — the precise state Phase 6.6 blocked on |
| Fail-closed everywhere | A Redis outage takes the whole product down, including reads that need no limiting |
| **Fail-closed on credential-accepting routes, fail-open elsewhere** | Login, reset and signing refuse during an outage; browsing continues. Security-preserving and availability-preserving where each matters |

The third is the smallest security-preserving policy consistent with §6's instruction not to let a
credential endpoint degrade to unlimited. **It is a product security decision and is recorded here
as one, not assumed.**

## 7. Signature Endpoint Protection — no rule exists

The signature endpoint accepts a password and a TOTP code and returns one undifferentiated refusal.
It is unlimited today. §9 requires that a new rule be justified rather than invented, so this
records what such a rule would need to specify, and proposes nothing further:

- **Name:** `document.sign`
- **Purpose:** bound credential guessing against the §11.200 re-authentication control, whose entire
  threat model (ADR-0017 §6) is an attacker holding a session they should not
- **Key dimensions:** identity + tenant — never the password, and never a body field
- **Window / maximum:** *undecided.* It must be tight enough that guessing is infeasible and loose
  enough that a signer who mistypes twice is not locked out of a compliance act. That is a judgement
  about regulated workflow, not a number to be picked here
- **Response:** `429` + `Retry-After`, identical in shape to every other limited route, so it adds
  no oracle
- **Compatibility:** additive; no existing contract changes

## 8–12. Tenant isolation, enumeration, multi-instance, boundary, window tests

**None written**, because there is no implementation to test. §7's two-instance test and §17's
N-allowed/N+1-rejected test through the real HTTP pipeline are the properties that would make this
phase COMPLETE, and neither exists.

One design constraint worth recording for §12: the key for `auth.login` must be the **submitted
identifier**, not a resolved account id — resolving it first would make a rate-limit response depend
on whether the account exists, creating exactly the enumeration oracle §12 forbids. Keying on the
raw submitted string treats real and fictitious accounts identically.

## 13. Dependency Cleanup

`@nestjs/throttler` is unused and **has not been removed**. §14 requires proving it is unused *after
the real implementation exists* — and if the guard is built on `CachePort`, it stays unused and
should then be removed. Removing it now, before the approach is chosen, would be premature.

## 14. Configuration Compatibility

Nothing changed. `RATE_LIMIT_WINDOW_SECONDS` and `RATE_LIMIT_MAX_REQUESTS` keep their names, units
and defaults (60 s / 300) — note they duplicate the `default` rule's values, so a future
implementation should decide which is authoritative rather than honouring both.

## 15. 2026 Hardening Review

Assessable only as intent, since nothing is built. The design above satisfies: distributed
enforcement (Redis `INCR`), race-safe counters (atomic, no read-then-write), bounded key cardinality
(closed rule and dimension sets), TTL cleanup (`EXPIRE` on every key), no process-local fallback,
and no sensitive data in keys. **Unmet today: every one of them, because no limiter runs.**

## 16. Validation Report

No product code changed, so no gate could move. Phase 6.7's results stand: format, lint 0 errors,
typecheck 13/13, unit 636 API / 164 domain / 97 web, build 9/9, verify:styles, integration 625 across
34 files, 0 skipped. No test was added, because tests for an unimplemented control would assert
nothing.

## 17. Architecture Compliance

| Rule | Held |
| --- | --- |
| No UI | ✅ |
| ADR-0017 untouched | ✅ |
| Signature domain untouched | ✅ |
| Platform not modified | ✅ |
| No second rate limiter | ✅ — none created |
| No process-local state | ✅ — none created |
| No invented limits | ✅ — no number proposed |
| No undocumented security policy | ✅ — the failure policy is presented as a decision |

## 18. Phase 6.6 Unblock Assessment

| Blocker | State |
| --- | --- |
| 1 — rate limiting enforced across instances | ❌ **Open** |
| 2 — two concurrent requests cannot create two live signatures | ✅ Closed by Phase 6.7 Part B |

**Phase 6.6 remains blocked.** The signature endpoint still accepts unlimited password attempts.

## 19. Phase 6.7 Final Status

**PARTIALLY COMPLETE.**

Part B is done and proven. Part A is not implemented, and this phase did not implement it because
the survey §1 mandates found that its central instruction — wire the existing `@munaxa/security`
RateLimiter — refers to a package that does not exist in this workspace, and §4/§22 direct a STOP
and a documented API gap rather than a substitution chosen unilaterally.

**What I recommend, plainly:** do not wait for a Platform package. Build the guard on the product's
own `CachePort`, whose `increment` is already an atomic Redis `INCR` + `EXPIRE NX` and is already
bound. That is one guard, one route→rule map, and the tests §7/§16/§17 specify. The two decisions
that must be made by a person first are the **Redis-failure policy** (§6) and the **signature rule's
window and maximum** (§7). Neither should be inferred, and I have deliberately left both open.
