# Database security SQL

Three directories, because the statements run at three different **scopes**, and mixing them
breaks all of them.

```text
sql/
├── cluster/        once per cluster — the roles, and the local password for edms_app.
│                   Mounted at the container entrypoint
├── database/       once per tenant database — its grants and its tenant function
└── post-migrate/   after every migration — row-level security and audit immutability
```

Under [ADR-0015](../../docs/architecture/adr/0015-database-per-tenant.md) a deployment has one
database per company, so the middle and last directories run **N times** and the first runs once.

## Order

| # | Step | Scope | Runs as | When |
| --- | --- | --- | --- | --- |
| 1 | `cluster/*` | cluster | superuser / bootstrap | Once. Docker Compose mounts it into `/docker-entrypoint-initdb.d`, which applies it in filename order |
| 2 | `database/*.sql` | database | `edms_owner` | Once per tenant database, before its first migration |
| 3 | `prisma migrate deploy` | database | `edms_owner` | Every deploy, per tenant |
| 4 | `post-migrate/*.sql` | database | `edms_owner` | Every deploy, per tenant, immediately after step 3 |

`pnpm prisma:deploy` runs steps 2 to 4 for every tenant in the catalogue, sequentially and
fail-fast. Every step is idempotent, so a run that stopped halfway is resumed by running it again;
what is not safe is a *partial* deployment left in place, which is why it names the tenant it
stopped on.

Skipping step 4 is not harmless — `post-migrate/01-tenant-isolation.sql` raises if any
tenant-scoped table lacks a row-level security policy, so a deploy that forgets it fails loudly
rather than shipping a table without isolation.

## Why `edms_app` has no password here

`01-roles.sql` creates it with `LOGIN` and no password, which is right for production: the credential
is issued by whatever the deployment uses for credentials, and a password committed to this
repository would be a prohibited action
([17](../../docs/architecture/17-security-architecture.md) §10).

It is wrong for a local cluster, though, and silently so. The official image defaults to
`scram-sha-256`, and a role with no stored verifier cannot authenticate under it — so the
`DATABASE_URL` in `.env.example`, which connects as `edms_app` with a password, failed at the first
query with `password authentication failed for user "edms_app"`. Nothing caught it because nothing in
CI had ever connected as the application role.

`02-app-credentials.sh` closes that: it assigns the password in `EDMS_APP_PASSWORD` if the variable
is set, and does nothing if it is not. Compose sets it beside the `POSTGRES_PASSWORD` it already
declares; production leaves it unset. A shell script rather than SQL because the entrypoint runs
`.sql` files through psql with no variables passed, so SQL cannot read the environment.

The entrypoint only applies this directory when it initialises a **new** data directory. An existing
volume needs the script run by hand, or `docker compose down -v` first.

## Why roles are separate from grants

A PostgreSQL role is cluster-scoped and a grant is not. `edms_app` is the same role in every
tenant database, so creating it per database would fail on the second one — and a deployment that
let that failure pass quietly would have a database whose application role was never restricted to
`NOBYPASSRLS`. `GRANT CONNECT`, the schema grants, the default privileges and
`current_tenant_id()` all belong to a database, so they are applied once per database, against
`current_database()` rather than a hardcoded name.

## Why the split

Nothing in `cluster/` or `database/` may reference a table: at that point the schema is empty. The earlier
single-file version referenced `audit_event` while being documented and mounted to run before
the first migration. It aborted on that line, and every statement below it — including all of
the row-level security policies — never ran. The backstop that survives an application bug was
silently absent.

## Adding a tenant-scoped table

Nothing to do. `post-migrate/01-tenant-isolation.sql` discovers every table in `public` that
carries a `tenant_id` column and applies `FORCE ROW LEVEL SECURITY` plus a `tenant_isolation`
policy to it. A hand-maintained list would be a hole waiting to open; discovery makes the
omission impossible rather than merely detectable.

The one table deliberately excluded is `tenant` itself, which has no `tenant_id` and is read by
the operator console under a separate role.
