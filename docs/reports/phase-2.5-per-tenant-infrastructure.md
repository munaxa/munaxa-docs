# Phase 2.5 — per-tenant infrastructure: what moved, what did not, and what it costs

**Status:** point-in-time record of the deployment-agnostic refactor. Historical — superseded, never revised.
**Audience:** whoever builds Phase 3 and after, and whoever has to operate this.

Phase 2.5 is not a feature phase. It is the refactor that gives every company its own database, its own
storage location and its own search index, so that no later phase has to change the architecture to
support multi-tenancy, cloud deployment or on-premise deployment.

The decision is [ADR-0015](../architecture/adr/0015-database-per-tenant.md), which supersedes
[ADR-0002](../architecture/adr/0002-multi-tenant-isolation-model.md). Phases 1 and 2 are intact: no
domain type, no application service and no use case changed.

## 1. What ADR-0002 predicted

It is worth quoting, because it is the reason this took a week rather than a quarter:

> **Database per tenant** — strongest isolation, but migrations, connection pooling and cross-tenant
> operational work all become N-shaped from day one. Kept as an explicit stage-4 scaling option:
> `tenant_id` is on every row and every job, so routing the largest tenants to their own database later
> is a routing change, not a data model change.

It was right. The refactor is a routing change. `tenant_id` stayed on every row, every repository kept
its predicate, and the only file that had to learn about placement is the one that opens transactions.

## 2. What was built

| Piece | What it does |
| --- | --- |
| `core/tenancy/tenant-placement.ts` | What a placement *is* — database, storage container and prefix, search index — and how a catalogue resolves into complete ones |
| `core/tenancy/tenant-registry.port.ts` | `bySlug`, `byId`, `all`. The seam that makes one codebase serve both deployments |
| `core/tenancy/config-tenant.registry.ts` | The adapter: one placement derived from the environment, or a catalogue inline or mounted |
| `core/prisma/tenant-database.ts` | A bounded LRU of per-tenant Prisma clients, lazily connected, disposed on eviction and shutdown |
| `infrastructure/tenancy/tenant-scoped-storage.ts` | Prefixes and validates every storage key, both directions |
| `infrastructure/tenancy/tenant-scoped-search.ts` | Overrides the subject's tenant and supplies the index, so an adapter cannot forget either |
| `scripts/migrate-tenants.mjs` | Migrates every tenant in the catalogue: per-database SQL, schema, post-migration SQL |
| `infra/sql/{cluster,database}/` | The provisioning SQL, split by scope |

### The deployment profile is configuration, not a branch

`DEPLOYMENT_PROFILE` decides two things: whether a catalogue is required, and which providers production
will accept. `ON_PREMISE` permits a local filesystem in production and derives its one tenant from
`TENANT_SLUG` and `TENANT_ID`; `CLOUD` requires a catalogue and refuses `LOCAL` storage, because a
filesystem is not shared between instances.

It is read by the registry and by boot validation, and by nothing else. Business logic that branched on
it would behave differently for a customer who bought the same product.

## 3. Two things got *simpler*

Worth recording, because a refactor that only adds cost is usually the wrong refactor.

**Sign-in no longer queries a shared table.** Resolving a slug to a tenant was the one query in the
product that ran outside a tenant context — it had to, because determining the tenant is what it was
for. Under ADR-0015 the slug resolves through the registry, so sign-in touches a database only after it
knows which one, and every statement it issues is inside that tenant's transaction like every other
statement in the product. `PrismaTenantDirectory` was deleted.

**Provisioning is one transaction, including the tenant row.** It could not be before: the tenant
identifier was generated mid-bootstrap, so there was no context to open a transaction under until the
row existed — which meant the tenant row was the one piece that could survive a rollback. The
identifier now comes from the registry, an operator holds it before provisioning runs, and the whole
bootstrap commits or does not.

## 4. What it costs

Stated plainly, because these are the things an operator will meet.

| Cost | Detail | Mitigation |
| --- | --- | --- |
| **Connections** | Each tenant client owns a pool: `DATABASE_MAX_TENANT_CLIENTS × DATABASE_POOL_SIZE` per process, inside `max_connections` | Bounded LRU with eviction; past a few hundred tenants per process, PgBouncer in transaction mode — safe, because the tenant setting is transaction-local |
| **Migrations are N-shaped** | A release visits every tenant database, sequentially | Fail-fast, idempotent, names the tenant it stopped on. A long backfill is a job, not a migration |
| **Cross-tenant questions are a fan-out** | "How many documents across all customers" was a query | The intended direction — ADR-0002 already required cross-tenant queries to be impossible — but reporting and any operator console pay for it |
| **Adding a cloud tenant needs a restart** | The catalogue is resolved once, at boot | Deliberate: resolving lazily turns a misconfigured tenant into one customer's 500 instead of a failure to start. A control-plane adapter removes it |
| **Placement must not drift from data** | A `TENANT_ID` edited after provisioning points a database full of rows at a tenant nobody can reach | Colliding placements refused at boot; provisioning refuses a second run. Nothing can undo a hand-edited identifier |
| **Health is per tenant** | One probe per database, sampled beyond the client bound | Reported separately and honestly labelled, so one customer's unreachable database does not read as "this instance cannot serve traffic" |

## 5. Deliberate limits

| Limit | Why | Unblocked by |
| --- | --- | --- |
| The registry has one adapter — configuration | A control-plane database is the right answer for self-service signup, and there is no self-service signup: provisioning is an operator command. Building it now means a second Prisma schema, client and migration pipeline for a workflow nothing performs | A `TenantRegistry` adapter, and nothing above it |
| No storage or search adapter yet | Both ports still refuse, naming the variable that would configure them. What Phase 2.5 built is the *isolation*, so the adapter written in Phase 3 or Phase 8 inherits it and cannot opt out | Phase 3 (upload), Phase 8 (search) |
| Tenant databases are not created automatically | An empty database is created by an operator, then added to the catalogue, then migrated. Creating one from the application would mean the API holding a credential that can `CREATE DATABASE` | A provisioning pipeline, if self-service signup ever exists |
| The outbox dispatcher is still unbound | Unchanged from Phase 2. Events accumulate transactionally; nothing consumes them | R5 |

## 6. Defects found while doing it

**The provisioning SQL mixed two scopes and hardcoded the database name.** `GRANT CONNECT ON DATABASE
edms` is right for exactly one database, and `current_tenant_id()` is per database while `CREATE ROLE`
is per cluster. Under a single database nothing exposed this. The second tenant database migrated
cleanly and then failed on `function current_tenant_id() does not exist` — three commands after the
actual omission. Split into `infra/sql/cluster/` (roles, once, as a superuser) and
`infra/sql/database/` (grants, default privileges and the tenant function, once per database, against
`current_database()`), and the migration runner applies the latter itself, so a fresh tenant database is
self-provisioning.

Worth noting how it was found: by running the new migration runner against a real second database rather
than by reading the SQL. The failure was three steps downstream of its cause, which is exactly the kind
of thing a review does not catch.

## 7. Verification

| Gate | Result |
| --- | --- |
| `pnpm typecheck` | Clean across all seven packages |
| `pnpm lint` | Clean |
| `pnpm test` | 223 API tests (up from 188 — the registry, the placement resolver and the storage scoping), plus the shared packages and 21 web tests |
| `pnpm test:integration` | 13 files / 189 tests against real PostgreSQL, including six against **two** databases |
| `pnpm build` | Clean, API and web |
| `pnpm prisma:deploy` | Verified in both shapes: one database from the environment, and two from a catalogue |

The suite that matters most is `tenant-isolation.integration.spec.ts`, because its assertions cannot be
satisfied by a `WHERE` clause. Both tenants use the same slug and the same company code — two customers
choosing "HQ" is the ordinary case — and the sharpest check is Acme's context with Rival's identifier,
against a database that has never held Rival's row. It **skips rather than passes** when
`SECOND_DATABASE_URL` is absent: a test that quietly ran both tenants against one database would assert
nothing and say it had.

Every other integration suite still runs both tenants through **one** database, and that is deliberate
rather than left over. It is the layer underneath this one — a tenant column and an RLS policy keeping
two companies apart when they share a database — and it is what an on-premise installation serving two
companies relies on entirely.
