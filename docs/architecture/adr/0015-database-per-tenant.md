# ADR-0015 — One database, storage location and search index per tenant

- **Status:** Accepted
- **Date:** 2026-08-03
- **Phase:** 2.5
- **Supersedes:** [ADR-0002](./0002-multi-tenant-isolation-model.md)

## Context

[ADR-0002](./0002-multi-tenant-isolation-model.md) chose a shared database with a `tenant_id` on every
row and five enforcement layers. It also named the alternative it was keeping in reserve, and why it
would be cheap to reach for:

> **Database per tenant** — strongest isolation, but migrations, connection pooling and cross-tenant
> operational work all become N-shaped from day one. Kept as an explicit stage-4 scaling option:
> `tenant_id` is on every row and every job, so routing the largest tenants to their own database later
> is a routing change, not a data model change.

Three things have changed since, and together they move the balance.

**The product is sold on the isolation.** Munaxa Docs holds the documents an organisation least wants
leaked to a competitor. "Your records are in a database no other customer connects to" is a claim a
procurement questionnaire asks for and a shared schema cannot make, however many layers guard it.

**On-premise is a first-class deployment, not a variant.** A customer installing on their own server
has exactly one tenant and expects one database they can back up, restore and inspect with the tools
they already run. Under a shared model that installation is a special case of a multi-tenant schema;
under this one it is the ordinary case with the catalogue omitted.

**The reserve option has to be exercised to be real.** An architecture that *could* move a tenant to
its own database, but never has, is an architecture nobody has tested. Every phase built on the shared
assumption makes the eventual move more expensive, and the phases that follow this one — upload,
revisions, search projections — are the ones that would have made it prohibitive.

## Decision

Every tenant gets **its own database, its own storage location, and its own search index**. Where each
one lives is a **tenant placement**, resolved through a `TenantRegistry` port.

| Concern | Before | Now |
| --- | --- | --- |
| Rows | One database, `tenant_id` predicate, RLS | One database per tenant; `tenant_id` and RLS retained inside it |
| Bytes | One bucket | A container and a per-tenant prefix, applied and checked by the port |
| Index | One index | One index per tenant, supplied to the adapter rather than chosen by it |
| Migrations | One `prisma migrate deploy` | One per tenant, sequential and fail-fast, from the same catalogue the API reads |
| Sign-in | Query a shared `tenant` table by slug | Resolve the slug through the registry — no query before the tenant is known |

**`tenant_id` stays on every row, and so does row-level security.** That is not vestigial. The schema is
identical in both deployments, an on-premise installation may legitimately serve two companies from one
PostgreSQL, and defence in depth inside a tenant's own database costs nothing. What changes is that it
is no longer the *only* thing standing between two customers.

**The registry is a port with one adapter today.** `ConfigTenantRegistry` derives a single placement
from the environment — which is the whole of an on-premise installation's tenancy configuration — or
reads a catalogue given inline or as a mounted file. A control-plane database is a second adapter and
nothing above it moves.

**The deployment profile is configuration, not a code path.** `DEPLOYMENT_PROFILE` decides two things:
whether a catalogue is required, and which providers production will accept. It is read by the registry
and by boot validation, and by nothing else. Business logic that branched on it would behave
differently for a customer who bought the same product.

## Alternatives considered

1. **Keep the shared database and rely on the five layers.** They work — the audit found no hole — but
   they are all *application* layers plus one database policy, and none of them can be shown to a
   customer as a boundary. Rejected because the product's claim is about the boundary, not about the
   care taken at it.

2. **Schema per tenant.** Migration fan-out without separate backups, separate restore, or separate
   connection limits. ADR-0002 called this "the worst of both" and that has not changed.

3. **A control-plane database as the registry, now.** It is the right answer for self-service signup,
   and there is no self-service signup: provisioning is an operator command. Building it now would mean
   a second Prisma schema, a second client and a second migration pipeline in service of a workflow
   nothing performs. Deferred behind the port, which is the difference between a limit and a rewrite.

4. **Route only the largest tenants to their own database, as ADR-0002 sketched.** Two isolation models
   in one codebase, and the weaker one applies to exactly the customers nobody is watching closely.
   Rejected: the uniform version is simpler to reason about and simpler to test.

## Consequences

**Better than before.**

- One customer's data is in a database no other customer's process connects to. Backup, restore,
  retention and deletion are per customer, which is what a data-processing agreement asks for.
- A noisy tenant's locks, bloat and long queries stay inside its own database.
- Sign-in no longer runs a query outside a tenant context — the last one in the product.
- Provisioning is one transaction including the tenant row, because the identifier now comes from
  configuration rather than being invented mid-bootstrap.
- A per-tenant partial unique index means two customers may both use the code `HQ` without a shared
  index deciding it for them.

**Worse than before, and worth stating plainly.**

- **Connections.** Each tenant client owns a pool, so the ceiling is `DATABASE_MAX_TENANT_CLIENTS ×
  DATABASE_POOL_SIZE` per process and it has to fit inside `max_connections`. The client cache is
  bounded and evicts the least recently used, which costs a reconnect. A deployment with hundreds of
  tenants needs a connection pooler in front, and that is a deployment decision this ADR does not make.
- **Migrations are N-shaped.** A release visits every tenant database. A run that fails halfway leaves
  a known prefix migrated and names the tenant it stopped on; every step is idempotent so the re-run is
  safe. But a schema change is now a longer, more visible operation, and a long-running migration
  against four hundred databases is a maintenance window rather than a deploy step.
- **Cross-tenant questions are harder, not merely forbidden.** "How many documents exist across all
  customers" was a query; it is now a fan-out. That is the intended direction — ADR-0002 already said
  cross-tenant queries must be impossible by construction — but reporting and the operator console pay
  for it.
- **Adding a tenant to a running cloud deployment requires a restart**, because the catalogue is
  resolved once at boot. Resolving lazily would turn a misconfigured tenant into a 500 for one customer
  instead of a failure to start; the restart is the price of finding out at boot. A control-plane
  adapter removes it.
- **A tenant's placement is configuration that must not drift from its data.** A `TENANT_ID` changed
  after provisioning points a database full of rows at a tenant nobody can reach. The registry refuses
  colliding placements at boot, and provisioning refuses to run twice against the same database, but
  nothing can undo an identifier edited by hand.

## Compliance

- Every tenant-scoped table still carries `tenant_id`, and `infra/sql/post-migrate/01-tenant-isolation.sql`
  still raises if one lacks a policy. The schema review checks for both.
- The application connects as `edms_app` (`NOBYPASSRLS`) in every tenant database; migrations use
  `edms_owner`.
- `infra/sql/` is split by scope: `cluster/` for roles, `database/` for a database's grants and its
  tenant function, `post-migrate/` for anything referencing a table.
- Storage keys are prefixed and validated by `TenantScopedStorage`; search subjects and indexes by
  `TenantScopedSearch`. Neither is optional, because a vendor adapter is bound underneath them.
- Cross-tenant operations remain impossible from a request path. Any future operator console is still a
  separate, permission-gated, fully audited surface
  ([ADR-0013](./0013-operator-console-as-separate-surface.md)).
