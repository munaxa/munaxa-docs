# Tenant Database Routing (Hybrid: pool + opt-in silo)

Munaxa hosts schools in a **pool** by default — one shared PostgreSQL database, isolated by
Row-Level Security (see `03-multi-tenant-architecture.md`). This document adds the ability to
**silo** an individual school onto its own database — same server, a separate server/region, or the
school's own / on-prem PostgreSQL — **without any change to application code**. It is the
production-recommended model: dense, simple and cheap for the 95%, with physical separation
available for the few schools that require it (regulatory or contractual).

## How it works

```
            request ─► JWT tenant claim ─► TenantContext (tenantId)
                                              │
                       TenantRepository.run() │ resolves the client for this tenant
                                              ▼
                              TenantConnectionManager.clientFor(tenantId)
                               ├─ no override  → shared default DB  (PrismaService)  ← pooled
                               └─ override      → that tenant's DB  (dedicated client) ← siloed
                                              │
                              withTenant(client, tenantId, …)  ── RLS set per transaction
```

- **`TenantConnectionManager`** (`apps/api/src/prisma/tenant-connection.service.ts`) maps a
  `tenantId` to a Prisma client. It is global (provided by `PrismaModule`) and used by the
  `TenantRepository` base, so **every** tenant-scoped query is routed automatically.
- **Registry = config, not a table.** Overrides come from `TENANT_DATABASE_OVERRIDES`, a JSON object
  `{ "<tenantId>": "<runtime connection url>" }`, supplied from the **secrets manager** — so
  database URLs and passwords never live in the shared database. Unset/empty ⇒ every tenant uses
  the shared DB (today's behaviour; the feature is a no-op until a school is siloed).
- **RLS still applies on a siloed DB.** Dedicated databases carry the **same schema and the same
  RLS policies**, and the API still connects as the NOBYPASSRLS app role. Isolation is therefore
  never weaker than the shared path — a silo only adds *physical* separation on top.
- **Platform plane stays shared.** Cross-tenant operations (`withPlatform`, provisioning, the tenant
  catalog) use the shared control-plane database directly via `PrismaService`.

## Connection URLs per tenant

| Purpose | Config | Role |
|---|---|---|
| Runtime (the API) | `TENANT_DATABASE_OVERRIDES` | restricted **app role** (NOBYPASSRLS) |
| Migrations / provisioning | `TENANT_DATABASE_DIRECT_OVERRIDES` | schema **owner** (DDL) |

Both are JSON `{ tenantId: url }`. A tenant without an entry uses the shared `DATABASE_URL` /
`DIRECT_DATABASE_URL`.

## Migrations across siloed databases

The shared DB is migrated as usual. Siloed databases get the **same** migrations via a fan-out:

```bash
# 1. shared/control-plane DB
pnpm --filter @munaxa/api prisma:deploy
# 2. every siloed tenant DB (reads TENANT_DATABASE_DIRECT_OVERRIDES; runs migrate deploy + app-role.sql)
pnpm --filter @munaxa/api migrate:tenants
```

`migrate:tenants` (`apps/api/scripts/migrate-tenants.cjs`) is idempotent and re-applies
`infra/postgres/app-role.sql` so the runtime role is granted on any new tables. CI/CD should run
both steps on every release; treat a partial failure as a failed deploy (one school's DB lagging
the schema).

## Super-admin wizard

The promotion is driven by a platform-plane wizard (Admin Portal → **Tenant databases**, gated by
`platform:tenant:manage`) backed by a tracked state machine on the `TenantDatabase` control-plane
table:

```
REQUESTED → PROVISIONED → MIGRATED → DATA_COPIED → VERIFIED → ACTIVE   (or → FAILED / ABORTED)
```

Each step is idempotent and recorded with a checklist + guidance. The **safe** steps are automatic;
the **destructive infra** steps (create the database, copy the data) are explicit operator‑confirmed
gates — the wizard tracks them and shows the runbook, it does not silently move data. API:
`POST /platform/tenant-databases` (start), `…/:tenantId/advance` (step), `GET …` (status/list). The
connection URL/secret is **never** stored in the row — only a reference; the URL lives in the secrets
manager, and the final `ACTIVE` step reminds the operator to add it to `TENANT_DATABASE_OVERRIDES`
and redeploy so routing takes effect.

## Promoting a school to its own database (runbook)

For the **same-server** case (split a pooled school onto its own database on the same Postgres
server), steps 1–2 are a single command — `scripts/promote-tenant.cjs` provisions, migrates, applies
the app role, copies the tenant's rows in FK-safe order (topo-sorted from the Prisma DMMF, with the
global `Permission` catalog carried whole so ids align and `RolePermission` scoped to the tenant's
roles), then verifies per-table row counts and exits non-zero on any mismatch. It is idempotent
(`createMany` with `skipDuplicates`):

```bash
TENANT_ID=<uuid> \
DIRECT_DATABASE_URL=<shared owner url> \
TARGET_DIRECT_URL=<new db owner url> \
CREATE_TARGET=1 \
pnpm --filter @munaxa/api promote:tenant
```

For a **separate server / on-prem** target, do it as discrete steps:

1. **Provision** the database: create it (own server / region / on-prem), then point the migration
   env at it and run `prisma migrate deploy` + `app-role.sql` (or add it to the registry and run
   `migrate:tenants`). Seed the permission catalog (`db:seed`).
2. **Move the data**: export the tenant's rows from the shared DB and import into the new DB
   (the schema is identical; carry the `Tenant` row + its roles so FKs/RLS resolve). Do this in a
   short maintenance window for that one school. (`promote-tenant.cjs` works here too whenever the
   runner can reach both databases.)
3. **Register**: add the tenant's URLs to `TENANT_DATABASE_OVERRIDES` (runtime) and
   `TENANT_DATABASE_DIRECT_OVERRIDES` (owner) in the secrets manager and redeploy. The
   `TenantConnectionManager` now routes that school to its own DB; all others are unaffected.
4. **Verify & clean up**: smoke-test the school, confirm reads/writes hit the new DB, then remove
   the migrated rows from the shared DB.

## On-prem / data-residency

Two flavours, both supported by this model:

- **School's database on-prem, app still in our cloud.** Put the school's PostgreSQL URL in the
  registry. The cloud API must reach it over a secure link (VPN / private link); the school owns
  running Postgres, the app role, and backups. Latency applies.
- **Everything on-prem (air-gapped / full residency).** Deploy the whole Munaxa stack (API +
  Postgres) on the school's premises as a **single-tenant** instance — same image, one tenant, local
  DB. No routing needed; it is just a dedicated deployment.

## Operational notes

- **Connection budget.** Each distinct siloed URL gets one cached client; size pools so
  `instances × pools ≤ each DB's max_connections`. Use a pooler (PgBouncer / Hyperdrive) if pod
  count is high.
- **Backups.** Shared DB backs up once for all pooled schools; each siloed DB backs up on its own
  schedule (a selling point for residency).
- **Caching.** The registry is read at boot; changing a school's tier requires a redeploy (or, later,
  a DB-backed registry with cache invalidation).
- **Cost/ops scale with silo count** — keep silo an exception, not the default.
