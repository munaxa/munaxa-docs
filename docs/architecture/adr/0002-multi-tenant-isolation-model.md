# ADR-0002 — Shared database, row-level tenant isolation, RLS backstop

- **Status:** Accepted
- **Date:** 2026-07-31
- **Phase:** 0

## Context

Munaxa Docs is sold as SaaS to organisations whose documents are, by definition, the material they
least want leaked to a competitor. It must also be installable on-premise for a single customer.

The repository already contains a proven implementation of one isolation model: School's shared
database with a `tenantId` on every row, an `AsyncLocalStorage` context, a Prisma middleware and
PostgreSQL RLS on a `NOBYPASSRLS` application role
(`school/docs/architecture/03-multi-tenant-architecture.md`). It has been through a security audit
in this repository.

## Decision

Munaxa Docs uses **one PostgreSQL database, one schema, and a non-null `tenant_id` on every
business table**, with five enforcement layers: signed token claim → request-scoped context →
isolation guard → Prisma client extension → PostgreSQL RLS policies on a restricted role.

A single-organisation on-premise install is the same code with one tenant.

The **pattern** is taken from School; **no code is shared or imported** — products may never import
one another ([rulebook §4](../../../../PLATFORM_ENGINEERING_STANDARDS.md#4-dependency-rules)).

## Alternatives considered

1. **Database per tenant** — strongest isolation, but migrations, connection pooling and
   cross-tenant operational work all become N-shaped from day one. Kept as an explicit stage-4
   scaling option: `tenant_id` is on every row and every job, so routing the largest tenants to
   their own database later is a routing change, not a data model change
   ([19](../19-performance-and-scalability.md)).
2. **Schema per tenant** — the worst of both: migration fan-out without the isolation guarantee of
   separate databases.
3. **Application-only scoping, no RLS** — one forgotten `where` clause is a cross-tenant breach.
   Rejected: the backstop costs almost nothing and removes the entire class.

## Consequences

- One migration, one backup, one connection pool.
- Every table needs `tenant_id` and an RLS policy; the schema review checks for both.
- The application connects as a restricted role; migrations use a separate owner role.
- Cross-tenant queries are impossible by construction — including for support. Any future operator
  console must be a separate, permission-gated, fully audited surface.
