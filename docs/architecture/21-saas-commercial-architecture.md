# 21 — SaaS Commercial Architecture

**Purpose:** the commercial layer around the product — tenancy as a business relationship,
subscriptions, entitlements, metering, provisioning, and cross-tenant operations.
**Audience:** backend engineers; whoever prices the product.

This document covers what the SaaS *business* needs. The product architecture (00–20) does not
change because of it: everything here is additive, and every mechanism sits beside the permission
model rather than inside it.

## 1. The commercial model

| Decision | Choice | Recorded in |
| --- | --- | --- |
| Isolation | A database, storage location and search index per tenant | [ADR-0015](./adr/0015-database-per-tenant.md) |
| Dedicated-database tenants | Every tenant, not only the largest — the routing is uniform | [ADR-0015](./adr/0015-database-per-tenant.md) |
| Hosted launch | Multi-tenant: one deployment serves many customer companies, each in its own database | [ADR-0021](./adr/0021-multi-tenant-hosted-launch.md) |
| Dedicated deployments | Single-tenant, for a customer who needs one — a future deployment model, not the launch | [ADR-0021](./adr/0021-multi-tenant-hosted-launch.md) |
| On-premise | The same code with a single tenant and local drivers | [20](./20-deployment-architecture.md) §2 |
| Plans and limits | Data, not code; enforced centrally | [ADR-0012](./adr/0012-entitlements-as-data-enforced-centrally.md) |
| Cross-tenant operations | A separate, permission-gated, fully audited console | [ADR-0013](./adr/0013-operator-console-as-separate-surface.md) |

What the hosted service is, stated once so it is not re-litigated: **one multi-tenant deployment
serving many companies, with a separate PostgreSQL database per tenant**
([ADR-0015](./adr/0015-database-per-tenant.md), [ADR-0021](./adr/0021-multi-tenant-hosted-launch.md)).
The application tier is shared — the API and web processes, Redis and its queues, the malware
scanner, the object-storage bucket and its credential, and the deployment's signing keys — while each
tenant's rows live in a database no other tenant's queries reach, and each tenant's bytes under its
own storage prefix. The trade-offs follow from that, not from a shared schema:

- **Onboarding is an operator procedure, not a transaction.** A tenant is given a database, a
  catalogue entry and a migration, the API is restarted to read the catalogue, and the tenant is then
  provisioned in single-tenant form (known finding D-1; [20](./20-deployment-architecture.md) §8,
  [go-live-runbook.md §6](../operations/go-live-runbook.md)).
- **Migrations and backups are per tenant database.** A release migrates every tenant database in
  turn; a logical backup and restore is per tenant; point-in-time recovery is per PostgreSQL cluster
  ([backup-and-restore.md](../operations/backup-and-restore.md) §1–§2).
- **Isolation is a boundary and still a property to prove.** `tenant_id` and forced row-level security
  stay on every row inside each tenant's database, and the isolation tests keep running, because the
  schema is the same for an on-premise installation that serves two companies from one database.
- **What is shared is shared by every tenant**, and a compliance review decides where that is
  acceptable ([ADR-0021](./adr/0021-multi-tenant-hosted-launch.md) §9). A customer who needs more is
  the future dedicated deployment, not a special case in code.

## 2. Domain additions

One new bounded context, **Commerce**, plus a **Platform** context for cross-tenant operations.

```mermaid
graph TB
    PLAN[Plan<br/>features · limits · price] --> SUB[Subscription<br/>tenant · plan · term · status]
    SUB --> ENT[Entitlement snapshot<br/>resolved features + limits]
    SUB --> INV[Invoice / billing record]
    USE[UsageCounter<br/>seats · documents · storage · jobs] --> ENT
    ENT --> GUARD[Entitlement guard]
    USE --> INV
```

| Aggregate | Owns | Notes |
| --- | --- | --- |
| `Plan` | Feature flags, limits, price points, billing period | Versioned; a published version is immutable, so a price change never rewrites history |
| `Subscription` | Tenant, plan version, term, status, trial dates, cancellation | One live subscription per tenant |
| `Entitlement` | The resolved set of features and limits for a tenant | Derived from plan + overrides; cached, recomputed on change |
| `UsageCounter` | Metered quantities per tenant per period | Seats, documents, storage bytes, preview/OCR jobs, API calls |
| `BillingRecord` | Invoices, payment state | Provider-agnostic; the payment provider is a port |

Subscription status drives tenant status ([20](./20-deployment-architecture.md) §8): `TRIALING`,
`ACTIVE`, `PAST_DUE` (read-only for writes that grow usage), `SUSPENDED` (read-only entirely),
`CANCELLED` → offboarding export → purge. **A tenant in arrears never loses read access to their own
records before the contractual export window** — withholding a customer's controlled documents is
not a collections strategy, and for a compliance product it is a liability.

## 3. Entitlements vs permissions

These are two different questions and must never be merged:

| | Question | Failure | HTTP |
| --- | --- | --- | --- |
| **Permission** | May *this user* do this? | Authorisation failure | `403` (or `404` cross-scope) |
| **Entitlement** | Does *this tenant's plan* include this? | Commercial limit | `402 Payment Required` with an upgrade hint |

Both are checked; entitlement first, because "your plan does not include workflow designer" is a
clearer answer than "forbidden". Neither can grant what the other denies.

```ts
@RequirePermission(Permission.WORKFLOW_MANAGE)
@RequireFeature(Feature.CUSTOM_WORKFLOWS)
@EnforceLimit(Limit.DOCUMENTS)          // checked before creation, not after
```

Enforcement points, all central — [ADR-0012](./adr/0012-entitlements-as-data-enforced-centrally.md):

| Kind | Example | Enforced at |
| --- | --- | --- |
| Feature | OIDC federation, custom workflows, OCR, API access, webhooks, legal hold | Guard on the route, plus the `capabilities` payload so the UI shows an upgrade path rather than a dead button |
| Hard limit | Seats, storage bytes, document count | Before the mutating use case commits — an upload presign is refused, not the completed upload |
| Soft limit | Preview/OCR jobs per month, API calls per minute | Throttled and reported, not refused, with an administrator notification at 80% and 100% |
| Retention ceiling | Maximum retention period on lower plans | Configuration validation at policy save time |

**Rule:** an entitlement check never appears inside a domain rule. Domain code decides whether a
document *may* be published; commerce decides whether the tenant *bought* the capability. Mixing
them makes the business logic untestable without a subscription fixture.

## 4. Metering

Usage is derived from the same domain events the rest of the system consumes
([ADR-0011](./adr/0011-transactional-outbox-for-async-work.md)), never from ad-hoc counters
sprinkled through use cases.

| Metric | Source event | Billing shape |
| --- | --- | --- |
| Seats | `UserActivated` / `UserDisabled` | Peak or end-of-period active users |
| Documents | `DocumentCreated` / `DocumentPurged` | Point-in-time count |
| Storage bytes | `FileObjectCreated` / `FileObjectDeleted`, net of dedupe | Average or peak over the period |
| Derived storage | Preview/OCR artefacts | Reported separately; excluded from quota by default ([11](./11-storage-architecture.md) §7) |
| Processing jobs | `PreviewCompleted`, `OcrCompleted` | Metered, soft-limited |
| API calls | Gateway counter | Rate-limited, metered on the API-access plan |

Counters are aggregated per tenant per period into `usage_counter`, reconciled nightly against the
source tables, and any drift is **reported, never silently corrected** — a billing number that
quietly changes is worse than one that is wrong and known.

Storage is the dominant variable cost, so it must be visible before it is priced: the administrator
UI shows live, deleted-but-retained, and derived bytes separately
([ADR-0010](./adr/0010-soft-delete-and-retention.md) consequences).

## 5. Provisioning and lifecycle

**Current behaviour, at release `4e8e1ca`.** There is no signup, no subscription and no automatic
provisioning. A tenant is provisioned by an **operator command** (`provision.js`), after the tenant
has been given a database and a catalogue entry and has been migrated; on a multi-tenant deployment
the command runs in single-tenant form for that one tenant (known finding D-1,
[go-live-runbook.md §6](../operations/go-live-runbook.md)). The command creates the tenant and its
first administrator. The sequence below is the **target design** for self-service signup, which is
"Later" in §7; it is not what the current release does.

```mermaid
sequenceDiagram
    participant V as Visitor
    participant S as Signup
    participant P as Provisioner
    participant T as Tenant

    V->>S: sign up (email, organisation, plan)
    S->>S: verify email, reserve slug, check domain policy
    S->>P: provision(tenant, plan)
    P->>T: seed roles, settings, default company/entity, default library,<br/>numbering rules, a starter workflow, confidentiality levels
    P->>T: create the first TENANT_ADMIN, force MFA enrolment
    P-->>V: workspace ready (trial subscription active)
```

Provisioning is **one transaction plus idempotent seed jobs**: a half-provisioned tenant is
retryable and never leaves a workspace without an administrator. Every seeded object is ordinary
configuration a tenant can then change — nothing seeded is special-cased in code.

**How a user reaches their tenant today.** Every organisation shares one hostname, and **the host is
never read for a tenant**. A user types their organisation (the tenant slug) on the sign-in form, and
the sign-in is refused without it; the API resolves the slug through the tenant registry
(`apps/api/src/modules/identity/presentation/auth.dto.ts`, `auth.controller.ts`). The `tenant_id`
claim in the issued token is the sole isolation authority, and it is what selects the tenant's
database ([ADR-0015](./adr/0015-database-per-tenant.md)).

**Custom domains are a future capability, not current behaviour.** The target design: a tenant may
claim a subdomain (`acme.docs.munaxa.com`) at provisioning and a custom domain later, verified by DNS
record, with certificates issued automatically, and the host would then be read **only to select the
login screen and branding** — never as an authorisation input, and never in place of the token's
`tenant_id` (§8). None of this exists in the current release; it is in the "Later" row of §7.

## 6. Payment provider

Behind a port, like every other external system:

```ts
export interface BillingPort {
  createCustomer(tenant: TenantId, profile: BillingProfile): Promise<BillingCustomerId>;
  startSubscription(customer: BillingCustomerId, plan: PlanVersionId): Promise<SubscriptionRef>;
  changePlan(ref: SubscriptionRef, plan: PlanVersionId): Promise<void>;
  reportUsage(ref: SubscriptionRef, metric: MetricKey, quantity: number, period: Period): Promise<void>;
  cancel(ref: SubscriptionRef, at: CancellationPoint): Promise<void>;
}
```

- **The provider is never the source of truth for entitlements.** It is the source of truth for
  *payment*; the subscription record in this database decides what the tenant may do. A provider
  outage must never open or close features.
- Webhooks from the provider are verified, idempotent, and reconciled against local state on a
  schedule — never trusted as the only signal.
- Card data never touches this system; the provider's hosted flow owns it.

## 7. What this adds to the build order

The [development recommendations](../reports/development-recommendations.md) put administration at
Phase 2. Commerce belongs there too, not at the end:

| Phase | Commerce work |
| --- | --- |
| 1 | `tenant`, `subscription` and `plan` tables exist; every tenant has a subscription, even if every plan is unlimited |
| 2 | Entitlement resolution + the two guards, wired but permissive; usage counters projected from events |
| 3+ | Each feature phase declares its `Feature` key and its `Limit` as it lands |
| Later | Payment provider adapter, self-service signup, custom domains, the operator console |

**Where this stands at release `4e8e1ca`:** the schema has a `tenant` table but no subscription or
plan tables, and the entitlement and feature-flag ports are not yet bound
(`apps/api/src/modules/administration/administration.module.ts`). Nothing in the "Later" row exists:
tenants are provisioned by an operator, users name their organisation at sign-in, and there is no
billing ([ADR-0021](./adr/0021-multi-tenant-hosted-launch.md) §10).

The point is **not** to build billing early. It is that the entitlement guard and the usage
projection exist before there are twenty modules to retrofit — the same argument as audit and the
outbox. A permissive guard costs almost nothing; adding one later costs a sweep of every endpoint.

## 8. What this must never do

| Never | Why |
| --- | --- |
| Use the host header, subdomain or plan as an isolation input | Isolation is the signed `tenant_id` claim, full stop |
| Put an entitlement check inside a domain rule | Business logic becomes untestable and commercially coupled |
| Let a payment provider's state decide access | An outage would lock customers out of their own records |
| Delete or withhold a tenant's documents for non-payment before the contractual window | Read-only, export, then purge — in that order |
| Meter from hand-written counters in use cases | They drift, and billing drift is a trust incident |
| Special-case a tenant in code | If a tenant needs different behaviour, it is a plan feature or a setting |
