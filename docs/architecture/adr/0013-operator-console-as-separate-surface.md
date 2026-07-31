# ADR-0013 — Cross-tenant operations live in a separate, fully audited console

- **Status:** Accepted
- **Date:** 2026-07-31
- **Phase:** 0

## Context

[ADR-0002](./0002-multi-tenant-isolation-model.md) makes cross-tenant queries impossible by
construction: the application connects as a `NOBYPASSRLS` role and every query is scoped by the
signed `tenant_id` claim. That is the correct default, and it means the people running the SaaS —
support, billing, provisioning, incident response — have **no** path to a tenant's data.

Support work is real. Without a designed answer, it arrives as an undesigned one: a shared admin
account, a "support mode" flag on the normal API, or an engineer with a psql session. All three are
how document-management systems leak.

## Decision

1. Cross-tenant operations live in a **physically separate surface**: distinct routes
   (`/api/platform/*`), distinct guards, distinct roles (`PLATFORM_OWNER`, `PLATFORM_ADMIN`,
   `SUPPORT_AGENT`), and a token carrying a `platform` scope instead of a `tenant_id`.
2. **A platform token can never reach a tenant route, and a tenant token can never reach a platform
   route.** This is asserted at boot, not left to route configuration.
3. The console's default reach is **metadata, not content**: tenant status, subscription, usage,
   job and queue health, provisioning, audit *counts*. Reading a customer's document content is a
   separate, higher-privileged action.
4. Any access to tenant data requires an **impersonation session**: bounded in time, scoped to one
   tenant, requiring a stated reason, **visible to that tenant's administrators**, and recorded as
   `SUPPORT_ACCESS_STARTED` / `ENDED` plus an ordinary audit event for every action taken inside it.
5. Impersonation sessions are **read-only by default**; write actions require a second permission
   and appear in the tenant's own audit trail attributed to the operator, never to a tenant user.
6. The RLS backstop is not bypassed. An impersonation session sets the tenant GUC for that tenant
   only — so the console gets exactly one tenant at a time, never a cross-tenant join.

## Alternatives considered

1. **A "super admin" role inside the normal application** — one permission-check mistake exposes
   every tenant, and the audit trail cannot distinguish an operator from a customer. Rejected.
2. **Direct database access for support** — invisible to audit, and the exact thing the tenant is
   trusting the product not to allow. Rejected; the console exists so this never has to happen.
3. **A `BYPASSRLS` connection for the console** — one flag away from the whole estate. Rejected in
   favour of per-session tenant scoping.
4. **No console; support asks the customer to reproduce** — honest, and it does not survive contact
   with an incident at 2am.

## Consequences

- The console is a build cost the product would not otherwise carry, and it is not optional for a
  SaaS deployment.
- Tenants must be able to *see* support access — the transparency is what makes it acceptable to a
  compliance buyer, and it is a feature to sell, not a disclosure to bury.
- Cross-tenant aggregate reporting (fleet health, usage, revenue) reads from **aggregates only**,
  computed by jobs that touch one tenant at a time. There is no cross-tenant join anywhere in the
  system.
- On-premise installs ship without the console; its absence must not disable anything the product
  needs.
- Related: [21 — SaaS Commercial Architecture](../21-saas-commercial-architecture.md),
  [17 — Security Architecture](../17-security-architecture.md).
