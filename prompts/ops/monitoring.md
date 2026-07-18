# Monitoring Documentation

What we observe, where it comes from, and the alerts that page. Audit-logging strategy (the
tamper-evident business trail) is separate — see `docs/architecture/10-audit-logging-strategy.md`.

## 1. Signals

| Signal | Source | Notes |
|--------|--------|-------|
| **Errors & traces** | Sentry (`@sentry/nestjs`, `observability/instrument.ts`) | PII scrubbed in `beforeSend` (auth headers, cookies, bodies dropped); `tracesSampleRate` configurable |
| **Access logs** | `LoggingInterceptor` (global) | One structured line/request: `METHOD path status durationMs tenant=… user=…`; health probes skipped; 4xx→warn, 5xx→error |
| **Health** | `GET /api/v1/health/{live,ready}` | Liveness = process; readiness = DB ping (`@nestjs/terminus`) |
| **Audit log** | `AuditLog` table (same-tx writes) | Financial/privileged actions; queryable, not a metrics source |
| **Rate limiting** | `@nestjs/throttler` | 429s indicate abuse or misconfigured clients |

## 2. Golden signals & SLOs

Track per service (API, admin):

- **Latency** — p50/p95/p99 of `http_req_duration`. SLO: p95 < 500ms, p99 < 800ms (see load test
  thresholds).
- **Traffic** — requests/sec, by route and tenant (from access logs).
- **Errors** — 5xx rate (SLO < 0.5%), 4xx rate (watch for auth/permission spikes), unhandled
  exceptions (Sentry).
- **Saturation** — CPU, memory, DB connections/pool utilization, event-loop lag.

## 3. Alerts (page vs notify)

**Page (urgent):**
- Readiness failing on >1 instance for >2 min (DB/dependency outage).
- 5xx rate > 2% for 5 min.
- p99 latency > 2s for 10 min.
- DB connection pool > 90% for 5 min.

**Notify (review):**
- 4xx (esp. 401/403) spike — possible attack or broken client/permission regression.
- 429 spike — throttling legitimate traffic.
- Sentry new-issue / regression on a release.
- Backup verification failed (see `runbooks.md`).

## 4. Dashboards

- **Service overview:** golden signals per service + recent deploys overlay.
- **Tenant view:** request volume/error rate by `tenantId` (from access logs) to spot a single noisy
  or failing tenant.
- **Database:** connections, slow queries, replication lag, disk.
- **Auth/security:** login attempts, 401/403 rates, login-limiter 429s.

## 5. Correlation

Access-log lines carry `tenant`/`user`; Sentry events carry release + (scrubbed) request context.
When investigating, pivot from the alert → access logs for the route/tenant → Sentry trace → DB
metrics. Keep deploy markers on every dashboard so regressions tie to a release.
