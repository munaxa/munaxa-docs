# Production Readiness Review (PRR)

A go/no-go gate before taking Munaxa (or a major new module) to production. Work top to bottom;
every item is either ✅ (in place) or has an owner + date. Links point to the implementing code or
the relevant ops doc.

## Functionality & quality
- ✅ All 15 phases delivered (see `README.md` / `docs/phases/`).
- ✅ CI gates green: lint, typecheck, unit, **e2e (incl. tenant-isolation)**, build, Flutter analyze,
  gitleaks, `pnpm audit` (`.github/workflows/ci.yml`).
- ✅ e2e covers happy path, business rules/idempotency, **RBAC 403**, and **tenant isolation** per
  domain.

## Reliability
- ✅ Liveness/readiness probes (`/api/v1/health/{live,ready}`); readiness pings the DB.
- ✅ Graceful shutdown (`enableShutdownHooks`) drains in-flight work on SIGTERM.
- ✅ Stateless API → horizontal scale (`infrastructure.md`).
- ✅ Idempotent migrations (expand-then-contract) + documented rollback (`deployment.md`).
- 🔁 Backups automated + **verified restorable** in the last 24h (`runbooks.md`).
- 🔁 DR plan rehearsed; RPO/RTO understood (`docs/architecture/12-disaster-recovery-strategy.md`).

## Performance
- ✅ Response compression (`compression`); read-path latency within SLO (`load-testing.md`).
- ✅ Feature-flag gate cached (30s TTL, invalidated on toggle) — no per-request DB hit for module
  gating.
- 🔁 Baseline load test run for this release; p95/p99 not regressed vs previous.
- 🔁 DB connection pool sized for pod count; pooler in place if needed.

## Security
- ✅ Security review checklist passed (`security-review-checklist.md`).
- ✅ Tenant isolation in depth (RLS + NOBYPASSRLS app role), RBAC, row-scoping.
- ✅ `helmet`, restricted CORS, strict input validation, Swagger off in prod.
- ✅ Login brute-force limiter + global throttle.
- ⏭ httpOnly-cookie auth + CSRF (tracked follow-up; tokens currently in localStorage).

## Observability
- ✅ Sentry (errors/traces) with PII scrubbing; structured access logs (`LoggingInterceptor`).
- ✅ Audit log for privileged/financial actions (same-transaction).
- 🔁 Dashboards + alerts wired (golden signals, 5xx, latency, DB pool, auth 4xx) — `monitoring.md`.

## Operability
- ✅ Runbooks for the common incidents (`runbooks.md`).
- ✅ Deployment + rollback documented (`deployment.md`).
- ✅ Infrastructure topology + scaling documented (`infrastructure.md`).
- 🔁 On-call rotation, escalation path, and incident channel defined.

## Data protection & compliance
- ✅ Bilingual (Arabic/English, RTL/LTR); Jordan validators (national ID, mobile, MoE).
- ✅ Tenant data export/deletion path (`runbooks.md` §DSR); cascade delete from `Tenant`.
- 🔁 Data retention & PII handling signed off by the data-protection owner.

## Sign-off
| Area | Owner | Status | Date |
|------|-------|--------|------|
| Engineering | | | |
| Security | | | |
| SRE / On-call | | | |
| Product | | | |

**Decision:** ☐ Go ☐ No-go — record blockers and follow-ups in the release ticket.
