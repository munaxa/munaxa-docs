# Munaxa — Session Handoff & Continuation Guide

This document lets a **fresh session** continue building Munaxa without re-discovering the
environment, conventions, or gotchas. Read this first, then `docs/architecture/` and the relevant
`docs/phases/*` file.

> Munaxa = multi-tenant **School Operating System** for K-12 schools in Jordan (Arabic/English,
> RTL/LTR). It is **not** an LMS (Google Classroom / MS Teams integrate via deep links only).
> No online payment gateways (CliQ/e-wallet receipt uploads). Work is **phase-by-phase**; wait for
> approval between phases.

## 1. Phase status

| Phase | Title | Status |
|------|-------|--------|
| 0 | System Architecture (docs only) | ✅ |
| 1 | Foundation Setup (Turborepo) | ✅ |
| 2 | Core Database Design (+ RLS) | ✅ |
| 3 | Authentication & RBAC | ✅ |
| 4 | School Structure Management | ✅ |
| 5 | People Management | ✅ |
| 6 | Timetable Engine | ✅ |
| 7 | Attendance System (offline-first) | ✅ |
| 8 | Academics | ✅ |
| 9 | Finance | ✅ |
| 10 | Communication System | ✅ |
| 11 | Parent Portal | ✅ |
| 12 | Student App | ✅ |
| 13 | Reporting | ✅ |
| 14 | Advanced Modules | ✅ |
| 15 | Production Hardening | ✅ |

**All 15 phases complete.** 🎉

Phase prompts are in `MunaxaPrompts/`. Per-phase delivery notes are in `docs/phases/`.

**Git**: develop on branch `claude/optimistic-archimedes-aTEyb`. Commit per phase, push with
`git push -u origin claude/optimistic-archimedes-aTEyb` (retry on network errors). Do NOT open a PR
unless asked. End commit messages with the session URL footer (the harness adds it).

## 2. Monorepo layout

```
apps/api      NestJS modular monolith (DDD + Clean Architecture)
apps/admin    Next.js 15 Admin Portal (App Router, Tailwind, shadcn tokens)
apps/mobile   Flutter (Riverpod, GoRouter) — parent/student/teacher flavors
packages/domain      roles, permissions, role→permission map, locale, tenant enums (framework-free)
packages/contracts   zod DTOs shared API⇄Admin
packages/utils       Jordan validators (National ID, mobile, MoE) + JOD money
packages/i18n, ui, config-{eslint,tailwind,typescript}
prisma/       schema.prisma + migrations (root-level; consumed by apps/api)
infra/postgres/app-role.sql   restricted runtime DB role
docs/         architecture/, phases/, this file
```

## 3. CRITICAL environment & workflow (the gotchas)

The dev container has **Node 22, pnpm 10, a local PostgreSQL 16 cluster, but NO Docker daemon and
NO Flutter SDK**. Network is available but **the sandbox blocks nested writes** (e.g. Prisma's
auto `pnpm add`), so run DB/codegen commands with the sandbox disabled.

### Postgres
- It is a **system cluster**, not Docker. After any idle period it stops — restart with:
  `pg_ctlcluster 16 main start` (data persists on disk).
- Two roles: `munaxa` (owner, password `munaxa_local_dev`, migrations) and **`munaxa_app`**
  (restricted, NOBYPASSRLS, password `munaxa_app_dev`, runtime/tests). **RLS is only enforced for
  non-superusers**, so tests MUST connect as `munaxa_app`.
- URLs used everywhere:
  - `DIRECT_DATABASE_URL=postgresql://munaxa:munaxa_local_dev@localhost:5432/munaxa?schema=public`
  - `DATABASE_URL=postgresql://munaxa_app:munaxa_app_dev@localhost:5432/munaxa?schema=public`

### Adding a DB migration (per phase)
1. Edit `prisma/schema.prisma` (add models + **back-relations on Tenant/User/Section/etc.** —
   Prisma requires both sides).
2. `cd apps/api`, export both URLs, then (with **sandbox disabled**):
   - `./node_modules/.bin/prisma format --schema=../../prisma/schema.prisma`
   - `./node_modules/.bin/prisma validate --schema=../../prisma/schema.prisma`
   - `mkdir -p ../../prisma/migrations/<timestamp>_<name>`
   - `prisma migrate diff --from-url "$DIRECT_DATABASE_URL" --to-schema-datamodel ../../prisma/schema.prisma --script > .../migration.sql`
3. **Append RLS** for every new tenant-scoped table (copy the `DO $$ … FORCE ROW LEVEL SECURITY …`
   block from an existing migration; helper fns `app_current_tenant()` / `app_is_platform()` already
   exist).
4. `prisma migrate deploy` (needs BOTH env vars set).
5. Re-grant the app role: `sudo -u postgres psql -d munaxa -q -f ../../infra/postgres/app-role.sql`
   (new tables need GRANTs to `munaxa_app`).
6. Regenerate client: `DATABASE_URL=$DIRECT_DATABASE_URL ./node_modules/.bin/prisma generate --schema=../../prisma/schema.prisma`.

### Quirks already solved (don't re-debug)
- **`prisma generate` tried `pnpm add prisma`**: Prisma packages are installed at the **repo root**
  so the root-level schema resolves them. Keep it that way.
- **API emitted no `dist`**: `tsc --noEmit` (typecheck) and `tsc` (build) shared an incremental
  `.tsbuildinfo`. Fixed: `incremental:false` in `apps/api/tsconfig.json`; package typecheck uses a
  separate `--tsBuildInfoFile`.
- **Libraries export `dist`, not `src`** (NodeNext `.js` specifiers break webpack). Turbo builds deps
  first.
- **jest can't load ESM `@munaxa/domain`**: api jest configs have `moduleNameMapper` to source + a
  `.js`→strip rule. Reuse for any new `@munaxa/*` import in tests.
- **eslint**: root `eslint.config.mjs` (non-type-checked) is the pre-commit safety net; each
  package/app has its own flat config. Test files relax `no-unsafe-*` in `apps/api/eslint.config.mjs`.
- **Admin `typedRoutes`**: adding a new `/route` then running `pnpm typecheck` before a build fails
  on stale `.next/types`. **Build admin before the combined typecheck** locally; CI is fine (fresh,
  no `.next`).
- **Route collisions**: NestJS registers controllers globally — don't reuse a path. (e.g. academics
  grades live at `/grade-records` because `/grades` = structure grade-levels.)

## 4. Backend patterns (follow these for every new module)

Clean-Architecture module per entity: `dto / repository / service / controller`, aggregated by a
feature `*.module.ts` registered in `apps/api/src/app.module.ts`.

- **`TenantRepository`** (`apps/api/src/common/tenant.repository.ts`) base: `this.run((tx, tenantId) =>
  …)` runs inside `withTenant` so **RLS scopes every query** and writes stamp `tenantId`. It also has
  `writeAudit(tx, tenantId, {action, entityType, entityId, metadata})` for **same-transaction audit**
  (use for financial/privileged actions).
- **Tenant context**: `TenantContextStore.get()?.actorUserId` for the acting user; `requireTenantId()`.
- **Guards (global)**: `JwtAuthGuard` (@Public() opt-out) → `PermissionsGuard`
  (`@RequirePermissions(Permission.X)`) → `TenantIsolationGuard`; `TenantContextInterceptor` binds the
  request context. Add new permissions to `packages/domain/src/permissions.ts` AND the role map in
  `role-permissions.ts`, then **re-seed** (`db:seed`) so they exist in the DB for `provisionTenantRoles`.
- **Nullable compound-unique upsert**: Prisma can't upsert on a unique with a nullable column; use
  `findFirst` + `create/update` (see `RbacService`, `GradeRepository`, `TimetableConfigRepository`).
- **Money**: `Decimal` (JOD `@db.Decimal(12,3)`); compute with `Prisma.Decimal`, never float.
- **CSV import / idempotent bulk**: parse with `csv-parse/sync`; upsert on a tenant-scoped unique so
  replays don't duplicate (attendance, grades). Return `{ created/imported, failed:[{row,error}] }`.
- **S3 uploads**: `StorageService` (presign PUT/GET, lazy AWS SDK, dev stub when unconfigured),
  tenant-namespaced keys. Confirm metadata after client upload (homework attachments, finance receipts).
- **External channels** (FCM push, WhatsApp) are **best-effort** and lazy/stubbed; the in-app
  `Notification` row is the source of truth. WhatsApp is gated by the `whatsapp_bridge` feature flag.

## 5. Testing (the proof bar — every phase)

Every phase ships **e2e tests against the real Postgres** (not just unit). Pattern: bootstrap the
Nest app from `AppModule`, `setGlobalPrefix('api')` + `enableVersioning` + `ValidationPipe`; seed a
tenant via `withPlatform`, `rbac.provisionTenantRoles`, create users + `rbac.assignRole`, log in over
HTTP, then exercise endpoints with `supertest`. Cover: happy path, **idempotency/business rule**,
**RBAC 403**, and **tenant isolation**. Use a unique tenant slug per suite and clean it in `afterAll`.

Run gates (from repo root, sandbox disabled where DB is involved):
```bash
pnpm run lint && pnpm run typecheck && pnpm run test
pnpm --filter @munaxa/admin build   # build admin first (typedRoutes), then:
pnpm run build
# e2e (needs DB up + migrated + app role):
DATABASE_URL=postgresql://munaxa_app:munaxa_app_dev@localhost:5432/munaxa?schema=public \
DIRECT_DATABASE_URL=postgresql://munaxa:munaxa_local_dev@localhost:5432/munaxa?schema=public \
pnpm --filter @munaxa/api test:e2e
```
Before e2e, clean leftover test tenants if a prior run crashed:
`psql … -c "DELETE FROM \"Tenant\" WHERE slug IN ('…');"`. Current totals: **82 e2e across 14 suites**,
plus **44 unit** (engine, auth/guards, gamification streaks, logging interceptor, utils).

CI (`.github/workflows/ci.yml`) already: starts Postgres service, `prisma:generate`, `prisma:deploy`,
provisions the restricted role via `app-role.sql`, `db:seed`, then lint/typecheck/test/**test:e2e**/
build + a Flutter job + gitleaks/audit.

## 6. Frontend / Mobile conventions

- **Admin**: client-side pages under `apps/admin/src/app/<feature>/page.tsx`; API clients in
  `src/lib/<feature>.ts` using `authFetch` (refresh-on-401). Add a nav `<Link>` on the dashboard
  (`src/app/page.tsx`). Tokens in localStorage (httpOnly cookies = Phase 15). Bilingual inputs use
  `dir="rtl"` for Arabic.
- **Mobile (Flutter, can't compile here)**: data layer in `lib/data/<feature>/*.dart`, Riverpod
  providers in `lib/features/<feature>/*_providers.dart`, sharing the auth `dioProvider` (bearer
  interceptor). Keep it analyzable (no codegen `.g.dart`). Offline-first attendance queue lives in
  `lib/data/attendance` + `lib/features/attendance`.

## 7. Project complete — all 15 phases ✅

Phase 15 (Production Hardening) is ✅ — see `docs/phases/phase-15-production-hardening.md`. It added
the login brute-force limiter, `compression`, the `FeatureGate` TTL cache (invalidated on toggle),
the global structured `LoggingInterceptor`, Sentry PII scrubbing, a health-check e2e, the k6 load
test (`infra/loadtest/k6-smoke.js`), and the full **operations documentation** set under `docs/ops/`
(deployment, runbooks, monitoring, infrastructure, security review checklist, load testing, PRR).

**There is no next phase.** For ongoing work, start from `docs/ops/production-readiness-review.md`
(go/no-go gate) and the tracked follow-ups in the Phase 15 doc (httpOnly-cookie auth + CSRF,
Redis-backed distributed cache/throttle, telemetry/reporting enrichments). Build/test/migration
recipes in §3–§5 remain current.

## 8. Quick "resume work" checklist
1. `pg_ctlcluster 16 main start` (restart DB if stopped); verify `_prisma_migrations` count.
2. `pnpm install` if needed; `prisma generate` (sandbox disabled).
3. Read `MunaxaPrompts/Phase N — *.txt` + this file + `docs/architecture/05-rbac-matrix.md`.
4. Build the phase (DB → backend → admin/mobile → tests), run all gates + e2e green.
5. Update `README.md` phase status + add `docs/phases/phase-N-*.md`, commit, push, pause for approval.
