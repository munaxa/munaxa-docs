# Database security SQL

Two directories, because the statements run at two different times and mixing them breaks
both.

```text
sql/
├── provision/      before the first migration — mounted at the container entrypoint
└── post-migrate/   after every migration — applied by `pnpm db:post-migrate`
```

## Order

| # | Step | Runs as | When |
| --- | --- | --- | --- |
| 1 | `provision/*.sql` | superuser / bootstrap | Once, at database creation. Docker Compose mounts this directory into `/docker-entrypoint-initdb.d` |
| 2 | `prisma migrate deploy` | `edms_owner` | Every deploy |
| 3 | `post-migrate/*.sql` | `edms_owner` | Every deploy, immediately after step 2 |

`pnpm prisma:deploy` runs steps 2 and 3 together. Running step 3 twice is harmless; skipping it
is not — `post-migrate/01-tenant-isolation.sql` raises if any tenant-scoped table lacks a
row-level security policy, so a deploy that forgets it fails loudly rather than shipping a
table without isolation.

## Why the split

Nothing in `provision/` may reference a table: at that point the schema is empty. The earlier
single-file version referenced `audit_event` while being documented and mounted to run before
the first migration. It aborted on that line, and every statement below it — including all of
the row-level security policies — never ran. Isolation layer 5, the backstop that
[ADR-0002](../../docs/architecture/adr/0002-multi-tenant-isolation-model.md) calls the only
layer that survives an application bug, was silently absent.

## Adding a tenant-scoped table

Nothing to do. `post-migrate/01-tenant-isolation.sql` discovers every table in `public` that
carries a `tenant_id` column and applies `FORCE ROW LEVEL SECURITY` plus a `tenant_isolation`
policy to it. A hand-maintained list would be a hole waiting to open; discovery makes the
omission impossible rather than merely detectable.

The one table deliberately excluded is `tenant` itself, which has no `tenant_id` and is read by
the operator console under a separate role.
