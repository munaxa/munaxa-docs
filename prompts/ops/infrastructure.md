# Infrastructure Documentation

The runtime topology and the knobs that operate it. Design rationale: see
`docs/architecture/08-deployment-architecture.md` and `03-multi-tenant-architecture.md`.

## 1. Topology

```
            ┌─────────────┐      ┌──────────────────────┐
  Browser → │  CDN / WAF  │ ───→ │  Admin (Next.js)      │
            └─────────────┘      └──────────────────────┘
                  │
  Mobile ─────────┼───────────→  ┌──────────────────────┐     ┌──────────────────────┐
  (Flutter)       │              │  Load balancer (TLS)  │ ──→ │  API (NestJS, N pods) │
                  │              └──────────────────────┘     └──────────┬───────────┘
                  │                                                       │
                  │                          ┌────────────────────────────┼───────────────┐
                  ▼                           ▼                            ▼               ▼
            Object storage (S3)        PostgreSQL 16 (primary      Sentry          FCM / WhatsApp
            documents, receipts        + replicas, PITR)           (errors/traces)  (best-effort)
```

- **API** is a stateless, horizontally-scalable NestJS process (Node 22). No sticky sessions;
  in-memory state is limited to the throttler counters and the feature-flag gate cache (both
  best-effort, per-instance, short-lived).
- **Database** is the single source of truth. **Multi-tenant isolation is enforced in depth**: JWT
  tenant claim → tenant guard → request-scoped context → **PostgreSQL Row-Level Security**. The API
  connects as a **non-superuser, NOBYPASSRLS** role (`munaxa_app`); migrations connect as the schema
  owner.
- **Object storage** holds documents/receipts/resources, written via pre-signed URLs
  (`StorageService`), keyed by tenant (`tenants/<tenantId>/…`).
- **External channels** (FCM push, WhatsApp) are best-effort and feature-flagged; the in-app
  `Notification` row is the source of truth.

## 2. Database roles

| Role | Privilege | Used by |
|------|-----------|---------|
| schema owner | DDL, owner of all objects | migrations (`DIRECT_DATABASE_URL`) |
| `munaxa_app` | DML only, **NOBYPASSRLS** | API runtime + tests (`DATABASE_URL`) |

After any migration that adds tables, re-run `infra/postgres/app-role.sql` to grant the app role
(and it sets default privileges for future objects). RLS policies are created per tenant table in
each migration (`ENABLE/FORCE ROW LEVEL SECURITY` + `tenant_isolation` policy using
`app_current_tenant()`).

## 3. Scaling & capacity

- **API:** scale horizontally on CPU / p95 latency. Stateless, so add pods freely. Mind DB
  connection limits — size the pool per pod so `pods × pool ≤ DB max_connections` (use a pooler
  such as PgBouncer if pod count is high).
- **Database:** vertical scale for write throughput; read replicas for reporting/analytics
  (Phase 13 aggregations are read-heavy). PITR retained per backup policy.
- **Object storage:** effectively unbounded; lifecycle rules archive/expire old uploads.

## 4. Network & security boundaries

- TLS terminates at the load balancer/CDN; the API trusts the proxy (`trust proxy`) for real client
  IPs (used by the rate limiter).
- Security headers via `helmet`; CORS restricted to `CORS_ORIGINS` (no wildcard in prod).
- Responses gzipped (`compression`).
- Secrets from a managed secrets store; nothing sensitive in the repo (`gitleaks` runs in CI).
- See `security-review-checklist.md` and `docs/architecture/09-security-architecture.md`.

## 5. Environments

| Env | Purpose | Data |
|-----|---------|------|
| local | dev | system Postgres cluster; S3 stubbed |
| CI | gates | ephemeral Postgres service; app role provisioned |
| staging | pre-prod smoke + load tests | anonymized/seeded |
| production | live tenants | real; backups + PITR + DR |

Config differs only by environment variables (12-factor); the same image runs in every environment.
