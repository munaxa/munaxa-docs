# Phase 0.5 — Architecture Gate Verification

**Purpose:** an independent re-audit of the Phase 0.5 architecture gate. The
[compliance report](./phase-0.5-architecture-compliance-report.md) was authored in the same
commit as the skeleton it assesses (`ae9ebd1`), so it is a self-review. This document is the
second pair of eyes the gate needs: every falsifiable claim in that report re-derived from the
repository, by someone who did not build it.
**Audience:** the architecture owner, and whoever signs off Phase 1.
**Scope:** `munaxa-docs` at `ae9ebd1`, plus `munaxa-platform` at `de8a5b5` for the reuse claims.
**Method:** direct inspection and command execution. No claim below rests on the report it checks.
**Date:** 2026-08-03. Point-in-time evidence — historical once Phase 1 begins.

---

## Verdict

**The compliance report is materially accurate, and its verdict stands: READY AFTER MINOR FIXES.**

Of the claims re-derived below, **every structural, architectural and security claim held**. One
count is off by one, and five build-gate claims cannot be re-verified in an environment without a
`read:packages` credential — a limitation of this audit, not a defect found. No claim was found to
be overstated in the direction that matters: the report is candid about its own weaknesses, and
its two open risks (R1, R2) both reproduce exactly as described.

| | |
| --- | --- |
| Claims re-derived | 41 |
| Confirmed | 35 |
| Discrepancies found | 1 (immaterial — see D1) |
| Not verifiable in this environment | 5 (see §Limitations) |
| **New blockers found** | **None** |

---

## 1. Executive summary — verified

| Report claim | Method | Result |
| --- | --- | --- |
| 197 TypeScript files | `find apps packages -name '*.ts' -o -name '*.tsx'` | **197** ✓ |
| 3 applications, 4 packages | `ls apps packages` | `api`, `web`, `worker`; `contracts`, `domain`, `i18n`, `utils` ✓ |
| Zero business features | Module tree carries `application/ports.ts` + `domain/events.ts` only; no `infrastructure/` or `presentation/` implementations outside `core/` | ✓ |
| Zero TODOs / placeholders | `grep -rIn 'TODO\|FIXME\|XXX'` over `apps packages prisma infra` | **0 hits** ✓ |

The claimed readiness figure of 92% is a judgement, not a measurement, and is not re-derivable.
It is consistent with the checklist in §24 (33 PASS, 1 FAIL, 1 BLOCKED).

---

## 2. Repository analysis — verified

Structure matches the report's tree exactly: `apps/{api,web,worker}`, `packages/{contracts,domain,i18n,utils}`,
`prisma/schema.prisma`, `infra/{docker-compose.yml,sql/}`, `docs/{architecture,reports}`.

**Reuse claims confirmed against `munaxa-platform`.** The platform repository publishes
`@munaxa/{ui,theme,tokens,icons,utils,platform}` from `packages/*` and
`@munaxa/config-{eslint,typescript}` from `tooling/*`. Munaxa Docs consumes them and does not
copy them:

| Claim | Evidence |
| --- | --- |
| tsconfig extends the platform's | `apps/api/tsconfig.json` → `@munaxa/config-typescript/nestjs.json`; web → `nextjs.json`; worker → `nestjs.json` ✓ |
| ESLint extends the platform's | `apps/{api,worker}/eslint.config.mjs` → `@munaxa/config-eslint/nest.js`; web → `next.js` ✓ |
| Theme is the only visual difference | `apps/web/src/app/globals.css:2` → `@import '@munaxa/theme/css/docs'` ✓ |
| Products cannot reach past the public surface | `apps/web/eslint.config.mjs:27` bans `@munaxa/platform` and `@munaxa/platform/*` by rule ✓ |
| Nothing copied in | No `@munaxa/*` source vendored anywhere in the tree ✓ |

"Unused components: none" and "duplicate components: none" were spot-checked rather than
exhaustively re-derived; the one candidate the report names (paging in both `@edms/utils` and
`@edms/contracts`) is as described — runtime helper vs wire schema.

---

## 3. Clean Architecture validation — verified

The report's central claim is that the dependency rule is **enforced, not described**. It is.
`apps/api/eslint.config.mjs` carries four `no-restricted-imports` blocks, and they say what the
report says they say:

| Scope | Rule | Line |
| --- | --- | --- |
| `src/modules/*/domain/**` | bans `@nestjs/*`, `@prisma/*`, `prisma`, `express`, `ioredis`, `bullmq`, and all layers above | 32–46 |
| `src/modules/*/application/**` | bans persistence libraries, `../infrastructure/**`, `../presentation/**` | 53–67 |
| `src/modules/**` | bans another module's internals | 74–83 |
| `src/core/**`, `src/ports/**` | bans `modules/**` at every depth | 91–100 |

**Layer violations found: none**, independently. **Circular dependencies: none** — the module
graph has no cycle among solid edges, and `core/` importing no module is enforced above rather
than asserted.

**Business logic in infrastructure: none.** `src/infrastructure/` contains exactly four files —
a clock, a Redis cache, the module, and the unconfigured adapters. Nothing else.

---

## 4. DDD validation — verified

15 modules, one per context, each with `application/ports.ts` and `domain/events.ts`:
`administration, audit, dashboard, document, identity, library, notification, organization,
preview, reporting, retention, revision, search, storage, workflow` ✓.

The report's mapping of the brief's **Security** capability onto `core/` rather than a module is
sound and is the correct call: a security module owning authentication, tenancy, RBAC and audit
writing would be imported by every other module, which inverts the dependency direction the rest
of the design is built to protect.

`@edms/domain` carries **35 permissions** and **8 roles** (`TENANT_ADMIN, DOCUMENT_CONTROLLER,
LIBRARY_MANAGER, AUTHOR, APPROVER, READER, AUDITOR, GUEST`) — both counts confirmed ✓.

---

## 5. Module dependency graph — verified

**56 domain event payload interfaces across 14 modules** (`dashboard` publishes none, by design —
it owns no data) ✓. The acyclicity argument holds on inspection: every upward edge in the graph is
an event delivered through the outbox, not a call.

The report's forward-looking warning about Reporting is worth carrying into Phase 15 unchanged.

---

## 6. Interface coverage — verified

**9 port files** (plus an `index.ts` barrel), declaring **12 port interfaces** —
`AntivirusPort, CachePort, LockPort, ClockPort, NotificationPort, OcrPort, PreviewPort,
RendererRegistry, QueuePort, SearchPort, IndexPort, StoragePort` — exactly as claimed ✓.

Spot-checked for vendor leakage: no `S3`, `Tesseract`, `Bucket` or `ContainerClient` type appears
in any port signature ✓.

**Fail-closed defaults confirmed by reading the implementations, not the report:**

- `DenyAllAclResolver.resolve()` returns `{ allowed: false, reason: 'CLOSED_BY_DEFAULT' }`, and —
  the detail that matters — `visibilityFilter()` returns `unrestricted: false` with an empty
  subject set, so a query built from it matches **nothing** rather than omitting the predicate and
  matching everything. That is the failure mode this pattern usually gets wrong.
- `NoIssuerTokenVerifier.verify()` rejects unconditionally with `UnauthenticatedError` ✓.
- `UnconfiguredStorageAdapter` and its four siblings throw `ProviderNotConfiguredError` naming the
  variable that would fix them ✓.

---

## 7–8. Repository and service layers — one discrepancy

| Claim | Re-derived | Result |
| --- | --- | --- |
| 37 repository interfaces across 15 modules | 37 | ✓ |
| 22 application service interfaces | **21** | **D1 — off by one** |

**D1.** `grep -hoE 'export interface [A-Za-z]+Service' apps/api/src/modules/*/application/ports.ts`
returns 21: `Administration, Approval, Audit, Dashboard, Delegation, DocumentQuery, Document,
LegalHold, Library, Notification, Numbering, Organization, Permission, Preview, Reporting,
Retention, Revision, Search, Storage, User, Workflow`. The compliance report states 22 in both §8
and checklist item 8.

Immaterial: it changes no boundary, contract or verdict, and the checklist item passes either way.
Recorded because a compliance report's numbers should be reproducible.

The ambient-transaction design (`core/prisma/unit-of-work.ts`, `requireTransaction()` throwing
when no transaction is active) is confirmed present, and the report's defence of it is correct —
it is what lets `application/` declare persistence contracts without importing Prisma, which is
in turn what makes the §3 lint rule enforceable rather than aspirational.

---

## 9. Database readiness — verified

`prisma/schema.prisma` models exactly four tables — `Tenant`, `AuditEvent`, `OutboxMessage`,
`IdempotencyKey` — plus four enums (`TenantStatus`, `AuditOutcome`, `AuditSubjectType`,
`ActorChannel`) ✓. Soft delete present on `tenant`, deliberately absent from `audit_event` ✓.

`prisma/` contains **no `migrations/` directory** — R2 confirmed ✓.

---

## 10. Multi-tenant validation — verified

All five isolation layers exist as files, and the deepest one is the one that matters:

`infra/sql/01-roles-and-rls.sql` creates `edms_app` with **`NOBYPASSRLS`** (line 24), enables both
`ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY` on every tenant-scoped table, and creates a
`tenant_isolation` policy with a `WITH CHECK` clause keyed on `current_tenant_id()` (lines 61–66).
The transaction-local `set_config(..., true)` rationale — that session-level settings leak across a
pooled connection behind PgBouncer — is stated in the file itself (lines 44–47) and is correct.

The RLS coverage query is present as a comment at lines 72–83, unwired — exactly as R4 says ✓.

---

## 11. Security review — verified, with R3 reproduced

`infra/sql/02-audit-immutability.sql` defines `audit_event_is_append_only()` raising on any
`UPDATE`/`DELETE` and binds it as `trg_audit_event_append_only` ✓ — belt and braces alongside the
grant-level restriction in `01-roles-and-rls.sql`.

**R3 reproduced independently.** `@nestjs/throttler` is declared in `apps/api/package.json:26` and
imported **nowhere** in `apps/api/src`. `RATE_LIMIT_RULES` in `core/security/rate-limit.ts` is a
frozen list with no consumer. Rate limiting is declared and unenforced, as the report states —
this must be wired before the first public endpoint, not after.

Health endpoints: three (`/live`, `/ready`, `/`), each carrying `@Public()` with a written reason ✓.

---

## 12–16. Storage, API, frontend, performance, scalability — verified as designed

These sections describe contracts rather than behaviour, and the contracts exist as described.
Worth confirming specifically:

- **8 queue lanes** in `apps/worker/src/queues.ts` — `OUTBOX_DISPATCH, DOCUMENTS_PREVIEW,
  DOCUMENTS_OCR, SEARCH_INDEX, WORKFLOW_TIMERS, NOTIFICATIONS_DELIVER, RETENTION_RUN,
  AUDIT_EXPORT` ✓, plus three scheduled jobs.
- **The frontend is a shell.** `apps/web/src/` holds 14 files: two route-group layouts, one page,
  `error/loading/not-found`, providers, middleware and three lib files. **There is no `/login`
  route** — R6 reproduced ✓. Both `(workspace)/layout.tsx` and `middleware.ts` redirect there.
- The performance and scalability sections are explicitly forward-looking and the report says so
  ("no load test has been run, because there is nothing to load"). That is the honest position.

---

## 17–18. Maintainability and testability — verified

**13 spec files** across the API, worker and all four packages. The report's "56 tests" is a test
count, not a file count, and could not be re-derived without running the suite (see Limitations).

`src/testing/` holds `factories.ts` and `fake-ports.ts` ✓. `apps/api/src/__tests__/composition.spec.ts`
exists and is, as the report argues, the load-bearing test — it builds the real `AppModule` and
asserts the defaults deny, which is what turns "the ports are declared" into "the ports are bound".

---

## 19. DevOps readiness — verified, and R1 reproduced

`infra/docker-compose.yml` defines Postgres 16, Redis 7 and MinIO, each with a `healthcheck` ✓.
`.github/workflows/ci.yml` runs `pnpm install --frozen-lockfile` → format → lint → typecheck →
test → build, plus a separate `Product isolation` job ✓.

**R1 reproduced, and it is slightly worse than the report states.**

```
$ pnpm install --frozen-lockfile
ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" because
pnpm-lock.yaml is not up to date with <ROOT>/package.json
  Failure reason:
  specifiers in the lockfile don't match specifiers in package.json:
* 2 dependencies were added: @prisma/client@^6.19.3, prisma@^6.19.3
```

The report describes R1 as a lockfile that "predates the new workspace members". It is that —
`pnpm-lock.yaml` contains exactly **one importer, `.`**, and none of the seven workspace members —
but the failure fires earlier than that, on the **root** `package.json`, which gained `prisma` and
`@prisma/client` after the lockfile was written. CI fails on the first step regardless.

**R1 is not fixable in this environment either.** `pnpm install --no-frozen-lockfile` reaches the
registry and stops:

```
ERR_PNPM_FETCH_401  GET https://npm.pkg.github.com/@munaxa%2Fconfig-eslint: Unauthorized - 401
```

This is the same constraint the authoring session hit, and it is a credential problem, not an
architecture problem. The `.npmrc` comment explains why the token is deliberately not committed —
pnpm refuses to expand environment variables in auth settings, so a PR could otherwise repoint the
registry. That reasoning is sound and should not be "fixed" by committing a token.

---

## 20. Compliance readiness — accepted as written

Architectural readiness for ISO 9001 / 27001 / SOC 2 / GDPR / HIPAA is a mapping exercise against
documents, not code, and the mapping is defensible. The report is careful to separate architectural
readiness from operational evidence, which is the distinction auditors care about. No correction.

---

## 21–23. Risks, recommendations, scorecard

All eight risks re-checked. **R1, R2, R3, R4 and R6 reproduce exactly.** R5 (no outbox dispatcher),
R7 (Reporting drift) and R8 (renderer sandboxing) are forward-looking and correctly rated. **No
risk was found that the report omits.**

The scorecard is a judgement instrument. Two scores read slightly generous against the evidence
and are noted rather than disputed:

| Category | Report | Note |
| --- | --- | --- |
| Security | 90 | Fail-closed defaults are genuinely good, but rate limiting is *declared and unenforced* — a dependency installed and never imported. Defensible either way; the number should not be read as "security is done" |
| Testing | 82 | 13 spec files over a 197-file skeleton, with no integration or E2E layer, is thorough for what exists and thin in absolute terms. The report says so |

---

## 24. Phase 1 readiness checklist — re-verified

| Items | Status |
| --- | --- |
| 1–26, 34, 35 (structure, boundaries, ports, DI, schema, RLS, zero business logic, zero TODOs) | **Confirmed PASS** by direct inspection |
| 27 (initial migration applied) | **Confirmed FAIL** — no `prisma/migrations/` |
| 28 (`pnpm install --frozen-lockfile`) | **Confirmed BLOCKED** — reproduced above |
| 29–33 (format, lint, typecheck, test, build) | **Not re-verifiable here** — see Limitations |

---

## Limitations of this verification

Five claims could not be independently re-derived, and honesty about that is part of the gate:

1. `pnpm format:check`, `lint`, `typecheck`, `test` and `build` cannot run here. Every one of them
   requires `pnpm install`, and install requires a `read:packages` token for `@munaxa/*` that this
   environment does not hold (401, reproduced above).
2. Consequently the "56 tests, all green" claim is unconfirmed. 13 spec files exist; whether they
   pass is unproven by this audit.
3. The report states items 30–33 were verified with the platform packages built from source and
   linked. That is a reasonable method and its result is not disputed — it is simply not something
   a second auditor without registry access can reproduce.

**The first Phase 1 task should be to clear R1 in an environment that has the credential, and then
re-run items 29–33 in CI.** That single action converts all five of these from "asserted" to
"observed", and it is the only thing standing between this gate and a fully reproducible one.

---

## Recommendation

**READY AFTER MINOR FIXES** — the compliance report's verdict, independently reached.

The architecture is sound and the skeleton implements it faithfully. The two open items are
mechanical and neither touches a boundary, a contract or a decision:

1. Refresh `pnpm-lock.yaml` with registry access (R1) — blocks CI entirely.
2. Generate and apply the initial migration (R2) — blocks development.

One correction to carry forward: the service-interface count is 21, not 22 (D1).

One addition to the report's own recommendations: **wire rate-limit enforcement (R3) in the same
commit as the first authenticated endpoint, not in a follow-up.** A frozen rule list and an
unimported `@nestjs/throttler` is the shape a security control takes right before it is forgotten.
