# ADR-0021 — The hosted service launches multi-tenant: one deployment, one database per customer

- **Status:** Accepted (product-owner decision)
- **Date:** 2026-10-01
- **Phase:** Production Phase 0 (go-live decisions)
- **Builds on:** [ADR-0015](./0015-database-per-tenant.md) — it does not supersede it

## Context

[ADR-0015](./0015-database-per-tenant.md) settled _how_ tenants are isolated: every tenant has its own
database, storage prefix and search index, resolved through a placement. It left open _how many tenants
one production deployment serves_, because the code supports both answers:

- **single** — `TENANT_SLUG` + `TENANT_ID`, one tenant derived from the environment;
- **catalogue** — `TENANT_CATALOGUE` or `TENANT_CATALOGUE_PATH`, any number of tenants.
  `DEPLOYMENT_PROFILE=CLOUD` requires this form (`apps/api/src/core/config/configuration.ts`).

Munaxa Docs is to be sold as a hosted SaaS to multiple companies, and the first production deployment
needs one of the two. A read-only analysis of release `4e8e1ca` compared a deployment per customer with
one deployment serving many customers. This record keeps its conclusions for the model that was chosen.

## Decision

**The initial Munaxa-hosted SaaS launch is multi-tenant.** One production deployment of Munaxa Docs
serves multiple customer companies, using the catalogue form.

- **Each customer stays isolated in its own PostgreSQL database** (ADR-0015). The shared-database
  model of [ADR-0002](./0002-multi-tenant-isolation-model.md) stays superseded. Nothing in this
  record re-opens it.
- **Single-tenant (dedicated) deployments remain a future deployment model**, not a rejected one. The
  code already supports them, and on-premise is single-tenant by construction (ADR-0015).

This record does not choose a hosting provider, an orchestrator, tenant limits, RTO/RPO, owners or
budgets. Those remain open Phase 0 items.

## Consequences

Each consequence below describes the code as it stands at `4e8e1ca`. **None of them is fixed by this
record**: those that need work are prerequisites (next section).

### 1. API keys cannot be offered at launch (KEY-1)

An API key names no tenant. It is resolved only when the deployment has **exactly one** tenant; with
more than one, every API-key request is refused with `401`
(`apps/api/src/modules/identity/infrastructure/api-key.authenticator.ts`). On this deployment:

- **No API-key integration is offered.** Integrations use a user sign-in instead
  ([go-live-runbook.md §1a](../../operations/go-live-runbook.md)).
- **KEY-1 is an explicit launch limitation that requires formal sign-off** before go-live. Earlier,
  it was accepted only on condition that the launch was single-tenant. This decision removes that
  condition, so the acceptance has to be given again for a multi-tenant launch.

### 2. Tenant provisioning uses the documented workaround (D-1)

`provision.js` reads `TENANT_SLUG`, and configuration refuses `TENANT_SLUG` alongside a catalogue.
Each tenant is therefore provisioned **in single-tenant form**: `TENANT_ID`/`TENANT_SLUG` for that
tenant, with that tenant's database.
This is the procedure in [go-live-runbook.md §6](../../operations/go-live-runbook.md) step 5. It is
known finding D-1 in
[release-candidate-final-validation.md §5](../../reports/release-candidate-final-validation.md).

No new provisioning implementation is introduced. Onboarding a tenant is, in order:

1. create its database;
2. add its catalogue entry;
3. migrate (`scripts/migrate-tenants.mjs`);
4. restart the API, because the catalogue is read once at start-up;
5. provision in single-tenant form.

D-1 is a launch limitation requiring formal sign-off.

### 3. Runtime catalogue and operator migration information are kept apart

The tenant catalogue contains connection strings, so it is secret material that still needs version
tracking.

- **The runtime catalogue holds only what the running API needs:** each tenant's `id` and `slug`, its
  application-role connection string (`edms_app`, `NOBYPASSRLS`), and its storage and search placement.
- **The running API's configuration holds no owner or migration credentials:**
  - no `database.migrationUrl`;
  - no `defaults.migrationUrlTemplate`;
  - no `DATABASE_MIGRATION_URL`.

  All three are optional in the schema (`apps/api/src/core/tenancy/tenant-placement.ts`).
- **`scripts/migrate-tenants.mjs` needs the owner role's URL for every tenant** and reads the same
  catalogue format. It is therefore given a separate **operator catalogue**. That catalogue is held by
  the operator, is used only for migrations, and is never injected into the running API.
- **The two catalogues must name the same tenants with the same `id` and `slug`.** Drift between them
  is how a tenant comes to be missed by a migration. Keeping them aligned is a prerequisite, not an
  assumption.

### 4. One unavailable tenant database makes readiness fail for the whole deployment — known issue

`/api/health/ready` probes each tenant database separately. **If any one is `DOWN`, the aggregate is
`DOWN` and the endpoint answers `503` on every API instance**
(`apps/api/src/core/observability/health/health.service.ts`).

A load balancer or orchestrator that removes or replaces instances on that signal would turn one
customer's database outage into an outage for every customer. The probe also covers only the first
`DATABASE_MAX_TENANT_CLIENTS` tenants and labels the result "sampled N of M".

**Not fixed by this record.** It needs a technical design and verification before production. That
covers how readiness, liveness and the platform's health checks are wired for a multi-tenant
deployment, and whether a code change is needed.

### 5. Connection scaling

Each tenant has its own connection pool. One API process can hold up to `DATABASE_MAX_TENANT_CLIENTS`
(default **25**) × `DATABASE_POOL_SIZE` (default **10**) = **250** connections, multiplied by the
number of API processes. All of that has to fit within PostgreSQL's `max_connections`.

ADR-0015 already says a connection pooler is needed at hundreds of tenants. **The connection budget
and the pooler strategy must be validated against the expected tenant count** before production, and
again as tenants are added.

### 6. Storage: one bucket, one static credential

There is one S3 adapter, bound to one `STORAGE_BUCKET`. It signs with one global static credential
(`apps/api/src/infrastructure/infrastructure.module.ts`) and has no container- or role-based credential
provider, whatever its comment says.

Tenant separation within the bucket is the per-tenant prefix, which `TenantScopedStorage` adds to every
key and checks on every answer. A catalogue entry may name its own storage `container`, but the code was
only seen using that in the start-up collision check; no routing of a tenant to a different bucket was
found.

**Per-tenant bucket routing must be verified before anything relies on it.** The storage
implementation is unchanged.

### 7. Redis and queues are shared

The deployment has one `REDIS_URL` and no key-prefix setting. BullMQ queues, the cache, locks and rate
limits are shared by every tenant in it; cache keys carry the tenant id. A backlog or burst from one
tenant delays the others.

**Redis capacity and noisy-neighbour behaviour must be considered** in capacity planning and the load
baseline. Redis is unchanged.

### 8. A point-in-time recovery for one tenant means restoring the whole cluster

WAL-based point-in-time recovery (PITR) restores a **whole PostgreSQL cluster**, not one database. A
managed PostgreSQL service restores a whole instance.

Recovering one tenant to a point in time therefore means:

1. restore the whole cluster to that time, into a **new** cluster;
2. extract that tenant's database from it;
3. restore it under a new name;
4. verify the audit chain, then repoint the tenant's catalogue entry.

A restore from that tenant's own logical dump is per tenant, but it only reaches the dump's time.

This holds unless a different architecture is later approved. **The recovery rehearsal (prerequisite
7b) must include a single-tenant point-in-time recovery done this way**, timed and with the chain
verified.

### 9. Shared infrastructure, and a compliance review

Everything below is shared at deployment level, across every customer:

- `JWT_ACCESS_SECRET`, `SIGNATURE_WITNESS_SECRET`, `AUDIT_CHECKPOINT_SECRET` and
  `MFA_TOTP_SEALING_KEY`;
- the S3 credential and bucket;
- Redis;
- the malware scanner;
- the database cluster and its encryption at rest;
- the API processes, which hold every tenant's runtime connection string.

A compromise of one of these affects every customer on the deployment. Data residency is decided per
deployment, not per tenant.

**This record does not claim the arrangement satisfies every customer's compliance requirements.** A
compliance review is required before go-live, and again for any customer whose requirements are
stricter than the review covered. A dedicated deployment is the route the code already supports for
such customers.

### 10. Commercial onboarding is operator-driven

Tenants are provisioned by an operator command. The application has **no billing, self-service signup
or commerce functionality** and no custom-domain or subdomain tenant selection. Users type their
organisation at sign-in. Those capabilities are "Later" in
[21 §7](../21-saas-commercial-architecture.md). Selling to a new customer is the onboarding procedure
in §2 above.

### Unchanged by this decision

- **WF-1** (built-in role keys cannot be workflow participants) applies identically in either model.
- **The tenant boundary.** Isolation is still the signed token's tenant claim plus a database per
  tenant, with row-level security inside each. The host is never read for a tenant.

## Prerequisites this decision adds before production

These are in addition to every prerequisite already in
[production-prerequisites-checklist.md](../../operations/production-prerequisites-checklist.md), none of
which changes status because of this record.

| # | Prerequisite | From |
| --- | --- | --- |
| 1 | Formal sign-off of KEY-1 and D-1 as launch limitations for a multi-tenant deployment | §1, §2 |
| 2 | A runtime catalogue with no owner credentials, a separate operator catalogue, and a check that the two do not drift | §3 |
| 3 | A design for readiness, liveness and platform health checks under multiple tenants, verified so that one tenant database outage is not a deployment-wide outage | §4 |
| 4 | A connection budget and pooler strategy validated for the expected tenant count | §5 |
| 5 | Verification of per-tenant bucket routing before it is relied on; until then, one bucket and one credential | §6 |
| 6 | Redis capacity and noisy-neighbour behaviour covered by capacity planning and the load baseline | §7 |
| 7 | A single-tenant point-in-time recovery (whole-cluster restore and extraction) in the recovery rehearsal | §8 |
| 8 | A compliance review of the shared infrastructure | §9 |
| 9 | A written tenant onboarding procedure, including the restart, under change control | §2, §10 |

## Alternatives considered

1. **A deployment per customer (single-tenant).** API keys work, nothing is shared between customers,
   and a fault or upgrade window affects one customer. The cost is a full stack, secret set, change
   record and upgrade per customer. **Not rejected — deferred** as the future dedicated model.
2. **A shared database across customers.** Already superseded by ADR-0015 and explicitly out of scope
   for this decision.
