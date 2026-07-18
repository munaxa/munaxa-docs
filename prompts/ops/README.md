# Munaxa — Operations (Phase 15)

Operational documentation for running Munaxa in production. Architecture rationale lives in
`docs/architecture/`; these are the hands-on guides.

| Doc | Purpose |
|-----|---------|
| [deployment.md](./deployment.md) | Build, configure, release (zero-downtime), rollback, feature flags |
| [runbooks.md](./runbooks.md) | Incident response: outages, DB, rate limits, **backups, DR**, secrets, DSR |
| [monitoring.md](./monitoring.md) | Signals, golden signals/SLOs, alerts, dashboards |
| [infrastructure.md](./infrastructure.md) | Topology, DB roles, scaling, network/security boundaries, environments |
| [security-review-checklist.md](./security-review-checklist.md) | Per-release security gate (OWASP-mapped) |
| [load-testing.md](./load-testing.md) | k6 baseline test (`infra/loadtest/k6-smoke.js`) + thresholds |
| [production-readiness-review.md](./production-readiness-review.md) | Go/no-go PRR gate |

## What Phase 15 hardened in code

- **Rate limiting** — global throttle + a tighter login limiter (20/60s/IP) for brute-force defence.
- **Security headers** — `helmet`; CORS restricted to `CORS_ORIGINS`; Swagger off in prod.
- **Performance** — gzip (`compression`); `trust proxy` for correct client IPs.
- **Caching** — feature-flag gate cached (30s TTL, invalidated on toggle) to drop a hot DB read.
- **Health checks** — `/api/v1/health/live` (process) + `/ready` (DB ping), with e2e coverage.
- **Monitoring** — Sentry with PII scrubbing (`beforeSend`).
- **Logging** — global structured `LoggingInterceptor` (no bodies/secrets; tenant/user tagged).
- **Graceful shutdown** — `enableShutdownHooks` for clean draining.

Backups, DR, monitoring, infra, and the security checklist are documented here and in
`docs/architecture/{08,09,11,12}-*`.
