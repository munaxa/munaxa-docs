# Runbooks

Step-by-step responses to common operational events. Each runbook is self-contained: symptom →
diagnosis → action → verification. Backup/DR strategy rationale lives in
`docs/architecture/11-backup-strategy.md` and `12-disaster-recovery-strategy.md`.

> On-call: acknowledge the page, post in the incident channel, follow the matching runbook, and
> record actions in the incident timeline. If no runbook matches, escalate to the service owner.

---

## API is down / unhealthy

**Symptom:** `GET /api/v1/health/ready` non-200, 5xx spike, or pods crash-looping.
1. Check `health/ready` — if `database` is `down`, jump to **Database unreachable**.
2. Check Sentry for a crash signature and recent deploys. If it correlates with a deploy, **roll
   back** (`deployment.md` §Rollback).
3. Check resource saturation (CPU/memory/file descriptors). Scale out if saturated.
4. Verify liveness vs readiness: if `live` is OK but `ready` is not, it's a dependency, not the
   process.

## Database unreachable / saturated

**Symptom:** readiness `database: down`, connection timeouts, slow queries.
1. Confirm the DB is up and accepting connections; check connection-pool exhaustion.
2. Check for long-running/locking queries; cancel offenders.
3. If credentials failed: confirm `DATABASE_URL` uses the **app role** (NOBYPASSRLS) and the secret
   is current.
4. After recovery, run the readiness probe and a canary request.

## Elevated error rate (5xx)

1. Sentry → group by release/route to find the offending endpoint.
2. If isolated to one module, consider disabling it (advanced modules: toggle its feature flag off).
3. If a bad deploy, roll back. Capture a sample trace for the post-mortem.

## Rate-limit complaints (429s)

1. Confirm whether it's the global throttle (`THROTTLE_LIMIT`) or the login limiter (20/60s/IP).
2. If a legitimate client (e.g. shared NAT) is throttled, raise the limit or allow-list, then
   redeploy config. Do **not** disable the login limiter — it is brute-force protection.

## Backups

**Schedule:** automated nightly full + WAL/PITR (managed Postgres). Verify daily.
1. **Verify a backup is restorable** (do this routinely, not just during incidents): restore the
   latest snapshot into a scratch instance and run `prisma migrate status` + a row count on
   `_prisma_migrations` and a few tenant tables.
2. **On-demand backup before a risky change:** trigger a snapshot and record its id in the change
   ticket.
3. Retention and encryption are per `docs/architecture/11-backup-strategy.md`.

## Disaster Recovery (restore)

**Trigger:** data loss / corruption / destructive migration. Targets: see
`docs/architecture/12-disaster-recovery-strategy.md` (RPO/RTO).
1. Declare an incident; freeze writes (scale API to 0 or enable maintenance mode).
2. Restore the database to the chosen point (latest snapshot or PITR timestamp) into a new instance.
3. Re-grant the app role: `psql "$DIRECT_DATABASE_URL" -f infra/postgres/app-role.sql`.
4. Point `DATABASE_URL`/`DIRECT_DATABASE_URL` at the restored instance; run `prisma migrate status`.
5. Bring the API up on **one** pod, pass readiness, run a smoke test, then scale out.
6. Post-incident: write the timeline, root cause, and follow-ups.

## Secret rotation

1. Issue new secret in the secrets manager (JWT secret, DB password, AWS keys).
2. For JWT secrets, roll the **refresh** secret on a window that tolerates active sessions (rotating
   the access secret invalidates live access tokens — expected, clients re-auth).
3. Update the runtime config and redeploy; verify login + an authenticated read.

## Tenant data export / deletion (DSR)

1. Scope to one `tenantId`. All business tables are tenant-scoped and RLS-guarded.
2. Export via read replicas using the app role bound to the tenant context.
3. Hard deletion cascades from `Tenant` (FK `onDelete: Cascade`); confirm with the data-protection
   owner before executing.
