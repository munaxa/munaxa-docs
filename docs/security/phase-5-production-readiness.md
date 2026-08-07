# Phase 5 — 2026 Security Hardening & Production Readiness

The final security and production-readiness review for Munaxa Docs, and the intended reference
baseline for Munaxa School, Munaxa Work and whatever follows.

Platform 2.4.1 throughout. No Platform code was modified.

---

## 19. Executive Production Readiness Summary

**Verdict: production-ready, with one Critical finding that this phase fixed and one High finding
that it did not.**

The review found **one Critical** issue, and it was not subtle: **there was no rate limiting at
all.** `RATE_LIMIT_RULES` had described this product's limits since Phase 0.5, `@nestjs/throttler`
sat in `package.json`, and **neither had a single call site**. Sign-in, password reset, presign and
export were unlimited. That is fixed in this phase, distributed through Redis, with tests that
assert refusal rather than configuration.

Everything else the review touched was in materially better shape than that finding suggests. Row-
level security is discovery-based and verified at 77/77 tables with `FORCE` enabled; the audit
trail is append-only in grants *and* triggers *and* the application role has no `UPDATE`; there are
zero TODOs, zero `console.*`, zero hardcoded secrets and one `Math.random()` (webhook backoff
jitter, correctly not a security decision).

**A correction I owe.** My own P4.6 and P4.7 audits stated that "the local limiter is per-process,
so the documented limit is silently multiplied by the replica count". That was wrong. I inferred a
limiter from the existence of `core/security/rate-limit.ts` without checking for a binding. There
was no limiter to multiply. The correct characterisation was Critical, not Medium, and it went
unstated for two phases because I described a file rather than checking a call graph.

### Findings at a glance

| # | Finding | Severity | Blocks production? | Status |
|---|---|---|---|---|
| F1 | No rate limiting enforced anywhere | **Critical** | Yes | **Fixed this phase** |
| F2 | Session cookies not `Secure` when `NODE_ENV=staging` | **High** | Yes, for staging | **Fixed this phase** |
| F3 | Six vulnerable transitive dependencies | **High** (4) / Medium (2) | No | **Fixed this phase** |
| F4 | Per-account login limiting cannot be expressed in the guard | **High** | No | Open — recommendation below |
| F5 | Chain-break alert has no delivery path | **Medium** | No | Open — pre-existing, documented |
| F6 | `outbox-dispatch` integration test is flaky | **Low** | No | Open |
| F7 | COOP/COEP absent | **Informational** | No | Won't fix — reasoning below |
| F8 | Refresh cookie scoped to `path: /` | **Informational** | No | Won't fix — reasoning below |

**Zero Critical and zero High findings remain open that block production.** F4 is High and open,
and I am not claiming otherwise: it is a real gap in defence against distributed credential
stuffing, mitigated but not closed by the per-IP limit now in place.

---

## 1. Production Readiness Assessment — **Ready, with F4 tracked**

| Dimension | State |
|---|---|
| Startup validation | Strong. Two validators, every problem in one message, no value ever echoed. Production refuses to boot on a placeholder driver, on the OpenAPI explorer, on plaintext SMTP, on insecure outbound HTTP, and without a witness key, a sealing key or a checkpoint secret. |
| Configuration safety | Strong. 110 settings, all validated; secrets never rendered. |
| Graceful shutdown | Present. `app.enableShutdownHooks()`; the read-audit buffer flushes on `onApplicationShutdown` — the window that a rolling deploy would otherwise lose evidence in. |
| Resource exhaustion | Bounded: upload size by MIME type, archive depth/entries/expansion ratio, preview pixels/pages/bytes, export rows, statement timeout, per-tenant connection ceiling. |
| Rate limiting | **Now authoritative** (F1). |
| Worker reliability | Outbox is transactional with `SKIP LOCKED`; failures retained and retried; nothing dropped. |
| Backpressure | The read-audit buffer degrades to synchronous writes at its hard bound rather than dropping — correct-and-slow, never lossy. |

## 2. 2026 Security Hardening Report — **Completed**

### F1 — No rate limiting enforced anywhere · **Critical** · fixed

**Evidence.** `grep -rn "ruleFor\|RATE_LIMIT_RULES"` returned only the declaration.
`grep -rn "Throttler"` returned nothing. No `APP_GUARD` for rate limiting existed in
`app.module.ts`.

**Risk.** Unlimited credential stuffing against `/auth/login`; unlimited password-reset requests
(both an account-enumeration oracle and an email-bombing vector); unlimited presign, each minting a
storage credential; unlimited export, each reading the whole audit trail.

**Impact.** Account takeover at scale, and a trivially available denial of service against both the
database and the object store.

**Fix.** `RateLimitGuard` registered as the **first** global guard, backed by `@munaxa/security`'s
`RateLimiter` over the Redis `CachePort`. Twelve rules across five surfaces, per IP, per user, per
tenant and per session, with `adaptiveFactor: 2` on the authentication surfaces so repeated
violations lengthen the penalty window.

**Why it is authoritative rather than best-effort.** The counters are in Redis, so the published
limit is the actual limit across every replica, every region and a rolling deployment where old
and new pods serve at once. `the counters are shared, not per process` asserts exactly this: two
guard instances, one store, the eleventh request refused.

**Fail-open, loudly.** A store failure allows the request and raises `ratelimit.degraded` plus an
error log. That is the right trade — a Redis blip must not take sign-in down — but only if somebody
is told, so silence is not an option the code permits.

**Effort:** ~1 day including tests. **Blocked production: yes.** Now closed.

### F2 — Session cookies not `Secure` under `NODE_ENV=staging` · **High** · fixed

**Evidence.** `apps/web/src/lib/auth.ts:110` — `const secure = process.env.NODE_ENV ===
'production'`. The API's own configuration enum is
`['development', 'test', 'staging', 'production']`.

**Risk.** A staging deployment served over HTTPS wrote the access *and* refresh cookies without
`Secure`, so any downgrade to plain HTTP would put a live refresh token on the wire.

**Impact.** Session hijacking in the environment most likely to be internet-reachable without being
watched closely, and typically holding a copy of production-shaped data.

**Fix.** `NODE_ENV !== 'development' && NODE_ENV !== 'test'` — every environment but the two that
genuinely run without TLS. **Effort:** minutes. **Blocked production: yes, for staging.** Closed.

### F3 — Six vulnerable transitive dependencies · **High/Medium** · fixed

**Evidence.** `pnpm audit --prod`: 4 high, 2 moderate. All transitive —
`next > postcss` (×4), `next > sharp`, `@nestjs/swagger > js-yaml`.

**Fix.** Three targeted `pnpm.overrides`. `pnpm audit --prod` now reports **no known
vulnerabilities**; build and all 685 unit tests pass unchanged. **Effort:** under an hour.
**Blocked production: no** — none is reachable from the API's request path — but they are free to
close and a scanner will flag them.

### F4 — Per-account login limiting is not expressible in the guard · **High** · open

**Evidence.** `core/security/rate-limit.ts`'s own docblock promises "every login limit is enforced
per IP *and* per account, so distributing an attack across addresses does not lift it." The
Platform's `RateLimitTarget` carries method, path, tenant, IP, user and session — **not the request
body**, and on an anonymous login the account is the email in the body. The `auth.login.user` rule
therefore never fires on a sign-in attempt.

**Risk.** An attacker distributing across many source addresses gets 10 attempts *per address*
against one account. The per-IP limit raises the cost of a botnet but does not bound attempts
against a single victim.

**Impact.** Slow, distributed credential stuffing against a targeted account remains viable.

**Recommendation.** Enforce it where the identifier is known — inside `AuthenticationService`,
after the email is parsed and *before* the password is verified, using the same `CachePort`. Keyed
on `tenant + normalised email`. Two cautions: it must not become an enumeration oracle (the refusal
must be indistinguishable from a wrong password to an unauthenticated caller), and it must not let
an attacker lock a known victim out by burning their budget deliberately — which is why the
recommendation is a *throttle with a decaying window*, not a lockout.

**Effort:** 1–2 days including the enumeration-safety tests. **Blocks production: no** — the per-IP
limit is a genuine control and this is a hardening step beyond it. It is the highest-value security
work remaining.

## 3. OWASP Compliance Assessment — **Completed**

Against the OWASP Top 10 (2021, still current in 2026) and ASVS L2 where it applies.

| | State | Evidence |
|---|---|---|
| A01 Broken Access Control | **Strong** | Four layers: `AuthenticationGuard` (closed by default), `TenantIsolationGuard`, `RbacGuard`, `AclGuard`; plus RLS at 77/77 tables. A cross-scope read returns `NotFoundError`, so the API never leaks another tenant's existence. |
| A02 Cryptographic Failures | **Strong** | Argon2id/scrypt via `@munaxa/crypto`; MFA secrets sealed with a dedicated key; HMAC-signed audit checkpoints; cookies `Secure`+`HttpOnly` (after F2). |
| A03 Injection | **Strong** | Prisma parameterises throughout; the two `$queryRawUnsafe` uses pass values as bind parameters (`$1`), not interpolation. |
| A04 Insecure Design | **Strong** | Threat model, ADRs, deployment-profile validation, append-only evidence. |
| A05 Security Misconfiguration | **Strong** | Startup refuses unsafe production configurations; helmet bound; CORS explicit and never `*`. |
| A06 Vulnerable Components | **Now clean** | F3. |
| A07 Identification & Authentication | **Good**, F4 open | Rotation, replay detection, family revocation, idle+absolute timeouts, concurrency cap, MFA. Distributed per-account throttling is the gap. |
| A08 Software & Data Integrity | **Strong** | Hash-chained audit, signed checkpoints, `pnpm` lockfile, registry-pinned Platform. |
| A09 Logging & Monitoring | **Good** | Structured logging, correlation IDs, redaction, 79-action audit vocabulary, metrics with an enforced label catalogue. Alert *delivery* is F5. |
| A10 SSRF | **Strong** | Outbound HTTP is allow-listed and empty by default; `OUTBOUND_HTTP_ALLOW_INSECURE` is refused in production. |

## 4. Authentication Security Review — **Completed**

Rotation, replay detection and family revocation are `@munaxa/auth`'s since P4.4B; `tokenVersion`
invalidates on credential change. `LegacyScryptVerifier` remains verify-only. Account enumeration
is handled deliberately: `MFA_REQUIRED` is returned only *after* the password verifies, so it
discloses nothing about which addresses hold accounts.

**Not implemented: account lockout.** The Platform's `LoginService` offers it; this product does
not use it. That remains a product decision rather than a defect — lockout is itself a
denial-of-service vector against a known account, which is why F4 recommends a throttle instead.

## 5. Authorization Security Review — **Completed**

Four guards, ordered, closed by default, plus object-level ACL resolution and RLS underneath.
Every `ForbiddenError` is audited as `ACCESS_DENIED`, and the denial recorder deliberately does
**not** record a denial for an identifier that names nothing — a trail that distinguished "denied"
from "absent" would answer the existence question the 404 was written to withhold. That is a
subtle control and it is correct.

## 6. Session Security Review — **Completed**

| | State |
|---|---|
| Idle timeout | 8 h default, 5 min–8 h bounds, Platform-enforced |
| Absolute timeout | 30 d default, never moves once the family opens |
| Idle ≤ absolute | Enforced as a cross-field refinement (added P4.6) |
| Rotation / replay detection / family revocation | `@munaxa/auth`, P4.4B |
| Concurrency | 10 per user, oldest evicted rather than newest refused |
| Logout / forced logout / credential change | `tokenVersion`; every session ends on password set and on account disable — asserted in `identity-admin.integration.spec.ts` |
| Cookies | `HttpOnly`, `Secure` (F2), `SameSite=Lax`, `path=/` |

## 7. Rate Limiting Report — **Completed**

Covered under F1. Twelve rules; sliding window with adaptive penalties on authentication surfaces;
`RateLimit-*` headers on every response and `Retry-After` on every refusal; `ratelimit.exceeded`
and `ratelimit.degraded` metrics labelled by rule only — never by subject, because an IP address as
a metric label is the unbounded cardinality that takes the metrics backend down during the incident
it was added for.

## 8. Security Headers Report — **Completed, no change needed**

Bound in `bootstrap.ts` and already correct: CSP (`default-src 'none'`, `frame-ancestors 'none'`,
`base-uri 'none'`, `form-action 'none'`), HSTS (2 years, `includeSubDomains`, `preload`),
`Referrer-Policy: strict-origin-when-cross-origin`, `X-Content-Type-Options`, `X-Frame-Options:
DENY`, CORP `same-site`, Permissions-Policy with every feature off, `X-Powered-By` removed.

**F7 — COOP/COEP absent · Informational · won't fix.** Both govern the browsing-context
relationships of *documents*. This API returns `application/json` and
`application/problem+json` exclusively; there is no window to isolate and no cross-origin isolation
to enable. Adding them would be header weight that satisfies a scanner and changes nothing, which
the brief explicitly asks not to do. The web app — which does serve documents — is the correct
place for COOP, and that is a separate surface.

No obsolete headers are present: no `X-XSS-Protection`, no `Expect-CT`, no `Feature-Policy`.

## 9. Database Security Report — **Completed, verified live**

Every claim below was executed against a real PostgreSQL 16 database, not read from a migration.

| Check | Result |
|---|---|
| Tables carrying `tenant_id` | 77 |
| Tables with `FORCE ROW LEVEL SECURITY` | **77** |
| `tenant_isolation` policies | **77** |
| `edms_app` is superuser | **no** |
| `edms_app` has `BYPASSRLS` | **no** |
| `edms_app` grants on `audit_event` | **`INSERT`, `SELECT` only** |
| Append-only trigger on `audit_event` | `trg_audit_event_append_only` present |

The isolation SQL **discovers** its tables rather than listing them, and re-runs after every
migration. A hand-maintained list is a hole waiting to open; discovery makes the omission
impossible rather than merely detectable. This is the single best design decision in the security
posture and should be copied verbatim by School and Work.

Migration safety, connection handling and locking: statement timeout bounded, per-tenant client
ceiling bounded, audit appends serialised by `pg_advisory_xact_lock` with gap-free `tail + 1`.

## 10. File Security Report — **Completed, no change needed**

The pipeline's *order* is the security property, and it is right: declared MIME type checked
against **sniffed** magic bytes, then size and quota, then the malware scan — and content is
unreachable until the scan reports `CLEAN`. Archive bombs are bounded by depth, entry count and
expansion ratio. Downloads are authorised per object; signed URLs are short-lived (30 s–1 h,
default 5 min). `AV_DRIVER=NONE` is refused in production.

## 11. Audit Security Report — **Completed**

Append-only in three independent layers (grants, trigger, no `UPDATE`/`DELETE` on the port),
hash-chained across three historical formats, verified by `@munaxa/audit` from HMAC-signed
checkpoints held outside both the database and the object store. Verification refuses to checkpoint
over a range that failed. Tamper findings distinguish three accusations from two "cannot verify"
outcomes, so an unrecognised format never pages somebody about an intruder who was never there.

**F5 — chain-break alerts have no delivery path · Medium · open (pre-existing).** `audit.chain-broken`
is published to the outbox and logged at error; no consumer delivers it. The log line is the
alert today. **Recommendation:** wire the outbox event to the notification module, and page on the
`audit.chain.verified{intact=false}` metric — which exists precisely so the alerting condition is
not "the number stopped moving". **Effort:** ~1 day. **Blocks production: no**, provided the
deployment alerts on the metric; that requirement belongs in the runbook.

## 12. Operational Security Report — **Completed**

Structured logging via `@munaxa/logging` with redaction; correlation IDs propagated; W3C trace
context; health endpoints; metrics behind a scrape token that production requires. Secrets are
never rendered — asserted by `never puts a value in the message`.

**Deployment review.** TLS terminates at the edge with HSTS also set at the origin, so a
direct-to-origin deployment is not silently weaker. Backups, restore and DR are documented in
`docs/operations/`; this review did not exercise a restore, and **that is the one production
readiness claim I cannot make from evidence.** A restore rehearsal should gate go-live.

## 13. Dependency Security Report — **Completed**

`pnpm audit --prod`: **no known vulnerabilities** (was 4 high, 2 moderate — F3).

**Removed:** `@nestjs/throttler` — a declared dependency with zero imports anywhere in the
repository, whose intended role is now `@munaxa/security`'s. Evidence: `grep -rn "throttler"` over
`apps/` returned only the doc comments written in this phase.

**Kept:** `zod` (≈100 product config fields), `helmet` (bound), `sharp`/`postcss` (transitive to
`next`, now overridden).

## 14. Performance & Scalability Review — **Completed**

Keyset pagination on every large walk (audit verification, export) rather than offset — an offset
scan re-reads the prefix on every batch, which over millions of rows is the difference between a
pass and an outage. Read auditing is buffered so a hundred page views cost one advisory lock rather
than a hundred. Bounded: connection pool, tenant clients, statement timeout, export rows, PDF rows.
Metrics histograms are bucketed against the product's own p95/p99 targets rather than a library
default.

## 15. Architecture Compliance Report — **Completed**

| Check | Result |
|---|---|
| Platform ownership correct | Yes — crypto, cache, config, interfaces, logging, auth, sessions, refresh tokens, RBAC, audit append/serialisation/verification/transaction participation |
| No Platform duplication reintroduced | Yes. This phase *removed* duplication (`@nestjs/throttler`) and added none |
| Product-specific functionality remains product-owned | Yes — vocabulary, canonical formats, advisory lock, checkpoint trust, upload policy, metrics label catalogue |
| No reverse dependency | Yes — `grep "from '@munaxa/[a-z]*/'"` returns nothing |
| Deployment-agnostic | Yes — every external capability arrives through a port |

The new `RateLimitGuard` follows the established shape: the Platform owns the algorithm and the
counters, the product owns the rules and the key namespace.

## 16. Technical Debt Register

| Item | Severity | Effort | Blocks production |
|---|---|---|---|
| F4 — per-account login throttle | High | 1–2 d | No |
| F5 — chain-break alert delivery | Medium | 1 d | No (runbook must alert on the metric) |
| F6 — flaky `outbox-dispatch` test | Low | 2 h | No |
| Refresh-token pepper (dual-read migration) | Low | 2 d | No |
| Legacy scrypt verifier removal | Low | blocked on data | No |
| TOTP migration to `@munaxa/auth` | Low | 1 d | No — **now unblocked, see §17** |
| Security headers / distributed limiting in School and Work | — | — | Out of scope |

**F6 evidence:** fails under parallel load on this branch *and* on the pre-change tree (confirmed
in P4.6 by stashing and running three times). A fixed 100 ms sleep waiting for another connection
to take a row lock; should poll `pg_locks`.

## 17. Platform Enhancement Recommendations

1. **A `CheckpointPort`** — sign, verify, store, with the key strictly the product's. Every product
   doing incremental audit verification will otherwise rebuild this machinery.
2. **A schema default override** for `@munaxa/config` — `remapSchema` cannot change a default, which
   was the largest friction in P4.6.
3. **`redactConfig` should compose with `nestConfig`** — the natural composition needs a cast.
4. **A metrics label catalogue** — bounded label sets are a real control the Platform cannot express,
   and this product's implementation is the better one.
5. **A body-aware rate-limit dimension** — F4's root cause. `RateLimitTarget` cannot carry the
   account being attempted, so per-account login throttling is inexpressible in the guard. A
   `subject?: string` on the target, supplied by the caller, would close it without the Platform
   ever parsing a body.

### TOTP: compatibility proven, migration unblocked

Phase 5 asked for this to be verified empirically rather than assumed, and it now is.
`totp-platform-compatibility.spec.ts` asserts that a code from either implementation is accepted by
the other, over 50 secrets across many time steps, in both directions, with identical drift
windows and identical secret encoding.

That matters because a mismatch does not degrade gracefully: it signs out every MFA-enrolled user
at once with no fallback, since a password can be reset and an authenticator cannot be un-broken.
The test runs whether or not anyone migrates — if a future Platform release changes the period,
digits, algorithm or encoding, it fails, and that is worth knowing *before* somebody adopts it.

## 18. Product-Specific Justification Report

Deliberately not Platform-owned, with reasons:

| Item | Why it stays |
|---|---|
| Signed checkpoint store | The HMAC key must live where the Platform cannot reach — not in the database holding the chain, not in the bucket holding the export |
| Audit vocabulary (80 actions) and three canonical formats | Document-management content; the Platform provides the framework |
| Advisory lock and gap-free `tail + 1` | Ordering guarantees the Platform deliberately leaves to the adapter |
| Upload policy and archive limits | EDMS content rules |
| Metrics label catalogue | Richer than the Platform's `MetricsPort` — propose upstream rather than replace |
| `chainHash` / `canonicalize` | The other half of the byte-for-byte compatibility assertion; nothing calls them in production |
| ~100 configuration fields, `JWT_AUDIENCE`, `NODE_ENV` | Settled in P4.6 with reasons |
| Rate limit *rules* (not the algorithm) | Which surfaces matter and at what cost is a product judgement |

---

## Validation

| Gate | Result |
|---|---|
| `pnpm install` | Clean, registry-only, Platform 2.4.1 |
| `pnpm lint` | 0 errors, 5 pre-existing warnings |
| `pnpm typecheck` | Clean — no suppressions, no `any`, no new casts |
| `pnpm test` | **685 passed**, 1 skipped (was 669 — 16 new) |
| `pnpm test:integration` | **591 passed, 34 files** — PostgreSQL 16 + Redis |
| `pnpm build` | 9/9 |
| `pnpm audit --prod` | **No known vulnerabilities** |

**Penetration-style verification actually executed** (not asserted from source): live RLS coverage
count, live role attributes, live `audit_event` grants and trigger, rate-limit refusal at the
boundary, two-replica shared counters, cross-implementation TOTP codes.

**Not executed, and named as such:** an external network penetration test, a backup restore
rehearsal, and a load test at production scale. None can be performed from this environment. The
restore rehearsal in particular should gate go-live — it is the only production-readiness claim in
this document that rests on documentation rather than evidence.
