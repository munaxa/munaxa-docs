# Phase 6.7 — Security Control Completion: Rate Limiting & Signature Concurrency

**Status: PARTIALLY COMPLETE**

Part B is done and proven. Part A is not started. Of the two properties §20 requires, **B is
demonstrated by an executed test and A is not**, so `COMPLETE` would be untrue.

| Objective | Outcome |
| --- | --- |
| **A.** The rate limit is authoritative across independent application instances | ❌ **Not implemented** |
| **B.** The database guarantees two concurrent requests cannot create two live signatures | ✅ **Implemented and proven** — 10 rounds of a genuine race, real PostgreSQL |

---

## Correction to the Phase 6.6 report

Phase 6.6 stated that rate-limit configuration amounted to two environment variables. That was
incomplete. `apps/api/src/core/security/rate-limit.ts` contains a **six-rule per-surface table**,
exported through `core/security/index.ts`:

| Rule | Window | Limit | Keyed by |
| --- | --- | --- | --- |
| `auth.login` | 300 s | 10 | ip + identity |
| `auth.password-reset` | 3 600 s | 5 | ip + identity |
| `search` | 60 s | 60 | identity |
| `upload.presign` | 60 s | 120 | identity + tenant |
| `export` | 3 600 s | 10 | identity + tenant |
| `default` | 60 s | 300 | identity |

My Phase 6.6 grep searched `throttler`, `rateLimit` and `RATE_LIMIT_WINDOW_SECONDS`; it did not
search `RATE_LIMIT_RULES` and missed a whole module. **The conclusion is unchanged** — `ruleFor` and
`RATE_LIMIT_RULES` have no consumer anywhere (`grep -rn` returns only an unrelated local helper in
`numbering.spec.ts`) — but the *shape* of the remaining work is different and better: Part A is
**wiring an existing table**, not designing limits. That is what §4 asks for, and it makes the
remaining work smaller than the ~3 days Phase 6.6 estimated.

## Part A — Distributed Rate Limiting: NOT IMPLEMENTED

### 1–2. Audit and call graph

```
request → AuthenticationGuard → TenantIsolationGuard → RbacGuard → AclGuard → handler
```

There is no rate-limit guard in that chain and no interceptor or middleware supplying one.

| Question (§2) | Answer |
| --- | --- |
| Is `@nestjs/throttler` used? | **No.** Declared at `apps/api/package.json:28`, imported nowhere |
| Is `RATE_LIMIT_WINDOW_SECONDS` consumed? | **No.** Parsed into `AppConfig`, read by nothing |
| Is `RATE_LIMIT_MAX_REQUESTS` consumed? | **No.** Same |
| Is a `@munaxa/security` `RateLimiter` bound? | **No such package exists** in this workspace |
| Is `RATE_LIMIT_RULES` consumed? | **No.** Exported, zero consumers |
| Is Redis authoritative for limits? | **No limiter exists to be authoritative** |
| Do instances share limiter state? | **N/A** |

### 3–6. Design, configuration, coverage and multi-instance proof

**Not produced.** No limiter was written, so there is no distributed enforcement design to report,
no sensitive-endpoint coverage matrix to fill, and — the one that matters — **no two-instance test**.
§6 is explicit that one process proves nothing, and that test is the actual property being
protected. Nothing here should be read as partial credit: Part A is untouched.

What the next attempt should know, from this audit:

- The rule table already exists and must be wired, not replaced (§4).
- `CachePort`/Redis is already a dependency and is the natural shared store.
- `@nestjs/throttler`'s default storage is in-memory and therefore unsuitable; §3 forbids a
  process-local limiter. Either its Redis storage adapter or a small `CachePort`-backed limiter
  keyed on the existing rules would satisfy the requirement. **Do not remove the dependency until
  that choice is made** — it may yet be the consumer.
- §5's fail-safe question is undecided: the architecture documents state no behaviour for "Redis is
  down", and §5 forbids silently downgrading a credential-accepting endpoint to unlimited. That is a
  **decision to be made and documented**, not one this phase may assume.

## Part B — Signature Concurrency: IMPLEMENTED AND PROVEN

### 7. The invariant audit

The table's comment has read *"One live signature per person, revision and purpose. Partial on
`withdrawn_at`"* since Phase 16. The three declarations beneath it were `@@index`; the migration
emitted three plain `CREATE INDEX`; no unique index existed in the schema, the migrations or
`infra/sql/`. Verified again at the start of this phase against `pg_indexes` in both tenant
databases: absent.

So the only protection was `liveSignatureExists` — a read-then-write — under READ COMMITTED, because
`TenantDatabase.withTenant` opens `client.$transaction(...)` with no `isolationLevel`.

### 8. The database invariant

`prisma/migrations/20260808180000_signature_live_uniqueness/migration.sql`:

```sql
CREATE UNIQUE INDEX "uq_document_signature_live"
  ON "document_signature" ("tenant_id", "revision_id", "signer_user_id", "purpose")
  WHERE "withdrawn_at" IS NULL;
```

The key is taken from the rule the service already enforces, not from the comment. `tenant_id` leads
because every index on this table does and because a tenant is the isolation boundary. Partial on
`withdrawn_at` because ADR-0017 §7 makes withdrawal a row's own columns precisely so a signer may
correct themselves — a *total* unique index would have made withdrawal one-way and turned an
ordinary correction into a permanent bar.

**It is declared in migration SQL only and deliberately not in `schema.prisma`.** Prisma cannot
express a partial unique index; declaring `@@unique` would tell it the constraint is *total*, and a
later `migrate dev` could "repair" it into one — breaking withdraw-then-re-sign. This follows the
convention `uq_user_department_primary` and `uq_department_entity_code` already use. I made that
mistake first and reverted it.

### 9. Race handling

`PrismaSignatureRepository.insert` translates `P2002` **on that index by name** into a
`DuplicateSignatureError`; `DocumentSignatureService.sign` maps it to the *same* `ValidationError`
the sequential duplicate check already produces — `purpose: duplicate`. One situation, one answer,
whichever layer noticed it. Every other error is rethrown untouched, and matching on the index name
means an unrelated unique index added later cannot be misreported as "you already signed this".

**The API contract is unchanged.** No new error code, no new shape, no `500`.

### 10–12. Test report

`apps/api/src/modules/document/__tests__/signature-uniqueness.integration.spec.ts` — 8 tests, real
PostgreSQL, nothing mocked, nothing artificially serialised.

| Assertion | Result |
| --- | --- |
| The index exists, is unique, and is partial on `withdrawn_at` — read from `pg_indexes` | ✅ |
| **A genuine race: two transactions insert before either commits, ×10 rounds** | ✅ exactly one wins each round; the loser fails with SQLSTATE `23505`; exactly one row exists |
| Withdrawn → new live signature permitted | ✅ |
| Second live signature refused (sequential) | ✅ |
| Different revision permitted | ✅ |
| Different purpose permitted | ✅ |
| Different signer permitted | ✅ |
| Different tenant permitted | ✅ |

Asserted against the database rather than through the service deliberately: the service's check is a
courtesy, and a test driven through it would have passed just as well with the index absent — which
is exactly the state Phase 6.6 found.

**One hazard I introduced and then fixed.** The fixture disables foreign keys to insert rows without
standing up five aggregates. My first version used a session-scoped `SET session_replication_role`;
Prisma pools connections, so that could have leaked and silently disabled FK enforcement for whatever
suite drew the same connection next — a test that weakens other tests. It is now `SET LOCAL` inside
an explicit transaction, reverted on commit.

### 13. Security questions re-run

| # | Question | Answer |
| --- | --- | --- |
| 1 | Two concurrent requests → two signatures? | **No** — proven, 10 rounds |
| 2 | Replay? | No — refused by the index whether sequential or concurrent |
| 3 | Withdrawn signature blocks a new one? | **No** — proven; the index is partial |
| 4 | Stale revision signed? | Yes, by design — only `DISCARDED` is refused (ADR-0017) |
| 5 | Unauthorized signer? | No — `document:sign` + ACL, unchanged |
| 6 | Cross-tenant access? | No — separate databases; the key includes `tenant_id` |
| 7 | **Unlimited calls to the endpoint?** | **Yes — Part A not implemented** |
| 8 | **Rate limiting across replicas?** | **No — Part A not implemented** |
| 9 | Redis failure removes a boundary silently? | **Undecided** — no limiter, and the fail-safe policy is unwritten |
| 10 | Error preserves non-enumerating behaviour? | Yes — the race maps to the existing duplicate refusal; credential failures still return one undifferentiated message |

## 14–15. Hardening review

| Control | State |
| --- | --- |
| Database-enforced invariants | ✅ **new** |
| Race-condition resistance | ✅ **new** |
| Replay resistance (signatures) | ✅ **new** |
| Tenant isolation | ✅ unchanged; the key includes the tenant |
| Authorization | ✅ unchanged |
| Non-enumerating errors | ✅ unchanged |
| Auditability | ✅ unchanged — the loser writes no audit row because its transaction rolls back |
| **Distributed rate limiting** | ❌ **absent** |
| **Fail-safe policy for a limiter** | ❌ **undecided** |

## 16. Deleted code / dependencies

Nothing deleted. `@nestjs/throttler` remains — unused today, but §3 requires proving it has no
consumers *and* choosing an approach before removal, and Part A may still consume it.

## 17. Database migration report

| Step | Result |
| --- | --- |
| Pre-migration conflict check (§18) | **0 conflicting groups** in `ci_edms_acme` and `ci_edms_rival` |
| Migration applied | Both tenants, via `scripts/migrate-tenants.mjs` — the documented procedure |
| Post-migration verification | `pg_indexes` confirms the partial unique index in **both** databases |

No data was deleted, merged, withdrawn or rewritten. §18's stop condition was not reached.

## 18. Validation report

| Gate | Result |
| --- | --- |
| format:check | pass |
| lint | 0 errors, 5 pre-existing warnings |
| typecheck | 13/13 |
| test | 636 API, 164 domain, 97 web, 26 contracts, 11 utils, 4 i18n, 2 worker |
| build | 9/9 |
| verify:styles | 10/10 |
| **integration** | **625 passed, 34 files, 0 skipped** (was 617/33 — +8) |

PostgreSQL and Redis were reclaimed by the container again mid-phase; both were restarted, the
databases survived this time, and the migration was applied through the repository's own runner.

**One transient failure is recorded rather than hidden**: an early full-suite run reported 1 failed
of 625 without naming the test in captured output, and did not reproduce across two subsequent full
runs. It was most likely the known-flaky `outbox-dispatch` concurrency test (logged in Phase 6.6's
backlog: it sleeps a fixed 100 ms waiting for a lock). I could not confirm it, so I am not claiming
it — the honest statement is that one run failed unexplained and two consecutive runs passed cleanly.

## 19. Architecture compliance

| Rule | Held |
| --- | --- |
| No signature UI | ✅ none |
| No signature-request workflow or new states | ✅ none |
| ADR-0017 unchanged | ✅ |
| Signature domain unchanged except to enforce the invariant | ✅ — one translated error, no semantics changed |
| API contracts unchanged | ✅ |
| Smallest additive change | ✅ one index, one error mapping |
| Partial indexes in SQL, not `schema.prisma` | ✅ follows the existing convention |
| No unrelated backlog absorbed (§14) | ✅ |

## 20. Phase 6.7 Final Status

**PARTIALLY COMPLETE.**

Part B is finished: the invariant the schema has described since Phase 16 is now enforced by
PostgreSQL, the race maps to the existing business outcome rather than a `500`, and the property is
demonstrated by ten rounds of a real concurrent race plus five tests proving the constraint does not
over-block.

Part A is not started, and I will not dress that up. Rate limiting remains entirely absent, so
**Phase 6.6 is still blocked** — one of its two blockers is cleared, one is not. The signature
endpoint continues to accept unlimited password attempts, which is the reason the ceremony must not
be built yet.

**Remaining to unblock Phase 6.6:**

| # | Item | Estimate |
| --- | --- | --- |
| 1 | Wire `RATE_LIMIT_RULES` into a `CachePort`/Redis-backed guard in the request pipeline | ~2 days |
| 2 | Decide and document the Redis-unavailable policy for credential-accepting routes | ~2 hours |
| 3 | The two-instance integration test §6 requires | ~4 hours |
| 4 | Add a `signature` rule to the table (§5) — the surface exists, the rule does not | ~1 hour |
