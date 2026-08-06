# P4 — Platform adoption report

**Status: Stage 1 partially complete. Stages 2–4 not started.**

Two of Stage 1's seven items are migrated and verified against published packages; five remain,
along with all of Stages 2, 3 and 4. That headline is the most important line here — the rest of
this document is evidence for it, not decoration around it.

Everything reported as done was run against `@munaxa/*@2.0.0` installed from GitHub Packages, with
no overrides, tarballs, workspace links or local paths.

---

## 1. Migration progress report

### Stage 1 — foundations

| # | Capability | State |
| --- | --- | --- |
| 1 | Shared types | **Not migrated.** Docs' `@edms/domain` branded ids are its own; no overlap resolved yet. |
| 2 | Shared interfaces | **Partially.** `CachePort` now comes from `@munaxa/interfaces`. Other ports still local. |
| 3 | Conformance | **Done.** `runCacheConformance` runs against the real Redis adapter — 13/13. |
| 4 | Crypto | **Done.** Local scrypt deleted; `@munaxa/crypto` is the only implementation. |
| 5 | Cache | **Done.** Local `CachePort` and Redis adapter deleted; one platform-conformant adapter. |
| 6 | Configuration | **Not started.** `core/config` is 1,616 lines. |
| 7 | Logging | **Not started.** `core/observability` is 993 lines and also owns metrics, which the platform does not. |

### Stages 2–4

Not started. Audit, security, RBAC, session, notifications; then authentication, password
management, refresh tokens, session lifecycle, permission enforcement, security middleware; then
cleanup.

One item in Stage 2 is **blocked** rather than pending — see §4.

---

## 2. Dependency reduction report

| Metric | Value |
| --- | --- |
| Platform packages declared | 3 runtime (`cache`, `crypto`, `interfaces`) + 1 dev (`conformance`) |
| Platform packages imported | exactly those 4 — no declared-but-unused entries |
| Resolution source | `npm.pkg.github.com` only |
| `file:` / `link:` / `workspace:` references to `@munaxa/*` | **0** |
| `pnpm.overrides` | none |
| pnpm store entries | 477 |

Declared dependencies match imports exactly. The ten platform packages declared ahead of unstarted
work in the paused P4 attempt were removed; each returns with the stage that uses it.

No third-party dependency has been removed yet, because the migrations completed so far replaced
*hand-written* code rather than libraries. `ioredis` is still required — the platform's `CachePort`
is an interface, and Docs supplies the Redis client behind it.

---

## 3. Deleted code report

| Deleted | Lines | Replaced by |
| --- | --- | --- |
| `modules/identity/infrastructure/scrypt-password-hasher.ts` | 160 | `@munaxa/crypto` |
| `modules/identity/infrastructure/scrypt-password-hasher.spec.ts` | 66 | `platform-password.hasher.spec.ts` |
| `infrastructure/cache/redis-cache.adapter.ts` | 69 | `PlatformRedisCacheAdapter` |
| Local `CachePort` interface | 8 | `@munaxa/interfaces` re-export |
| `FakeCache` hand-written double | 45 | `MemoryCache` from `@munaxa/cache` |

**348 lines removed.** Against roughly 30,000 lines of overlapping surface, that is about 1%.

Added in their place: 128 lines of `LegacyScryptVerifier` (temporary by construction, §4), 78
lines of `PlatformPasswordHasher`, and 168 lines of `PlatformRedisCacheAdapter` — the last is not a
duplicate but the adapter the platform's ports require every consumer to supply.

---

## 4. Platform consumption report

**Consumed today:** `@munaxa/crypto` (password hashing), `@munaxa/interfaces` (`CachePort`),
`@munaxa/cache` (`MemoryCache` as the test double), `@munaxa/conformance` (adapter verification).

**Adapters implemented:** `PlatformRedisCacheAdapter` (`CachePort`) — verified 13/13 by the
platform's own suite against real Redis, including `setIfAbsent` and `compareAndSet`, which the
retired local port did not have.

**Blocked — the audit chain (Stage 2).** Not started, and it should not be, for three independent
reasons already filed as platform follow-up P-1:

- Munaxa Docs is on its *third* versioned digest (`CHAIN_HASH_V1`/`V2`/`V3`), and its audit table
  refuses `UPDATE` to every role including the owner — which is exactly what makes the trail
  evidence. Historical rows therefore cannot be rehashed against the platform's frozen canonical
  form, and adopting it would make every one of them fail verification: the tamper alarm firing
  for a benign reason.
- Docs allocates `bigint` sequences; `AuditRecord.sequence` is a `number`.
- `ChainedAuditWriter` commits the audit row *inside* the caller's business transaction. The
  platform's `AuditService` writes through its repository independently, so migrating would weaken
  a compliance guarantee rather than preserve it.

Per this phase's rules, that is documented and left alone rather than worked around inside Docs.

**Temporary compatibility layer, deliberately retained.** `LegacyScryptVerifier` reads
`scrypt$…` password hashes written before the migration. Every credential row in every tenant is
in that format, so deleting it is a mass lockout. It is verify-only — `hash()` rejects — so nothing
new can be written in the old format, and `needsRehash` is true for all of it, so the existing
upgrade-on-sign-in path retires the estate without a forced reset. Delete when no `scrypt$` rows
remain.

---

## 5. Regression report

**No regressions.**

| Gate | Baseline (published packages, pre-Stage-1) | After |
| --- | --- | --- |
| `pnpm install` | clean, registry only | clean, registry only |
| `pnpm typecheck` | 13/13 | 13/13 |
| `pnpm test` | 846 passed, 1 skipped | 846 passed, 1 skipped |
| `pnpm lint` | 0 errors, 5 warnings | 0 errors, 5 warnings |
| `pnpm build` | 9/9 | 9/9 |
| Cache conformance (integration) | 13/13 | 13/13 |

The 5 lint warnings pre-date this work.

**Integration suite not run.** 33 `*.integration.spec.ts` files need PostgreSQL, which this
environment does not have. Several were edited during the crypto migration. They typecheck; they
have not been executed. This is the single largest gap in the evidence and must be closed before
production.

---

## 6. Security validation report

Reviewed for the two capabilities actually migrated; the rest are unchanged from their
pre-migration state and were not re-reviewed.

**Password hashing.** Cost parameters preserved at OWASP N=2¹⁷ rather than adopting the platform's
lighter N=2¹⁴ default — taking the default would have silently weakened every password written
after the migration, a regression no test catches because a weaker hash verifies perfectly well.
Legacy hashes still verify. The no-such-account timing defence is intact and measured: the decoy
costs a full derivation (410 ms against 409 ms for a real verification), with a regression test
asserting it, because a decoy that fails to parse returns in microseconds and hands the endpoint
back its account-enumeration oracle.

**Cache.** Strictly stronger than before. The adapter now provides `setIfAbsent` (server-side
`SET NX PX`) and `compareAndSet` (Lua), so the single-winner semantics MFA replay protection and
one-time codes require are available for the first time. Verified by the platform's conformance
suite against real Redis rather than a mock.

The suite earned its place immediately: it caught `clear()` double-prefixing keys, because ioredis
applies `keyPrefix` to `del` but not to `SCAN MATCH`. Prefix invalidation silently deleted nothing
— a permission cache that never invalidates, serving stale authorization decisions indefinitely
after an ACL change. No sequential test would have found it.

**Not re-reviewed, because not migrated:** authentication flow, authorization, audit, session
management, rate limiting, CSP, CSRF, tenant isolation, permission enforcement. All remain on
their existing local implementations.

---

## 7. Performance comparison

| Metric | Value |
| --- | --- |
| Cold build | 59 s |
| Cold test | 21 s |
| `apps/api/dist` | 13 MB |
| pnpm store entries | 477 |

No before/after delta is reported, and inventing one would be worse than omitting it: the
pre-migration baseline was measured on a machine that also had `pnpm.overrides` pointing at local
tarballs, so the two numbers are not comparable. These are the figures to compare against for
Stage 2 onwards.

Runtime cost of the migrated paths is unchanged by construction — the same scrypt parameters and
the same Redis round trips. `compareAndSet` adds one Lua evaluation on the token-bucket path only,
measured at 1.05× in platform benchmarks.

---

## 8. Platform compliance score

**26 / 100** (was 18 before this phase).

| Dimension | Weight | Score | Basis |
| --- | --- | --- | --- |
| Capabilities migrated | 40 | 9 | 3 of ~14, one of them partial |
| Duplication removed | 20 | 4 | 348 lines of ~30,000 |
| Adapters implemented | 15 | 4 | 1 of ~9 ports |
| Conformance proven | 10 | 8 | The adapter that exists passes fully, against real infrastructure |
| No temporary workarounds | 10 | 10 | No overrides, tarballs, links or local paths; one documented compatibility shim with a defined exit |
| Deployable | 5 | 5 | Installs, builds and tests from the registry alone |

The score is low because the phase is early, not because the completed work is weak. Everything
finished is green, proven against published artifacts, and I would ship it.

---

## 9. Production readiness report

**Not production ready. Do not deploy.**

What is ready: the repository installs, builds and tests entirely from published GitHub Packages
with no local resolution of any kind. The two migrated capabilities are verified, behaviour-
preserving, and in the cache's case strictly more capable than what they replaced.

What is not:

1. **The integration suite has never been run against the migrated code.** 33 files, PostgreSQL
   required. This is the largest evidence gap and blocks any deployment.
2. **Eleven of fourteen capabilities are unmigrated**, so Docs still carries its own authentication,
   authorization, audit, session, security, logging, configuration and notification
   implementations. Success criteria for this phase are not met.
3. **The audit chain is blocked on platform work** (P-1). Munaxa School and Munaxa Work will hit
   the same wall; it is worth fixing in the platform before their migrations begin rather than
   three times over.

### Recommended next steps, in order

1. Run the integration suite against PostgreSQL and close the evidence gap.
2. Finish Stage 1 — configuration and logging are self-contained and low-risk.
3. Stage 2 in this order: security headers and rate limiting (declarative, isolated), then RBAC,
   then session — session must land with either `SessionStorePort.createWithinLimit` or a
   `LockPort`, or `limitEnforcement` reports `best-effort` and the concurrency limit is a hint.
4. Resolve platform P-1 before attempting audit.
5. Stage 3 last: authentication is the highest-risk surface and should follow, not precede, the
   foundations it depends on.
