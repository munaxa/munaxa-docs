# Security Review Checklist

Run before each production release and on a recurring cadence. Items map to OWASP Top 10 and the
controls actually implemented in Munaxa. Deep rationale: `docs/architecture/09-security-architecture.md`.

Legend: ✅ implemented · 🔁 operational (verify each release) · ⏭ future hardening.

## A01 — Broken Access Control
- ✅ Tenant isolation in depth: JWT tenant claim → `TenantIsolationGuard` → request context →
  **PostgreSQL RLS** (`FORCE ROW LEVEL SECURITY`, app role is NOBYPASSRLS).
- ✅ RBAC via `@RequirePermissions` / `@RequireAnyPermission` + `PermissionsGuard`; role→permission
  map seeded per tenant.
- ✅ Row-scoping for parents (own children) and students (own record) — `ParentScopeService` /
  `StudentScopeService`.
- ✅ Advanced modules gated by per-tenant feature flags (`FeatureFlagGuard`), off by default.
- 🔁 Spot-check a new endpoint enforces both a permission **and** the right row scope; add a
  tenant-isolation e2e for any new tenant table.

## A02 — Cryptographic Failures
- ✅ Passwords hashed (Argon2/bcrypt via `PasswordService`); never logged.
- ✅ JWT access/refresh signed with separate secrets; refresh-token rotation.
- 🔁 Secrets sourced from the secrets manager; rotated per policy (`runbooks.md` §Secret rotation).
- 🔁 TLS everywhere (LB/CDN termination); HSTS via `helmet`.
- ⏭ Move browser tokens from localStorage to httpOnly cookies + CSRF (tracked).

## A03 — Injection
- ✅ Prisma parameterized queries throughout; no string-built SQL.
- ✅ Global `ValidationPipe` with `whitelist` + `forbidNonWhitelisted` + DTO class-validators on
  every input; Jordan-specific validators (national ID, mobile, MoE) in `@munaxa/utils`.
- ✅ CSV import parsed safely (`csv-parse/sync`), upsert-idempotent.

## A04 — Insecure Design
- ✅ Expand-then-contract migrations; financial actions write audit in the **same transaction**.
- ✅ External channels (push/WhatsApp) best-effort; in-app notification is source of truth.
- 🔁 Threat-model new modules; default-deny (new advanced modules ship disabled).

## A05 — Security Misconfiguration
- ✅ `helmet` security headers; CORS restricted to `CORS_ORIGINS` (no wildcard in prod).
- ✅ Swagger disabled when `NODE_ENV=production`.
- ✅ `gitleaks` + `pnpm audit` in CI.
- 🔁 Verify prod env: no debug, secrets present, `DATABASE_URL` is the **non-superuser** role.

## A06 — Vulnerable & Outdated Components
- 🔁 `pnpm audit` clean (or triaged) in CI; dependency updates reviewed.
- 🔁 Node 22 / pinned toolchain; base images patched.

## A07 — Identification & Authentication Failures
- ✅ Login brute-force limiter (20/60s/IP) on top of the global throttle; lockout via `UserStatus`.
- ✅ `mustChangePassword` flow; password reset tokens single-use + expiring.
- 🔁 Review session/refresh TTLs; confirm logout revokes refresh tokens.

## A08 — Software & Data Integrity Failures
- ✅ Tamper-evident `AuditLog` (actor, action, entity, metadata) for privileged ops.
- ✅ Pre-signed, content-type-scoped uploads; tenant-namespaced keys; size limits in DTOs.
- 🔁 CI artifacts are immutable + tagged; deploys reference a pinned build.

## A09 — Security Logging & Monitoring Failures
- ✅ Structured access logging (`LoggingInterceptor`) — no bodies/secrets; tenant/user tagged.
- ✅ Sentry with PII scrubbing (`beforeSend` drops auth headers/cookies/body).
- 🔁 Alerts on 401/403 spikes + login-limiter 429s (`monitoring.md`).

## A10 — SSRF
- ✅ No user-supplied URLs are server-fetched; resource LINK/VIDEO types are stored and rendered
  client-side (deep-links), not fetched by the API.
- 🔁 Re-check any new outbound integration validates/allow-lists destinations.

## Pre-release sign-off
- [ ] CI green (lint, typecheck, unit, **e2e incl. tenant-isolation**, build).
- [ ] No new endpoint without a permission + (where applicable) row-scope test.
- [ ] Migrations backward-compatible; app role re-granted for new tables.
- [ ] Secrets present & correct; prod `DATABASE_URL` = app role; Swagger off.
- [ ] Backup verified restorable in the last 24h.
- [ ] Reviewer + date recorded.
