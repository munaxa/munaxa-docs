# Phase 15 — Production Hardening

The final phase: cross-cutting hardening of the API plus the operational documentation needed to run
Munaxa in production. Much of the security baseline already existed (helmet, CORS, strict validation,
Sentry, throttling, health checks, shutdown hooks); this phase closed the remaining gaps and wrote
the runbooks/checklists.

## 1. Deliverables

| Area | Where |
|------|-------|
| Code hardening | `apps/api/src/main.ts`, `feature-flags/feature-gate.service.ts`, `observability/logging.interceptor.ts`, `observability/instrument.ts`, `auth/auth.controller.ts` |
| Load test | `infra/loadtest/k6-smoke.js` |
| Ops docs | `docs/ops/` — deployment, runbooks, monitoring, infrastructure, security checklist, load testing, PRR |
| Tests | `apps/api/test/health.e2e-spec.ts` (2), `observability/logging.interceptor.spec.ts` (2) |

New deps: `compression` (+ `@types/compression`).

## 2. Hardening implemented

- **Rate limiting** — kept the global throttle; added a tighter **login limiter** (`@Throttle`
  20/60s per IP) for brute-force defence. `trust proxy` set so the limiter sees the real client IP.
- **Security headers** — `helmet` (already present); confirmed CORS is `CORS_ORIGINS`-restricted and
  Swagger is disabled in production.
- **Performance** — `compression` (gzip) middleware.
- **Caching strategy** — `FeatureGate` now caches flag lookups in-process (30s TTL). Advanced-module
  requests check a flag on every call; flags change rarely, so this removes a hot DB round-trip. The
  cache is **invalidated immediately** when a flag is toggled (`FeatureFlagService.set` →
  `gate.invalidate`), so enabling a module takes effect at once (verified by the Phase 14 e2e still
  passing).
- **Health checks** — liveness/readiness already existed; added an **e2e** proving `/health/live`
  is public and `/health/ready` reports the DB up.
- **Monitoring** — Sentry `beforeSend` now **scrubs PII**: drops `authorization`/`cookie`/`x-api-key`
  headers, cookies, and the request body before events leave the process.
- **Logging** — a global `LoggingInterceptor` emits one structured line per request
  (`METHOD path status durationMs tenant=… user=…`), skips health probes, and maps 4xx→warn /
  5xx→error. No bodies or secrets are logged.
- **Graceful shutdown** — `enableShutdownHooks()` (already present) drains in-flight requests on
  SIGTERM.

## 3. Load testing

`infra/loadtest/k6-smoke.js`: a k6 baseline that logs in once, then ramps 0→20 VUs hitting the
public liveness probe and an authenticated read, with **thresholds** (p95 < 500ms, p99 < 800ms,
<1% failures) that fail the run if breached. See `docs/ops/load-testing.md`.

## 4. Operational documentation

Under `docs/ops/` (indexed by `docs/ops/README.md`), complementing the architecture docs:

- **Deployment** — artifacts, env vars, zero-downtime release, rollback, feature flags.
- **Runbooks** — outages, DB, rate limits, **backups**, **disaster recovery (restore)**, secret
  rotation, tenant data export/deletion.
- **Monitoring** — signals, golden-signal SLOs, page/notify alerts, dashboards.
- **Infrastructure** — topology, DB roles (NOBYPASSRLS app role), scaling, security boundaries.
- **Security review checklist** — OWASP-mapped, per-release gate with sign-off.
- **Production Readiness Review** — go/no-go gate across reliability, performance, security,
  observability, operability, data protection.

## 5. Tests

`health.e2e` (liveness public + readiness DB up) and `logging.interceptor.spec` (summary line
content + 4xx warn + health-probe skip). Totals: **82 e2e across 14 suites**, **44 unit**. The
feature-gate cache + invalidation are covered end-to-end by the Phase 14 advanced-modules e2e
(disabled-by-default 403 → enable → 200).

## 6. Tracked follow-ups (post-launch)

- httpOnly-cookie auth + CSRF (browser tokens currently in localStorage) — see the security
  checklist A02/A07.
- Distributed caching/throttling (Redis) if the API scales beyond a few instances; current caches
  are best-effort per-instance.
- Live bus-tracking telemetry history + websocket push; richer reporting (per-subject, trends).
