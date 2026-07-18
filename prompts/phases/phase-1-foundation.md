# Phase 1 — Foundation Setup (Deliverables & Deployment Notes)

## Deliverables (all complete)

| # | Deliverable | Where |
|---|-------------|-------|
| 1 | Turborepo structure | `turbo.json`, `pnpm-workspace.yaml`, `apps/*`, `packages/*` |
| 2 | NestJS initialization | `apps/api` (bootstrap, config, health, Prisma, Sentry, Swagger) |
| 3 | Next.js initialization | `apps/admin` (App Router, Tailwind, shadcn config, RTL/LTR) |
| 4 | Flutter initialization | `apps/mobile` (Riverpod, GoRouter, 3 flavors, theme) |
| 5 | Shared packages | `packages/{domain,contracts,utils,i18n,ui,config-*}` |
| 6 | Environment management | `.env.example` (root + per app), zod env validation in API |
| 7 | Docker setup | `apps/api/Dockerfile`, `apps/admin/Dockerfile` (multi-stage, non-root) |
| 8 | Docker Compose | `docker-compose.yml` (Postgres, Redis, LocalStack, Mailhog) |
| 9 | CI/CD pipelines | `.github/workflows/ci.yml`, `deploy.yml` |
| 10 | Sentry integration | API `instrument.ts`; Admin `sentry.*.config.ts` + `instrumentation.ts` |
| 11 | PostHog integration | Admin `src/lib/posthog.tsx` |
| 12 | Prisma initialization | `prisma/schema.prisma` (datasource + generator) |
| 13 | Code quality tooling | ESLint (flat) + Prettier + EditorConfig + Husky + lint-staged |

## Architecture impact
- Establishes the **modular monolith** skeleton and the shared-package boundaries defined in
  `docs/architecture/01-monorepo-architecture.md` and `02-domain-architecture.md`.
- No business/domain modules yet (per phase rules). Cross-cutting foundations only: config
  validation, security middleware (Helmet, CORS), global rate limiting, health checks, Prisma
  lifecycle, observability.

## Setup / deployment notes

### Local
```bash
cp .env.example .env && cp apps/api/.env.example apps/api/.env && cp apps/admin/.env.example apps/admin/.env.local
pnpm install
pnpm docker:up
pnpm prisma:generate
pnpm dev
```

### Generating a lockfile
The committed scaffold does not include `pnpm-lock.yaml` (no install run in the authoring
environment). On first checkout, run `pnpm install` to generate it, then commit the lockfile so CI
can use `--frozen-lockfile`.

### Flutter platform folders
`apps/mobile` contains the Dart source and `pubspec.yaml`. Generate native platform folders locally:
```bash
cd apps/mobile && flutter create --platforms=android,ios . && flutter pub get
```
CI does this automatically (`subosito/flutter-action` + `flutter create`).

### Container builds (context = repo root)
```bash
docker build -f apps/api/Dockerfile   -t munaxa-api   .
docker build -f apps/admin/Dockerfile -t munaxa-admin .
```

### Security baseline already in place
- Helmet security headers + locked CORS (API), security headers (Admin).
- Global rate limiting (`@nestjs/throttler`).
- Strict env validation; **no secrets committed** — only `.env.example` templates.
- Secret scanning (gitleaks) + dependency audit in CI.
- Non-root container users.

## Verification checklist
- [ ] `pnpm install` succeeds and produces a lockfile
- [ ] `pnpm typecheck` passes across the workspace
- [ ] `pnpm lint` passes
- [ ] `pnpm test` runs (utils + API unit tests)
- [ ] `pnpm build` builds api + admin
- [ ] `pnpm docker:up` brings up Postgres/Redis/LocalStack/Mailhog
- [ ] API `/api/v1/health/live` returns ok; `/health/ready` returns ok with DB up
- [ ] `flutter analyze && flutter test` pass in `apps/mobile`

## Next: Phase 2 — Core Database Design
Introduce the core Prisma models (Tenant, School, Campus, AcademicYear, Semester, Grade, Section,
Classroom, User, Role, Permission, AuditLog), tenant-isolation strategy (middleware + RLS),
indexing, and migration strategy.
