# P4 — Munaxa Docs platform migration report

**Status: incomplete. Two of ten areas migrated and verified; one assessed and blocked; seven
assessed but not executed.**

That headline is the most important line in this document. The phase brief asked for ten
cross-cutting areas to be migrated across a 115,000-line application, and what follows is an
honest account of what was actually done, what was found, and what remains — not a summary
written as though the whole brief landed.

Everything reported as done was run. Nothing here is asserted from reading alone.

---

## 1. Migration report

### What was migrated

| # | Area | Platform package | State |
| --- | --- | --- | --- |
| 1 | Password hashing | `@munaxa/crypto` | **Migrated and verified.** Local scrypt implementation deleted. |
| 2 | Cache | `@munaxa/interfaces` + `@munaxa/conformance` | **Conformant adapter added and verified** against real Redis. |

### What was assessed and deliberately not migrated

| # | Area | Finding |
| --- | --- | --- |
| 3 | Audit chain | **Blocked.** Migrating it would invalidate every historical audit record. See §5. |

### What was assessed but not executed

| # | Area | Assessment |
| --- | --- | --- |
| 4 | Auth — tokens | Migratable. HS256 JWT written on `node:crypto`; `TokenService` is a direct replacement. |
| 5 | Auth — refresh/sessions | Migratable with an **additive** schema migration. See §7. |
| 6 | RBAC | Not assessed in depth. `core/authorization` is 826 lines over 12 files. |
| 7 | Security headers / rate limiting | Migratable. Local rules are declarative and map onto `RateLimitRule`. |
| 8 | Logging | Not assessed in depth. `core/observability` is 993 lines and includes metrics, which the platform does not own. |
| 9 | Notifications | Not assessed in depth. 6,396 lines, heavily product-shaped (digests, quiet hours). |
| 10 | Configuration | Not assessed in depth. `core/config` is 1,616 lines. |

Areas 6–10 were not opened beyond sizing. They are listed so the remaining work is visible, not
because anything is known about their difficulty.

---

## 2. Components migrated

**`ScryptPasswordHasher` → `PlatformPasswordHasher`.**
`apps/api/src/modules/identity/infrastructure/platform-password.hasher.ts` delegates to
`PasswordHasherRegistry` from `@munaxa/crypto`. Munaxa Docs no longer implements scrypt.

Two things stayed local, both because the platform cannot know them:

- **The cost parameters.** The platform defaults to N=2¹⁴ (~16 MiB). Munaxa Docs committed to
  OWASP's N=2¹⁷ (~128 MiB) and every stored hash records it. They are passed explicitly, so
  neither the security posture nor the login latency moved. Taking the platform default would
  have silently weakened every password written after the migration — a regression that no test
  would have caught, because a weaker hash verifies just fine.
- **The pre-migration hash format.** Covered in §7.

**Redis `CachePort`.** `apps/api/src/infrastructure/cache/platform-redis-cache.adapter.ts`
implements the platform's `CachePort` — an addition rather than a replacement, since the existing
`RedisCacheAdapter` still serves Docs' own narrower `CachePort`. Both are live; consolidating them
is follow-up work.

---

## 3. Components removed

| Removed | Lines | Replaced by |
| --- | --- | --- |
| `modules/identity/infrastructure/scrypt-password-hasher.ts` | 160 | `@munaxa/crypto` `ScryptPasswordHasher` + `PasswordHasherRegistry` |
| `modules/identity/infrastructure/scrypt-password-hasher.spec.ts` | 66 | `platform-password.hasher.spec.ts`, which keeps every original assertion and adds legacy-compatibility cases |

Net: 226 lines of security-critical cryptography deleted from the product; 128 lines of
verify-only compatibility shim added, on a path to deletion (§7).

This is a small number, and it should be read as such. It is one of ten areas.

---

## 4. Platform packages consumed

Declared in `apps/api/package.json` at `^2.0.0`:

`@munaxa/audit`, `@munaxa/auth`, `@munaxa/cache`, `@munaxa/config`, `@munaxa/crypto`,
`@munaxa/interfaces`, `@munaxa/logging`, `@munaxa/notifications`, `@munaxa/rbac`,
`@munaxa/security`, `@munaxa/session`, `@munaxa/types`, and `@munaxa/conformance` as a
devDependency.

**Only `@munaxa/crypto`, `@munaxa/interfaces` and `@munaxa/conformance` are actually imported
today.** The rest are declared ahead of the areas that will use them. If the remaining migration
is deferred, the unused entries should be removed rather than left as a promise the code does not
keep.

---

## 5. Remaining local implementations, with justification

### 5.1 The audit hash chain — blocked, and correctly so

`core/audit/hash-chain.ts` and `modules/audit/infrastructure/chained-audit.writer.ts` stay local.
Three independent reasons, any one of which is sufficient:

**Historical records cannot be rehashed.** Munaxa Docs is on its *third* versioned digest
(`CHAIN_HASH_V1`, `V2`, `V3`). Rows carry the version they were written under and are verified
against that field set, because the audit table refuses `UPDATE` to every role including the
owner — which is precisely the property that makes the trail evidence. The platform's
`canonicalize` is a single frozen form over its own `SecurityEvent` shape. Adopting it would make
every historical record fail verification, and a failing chain is not a cosmetic problem: it is
the tamper alarm firing.

**The sequence is a `bigint`.** Docs allocates `tail.sequence + 1n`. The platform's `AuditRecord`
types `sequence` as `number`, capping at 2⁵³.

**The audit row must commit inside the business transaction.** `ChainedAuditWriter.write()`
refuses to run outside an ambient transaction, so there is no window in which a document changed
and the trail does not say so. The platform's `AuditService` writes through its repository
independently of any caller transaction. Migrating would *weaken* a compliance guarantee.

Worth noting: Docs' writer already implements the pessimistic strategy the platform's
`appendChained` documents as conformant — a per-tenant advisory lock taken in the recording
transaction. The two designs agree on the hard part. They disagree on encoding and on types.

Per the phase brief, this is documented as a Platform follow-up rather than worked around here.
See §12.

### 5.2 `LegacyScryptVerifier` — temporary by construction

`modules/identity/infrastructure/legacy-scrypt.verifier.ts`, 128 lines. Docs wrote
`scrypt$N$r$p$salt$hash`; the platform writes PHC `$scrypt$v=1$n=…$`. Every credential row in
every tenant is in the old format, so deleting this class is a mass lockout rather than a cleanup.

It is verify-only — `hash()` rejects — so nothing new can be written in the old format, and
`needsRehash` returns true for all of it. The existing upgrade-on-sign-in path in
`DefaultAuthenticationService` rewrites each row the next time its owner signs in. Once no
`scrypt$` rows remain, unregister it and delete the file.

### 5.3 Metrics, and everything in §1's rows 6–10

`core/observability` includes a Prometheus metrics registry and sampler. The platform owns
logging, not metrics, so that part stays regardless. The rest of rows 6–10 remain local simply
because the work was not done.

---

## 6. Adapter implementations

| Adapter | Port | Verified by |
| --- | --- | --- |
| `PlatformRedisCacheAdapter` | `CachePort` (`@munaxa/interfaces`) | `runCacheConformance` against a real Redis — 13/13 |
| `PlatformPasswordHasher` | Docs' `PasswordHasher` | `platform-password.hasher.spec.ts` — 13 tests |
| `LegacyScryptVerifier` | `PasswordHasher` (`@munaxa/crypto`) | Same spec, legacy-format cases |

**Not yet implemented:** `AuditRepositoryPort`, `SessionStorePort`, `RefreshTokenStorePort`,
`ResetTokenStorePort`, `LockPort`, `NotificationTransportPort`, `RoleRepositoryPort`,
`RoleAssignmentPort`, `UserDirectoryPort`.

### The conformance suite earned its place immediately

It failed on first run, and it was right to. `clear()` double-prefixed keys: ioredis applies
`keyPrefix` to `del` but *not* to `SCAN MATCH`, so scanned keys came back fully qualified and were
prefixed again on delete. Prefix invalidation silently deleted nothing.

That bug would not have been caught by any sequential test, and the failure mode is a permission
cache that never invalidates — stale authorization decisions served indefinitely after an ACL
change. It was found in the first ten minutes of using the adapter, by a suite the product did not
have to write.

---

## 7. Compatibility notes

**Password hashes — compatible, verified.** Legacy `scrypt$…` rows verify through the registry;
new hashes are PHC at N=2¹⁷; `needsRehash` is true for every legacy row so the estate migrates on
sign-in. Proven directly: a hash written in the old format verified `true` for the right password
and `false` for the wrong one.

**The no-such-account timing defence — preserved, measured.** The decoy hash is emitted in the
platform's encoding so that verifying it runs a full derivation. Measured 410 ms against 409 ms
for a real verification. Had the decoy failed to parse, `verify` would have returned in
microseconds and the sign-in endpoint would have gone back to answering "does this address have an
account?" with a stopwatch. There is a regression test for this.

**Database — untouched.** No schema migration was required or written. No audit record, credential
row or session row changed shape.

**Refresh tokens — additive migration when that area is done.** `RefreshToken.usedAt` is the
platform's `rotatedAt` under another name, and `familyId` matches. Missing: `replaced_by`,
`token_version`, and a token-level `revoked_at`. The platform's `markRotated` compare-and-swap maps
onto `UPDATE … WHERE used_at IS NULL`, which the existing unique index on `token_hash` already
supports. Additive columns, no data rewrite.

---

## 8. Breaking changes

**None.** No public API, database schema, cookie, event name or configuration key changed. The
only externally visible difference is the encoding of newly written password hashes, which is
internal to the credential store and read only by the hasher.

---

## 9. Test results

Baseline taken before any change, on the same machine, same commit:

| Gate | Baseline | After migration |
| --- | --- | --- |
| `pnpm install` | pass | pass |
| `pnpm typecheck` | 13/13 tasks | 13/13 tasks |
| `pnpm test` | 842 passed, 1 skipped | **859 passed, 1 skipped** |
| `pnpm lint` | 0 errors, 3 warnings | 0 errors, 5 warnings |
| `pnpm build` | 9/9 tasks | 9/9 tasks |

Per package after migration: api 631 (+1 skipped), domain 164, contracts 26, web 21, utils 11,
i18n 4, worker 2 — 859 total.

**+17 tests, 0 regressions.** All 842 baseline tests still pass. The increase is 13 cache
conformance tests plus a password-hasher spec that grew from 8 assertions to 13 while replacing
the 8 retired with the deleted implementation.

The 2 additional lint warnings are in `apps/web` and pre-date this work; they surfaced because
`turbo` cached the earlier run. Zero errors throughout.

**Not run: the integration suite.** 33 `*.integration.spec.ts` files need a live PostgreSQL, which
this environment does not have. Redis was started locally, which is why the cache conformance
suite could run for real. The integration suite must be run before any of this ships — several of
its files were edited (the `ScryptPasswordHasher` → `PlatformPasswordHasher` rename), and although
they typecheck, they have not been executed.

---

## 10. Production readiness report

### Environment blockers — both must be cleared before this can ship

**The platform is not published.** `@munaxa/auth` and its twelve siblings return **404** from
`npm.pkg.github.com`. Platform 2.0.0 exists only as source on an unmerged branch
(`claude/shared-security-platform-p1-tknut1` in `munaxa-platform`). Until it is merged and
published, `pnpm install` in this repository cannot resolve the dependencies this migration
declares, and CI will be red.

**No registry credential in this environment.** Even the design-system packages
(`@munaxa/ui`, `@munaxa/tokens`, …) return **401** — no token with `read:packages`.

Validation was therefore performed against locally built tarballs (`pnpm pack`, which resolves
`workspace:` into real version ranges, so they behave as published artifacts) wired in through
`pnpm.overrides`. **Those overrides are not committed.** `apps/api/package.json` declares ordinary
`^2.0.0` ranges, which is what production needs. The consequence is stated plainly: the committed
state is production-shaped but was validated with a different resolution source, and
`pnpm-lock.yaml` was deliberately left uncommitted because the local lockfile references
`/tmp` paths. It must be regenerated after publication.

### Platform runtime requirements

| Requirement | State |
| --- | --- |
| Shared cache available | **Met.** `PlatformRedisCacheAdapter` verified against real Redis. |
| Adapter conformance | **Partially met.** Cache passes 13/13. No other adapter exists yet. |
| `MfaService.replayGuard` wired | **Not met.** MFA has not been migrated. |
| `OtpService.cache` wired | **Not met.** |
| `NotificationService.dedupeStore` wired | **Not met.** |
| Session limit: `createWithinLimit` or `LockPort` | **Not met.** Sessions have not been migrated. |
| Startup diagnostics logging enforcement modes | **Not met.** Nothing to report yet. |

The P3 report made adoption conditional on the shared cache and session locking being wired. The
cache half is now demonstrably true. The session half is not, because that area was not migrated.

---

## 11. Platform compliance score

**18 / 100.**

| Dimension | Weight | Score | Basis |
| --- | --- | --- | --- |
| Areas migrated | 40 | 8 | 2 of 10, and one of those is additive rather than a replacement |
| Local duplication removed | 20 | 3 | 226 lines of ~30,000 overlapping |
| Adapters implemented | 15 | 3 | 1 of ~9 |
| Conformance proven | 10 | 7 | The one adapter that exists passes fully, against real infrastructure |
| Behaviour preserved | 10 | 10 | 859 tests, zero regressions, timing defence measured |
| Deployable today | 5 | 0 | Dependencies are unpublished |

Scoring the work that was done as though it were the work that was asked for would make this
document useless. The number is low because the phase is largely unstarted, not because the
completed parts are weak — those are green, proven, and I would ship them.

---

## 12. Recommendation

**Do not deploy. Continue the migration.**

This is not a no-confidence verdict on the platform. Both migrated areas came out cleanly, the
platform's compatibility mechanisms (`PasswordHasherRegistry`) turned out to be exactly what a
real product needed, and the conformance suite found a genuine bug within minutes. The approach is
working. It is simply 20% done.

### Required before any deployment

1. **Merge and publish Platform 2.0.0** to GitHub Packages, then regenerate `pnpm-lock.yaml`
   against the published versions. Nothing else can proceed past CI.
2. **Run the integration suite** against PostgreSQL. 33 files, several edited here, none executed.
3. **Finish, or explicitly descope, areas 4–10.** Suggested order — refresh tokens and sessions
   first (schema migration is additive and the P3 conditions depend on them), then security
   headers and rate limiting (self-contained), then RBAC, logging, config and notifications.
4. **Remove the unused platform dependencies** if the remaining areas are deferred, so
   `package.json` stops claiming a migration that has not happened.

### Platform follow-ups discovered

Filed as platform work rather than worked around here, per the phase brief:

- **P-1 — `AuditRepositoryPort` cannot express Docs' chain.** Needs `bigint` sequences, a
  pluggable canonical form so a product's historical digests keep verifying, and a way for
  `appendChained` to join the caller's ambient transaction. Without all three, no product with an
  existing audit history can adopt the platform's chain. This is likely to block Munaxa School and
  Munaxa Work identically.
- **P-2 — `PasswordHasher` has no synchronous decoy.** `dummyPasswordHash` is async; products with
  a synchronous port must hand-assemble a decoy in the platform's encoding, and a mistake there
  silently removes a timing defence rather than failing. The platform should expose a
  `decoyHash()` that is guaranteed to parse.
- **P-3 — `CachePort` has no prefix invalidation.** `clear(namespace)` is optional and coarse;
  Docs invalidates the permission cache by prefix on every ACL change. Every adapter will
  reimplement the SCAN loop, including the `keyPrefix` trap documented in §6.
