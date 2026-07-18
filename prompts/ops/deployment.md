# Deployment Documentation

How to build, configure, and ship Munaxa to an environment. Architecture rationale lives in
`docs/architecture/08-deployment-architecture.md`; this is the operational how-to.

## 1. Artifacts

| Component | Build | Runtime |
|-----------|-------|---------|
| `apps/api` (NestJS) | `pnpm --filter @munaxa/api build` → `dist/` | `node dist/main.js` (Node 22) |
| `apps/admin` (Next.js) | `pnpm --filter @munaxa/admin build` | `next start` / static + serverless |
| `apps/mobile` (Flutter) | `flutter build apk|ipa` per flavor | App stores / MDM |
| `prisma` | migrations in `prisma/migrations/` | `prisma migrate deploy` |

Monorepo builds run through Turborepo (`pnpm run build`), which builds workspace deps first.

## 2. Required environment (API)

| Var | Purpose | Notes |
|-----|---------|-------|
| `DATABASE_URL` | Runtime DB connection | **Must** be the restricted, NOBYPASSRLS app role |
| `DIRECT_DATABASE_URL` | Migrations (schema owner) | Privileged; used only by `migrate deploy` |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | Token signing | From the secrets manager; rotate per policy |
| `CORS_ORIGINS` | Allowed browser origins | Comma-separated; no `*` in prod |
| `THROTTLE_TTL` / `THROTTLE_LIMIT` | Global rate limit | Defaults 60s / 120; login is tighter (20/60s) |
| `SENTRY_DSN` / `SENTRY_TRACES_SAMPLE_RATE` | Error + perf monitoring | Unset = disabled |
| `AWS_S3_BUCKET` / `AWS_REGION` / `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Document/receipt storage | Unset = dev stub |
| `PORT` / `API_GLOBAL_PREFIX` / `API_VERSION` | Listener | Defaults 4000 / `api` / `v1` |

Secrets come from a managed secrets store (never committed). `.env.example` documents the full set.
**RLS is only enforced for the non-superuser app role — never point `DATABASE_URL` at a superuser.**

## 3. Release procedure (zero-downtime)

1. **CI green** on the release commit (lint, typecheck, unit, e2e, build — see `.github/workflows/ci.yml`).
2. **Back up** the database (see `runbooks.md` §Backups) and confirm the latest backup is restorable.
3. **Migrate**: run `prisma migrate deploy` with `DIRECT_DATABASE_URL`. Migrations are
   additive/backward-compatible (expand-then-contract); deploy code that tolerates both shapes.
4. **Re-grant** the app role if new tables were added: `psql "$DIRECT_DATABASE_URL" -f infra/postgres/app-role.sql`.
5. **Deploy API** behind the load balancer with a rolling/blue-green strategy. New pods must pass
   `GET /api/v1/health/ready` (DB reachable) before receiving traffic; `GET /api/v1/health/live` is
   the liveness probe. `enableShutdownHooks()` drains in-flight requests on SIGTERM.
6. **Deploy admin** (Next.js) and invalidate the CDN cache.
7. **Smoke test**: run `infra/loadtest/k6-smoke.js` against the environment (see `load-testing.md`).
8. **Watch** Sentry + dashboards for 15 min (error rate, p95 latency, 5xx).

## 4. Rollback

- **Code**: redeploy the previous image/build (artifacts are immutable and tagged).
- **DB**: because migrations are expand-then-contract, the previous code runs against the new
  schema — prefer rolling code back over reverting a migration. Only restore from backup for a
  destructive migration (see `runbooks.md` §Disaster Recovery).

## 5. Feature flags

Advanced modules (Phase 14) are **off by default**. Enable per tenant via
`PUT /api/v1/feature-flags/:key` (`bus_tracking`, `library_management`, `inventory_management`,
`school_clinic`, `whatsapp_bridge`). No redeploy needed; the gate cache picks up changes within 30s
(and is invalidated immediately on toggle).
