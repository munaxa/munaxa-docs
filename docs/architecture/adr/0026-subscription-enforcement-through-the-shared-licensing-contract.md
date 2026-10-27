# ADR-0026 — Subscriptions are enforced through the shared licensing contract

- **Status:** Accepted for implementation; depends on `@munaxa/licensing@0.1.0`, which is **not yet
  published**
- **Date:** 2026-10-26
- **Builds on:** [ADR-0012](./0012-entitlements-as-data-enforced-centrally.md) (entitlements are data,
  enforced centrally, `402` not `403`) and [21](../21-saas-commercial-architecture.md). It implements
  the guards and the usage checks ADR-0012 §6 scheduled, and it supersedes nothing.

## Context

ADR-0012 decided that plans are data, that every tenant has a subscription, and that entitlement is
checked centrally and separately from permission. Nothing was bound: `POLICY_EVALUATOR` had no
implementation, no route was gated, no quota was counted.

Munaxa Group now sells School, Work and Docs through one control plane. The question "what does a
suspended subscription permit" must have one answer across the three products, and an on-premises
installation must be able to answer it with no network. The shared answer is the platform package
`@munaxa/licensing` ([munaxa-platform ADR-0022](https://github.com/munaxa/munaxa-platform/blob/claude/affectionate-tesla-0ptzhd/docs/security-platform/adr/0022-licensing-contracts.md)):
one lifecycle, one evaluation, one signed licence format, one outage policy.

## Decision

1. **Docs evaluates entitlements only through `@munaxa/licensing`.** It adds where the snapshot comes
   from and how a limit is enforced against its own rows — nothing about what a status means.
2. **Three sources, chosen by `LICENSING_MODE`:**
   - `NONE` (default) — every tenant on an unlimited plan, every feature included. This is the
     behaviour before this ADR, expressed as a snapshot so there is still no "no subscription" code
     path (ADR-0012 §2). It is explicit configuration; no failure selects it.
   - `LICENSE_FILE` — a signed `mxl1` licence on disk, verified offline with public keys only and
     re-read on every refresh, so renewal is a file copy.
   - `CONTROL_PLANE` — `GET /api/v1/products/docs/tenants/{tenantId}/entitlements` on the central
     service, through the outbound port and its allow-list.
3. **One global guard, after tenant isolation and before RBAC.** Every route is covered without
   annotation: a read verb needs `READ`, anything else `WRITE`. `@LicensedAs` marks the exceptions —
   export routes (and `/auth/me`, which a client needs to reach them) are `EXPORT`. `@RequireFeature`
   marks premium surfaces: webhooks, the audit stream, federated sign-in configuration, API clients,
   electronic signatures. A machine caller additionally needs `api.access`. `@Public` routes —
   sign-in, health, metrics — never reach a licensing decision.
4. **Limits are enforced atomically in the transaction that commits the growth.** A
   transaction-scoped advisory lock (two-key form, its own namespace) serialises the count and the
   commit. `users` is checked on invitation, on re-enabling a disabled account and on restoring a
   deleted one; `storage.bytes` when an upload session opens, counting live non-derived blobs once
   plus open sessions' declared bytes. An unlimited ceiling takes no lock and runs no count.
5. **Refusals are `402 SUBSCRIPTION_REQUIRED`**, with the contract's reason (`FEATURE_NOT_INCLUDED`,
   `SUBSCRIPTION_RESTRICTED`, `QUOTA_EXCEEDED`, `NO_SUBSCRIPTION`, `SUBJECT_MISMATCH`), the effective
   status and the access mode. A licence never grants: RBAC, the ACL and tenant isolation still apply.
6. **Outages degrade, never widen.** The last verified snapshot is kept per tenant in
   `entitlement_state`. In SaaS it is used unchanged for an hour, then without growth for a day, then
   read-only for a week, then export-only. On premises a missing licence file stops growth at once and
   keeps the installation readable for thirty days. With nothing ever verified, nothing is granted.
   An authoritative "no subscription" (a `404`, or a licence that fails verification) clears the
   stored snapshot so it cannot bridge a later outage.
7. **Time only moves forward.** `entitlement_state.last_observed_at` is monotonic (`GREATEST` in the
   statement), and decisions are made at the later of the clock and that instant, so a clock wound
   back cannot un-expire a term. The licence verifier also refuses a clock earlier than the licence's
   issue time.
8. **Answers are reused for `LICENSING_REFRESH_SECONDS` (default 60)** per process. That is how long a
   suspension takes to reach every replica.

## Policy, stated per status

From the shared default, which Docs does not tighten:

| Status | Mode | Docs keeps |
| --- | --- | --- |
| `TRIAL`, `ACTIVE`, `PAST_DUE` | `FULL` | Everything the plan includes |
| `GRACE_PERIOD` | `NO_GROWTH` | Edits, approvals, reads; no new user, no new bytes |
| `EXPIRED`, `SUSPENDED` | `READ_ONLY` | Sign-in and every read; no change of any kind |
| `CANCELLED` | `EXPORT_ONLY` | `/auth/me`, the subscription view, bulk document export, audit and report exports |

Health checks, readiness, metrics and sign-in are not licensed at all.

## Alternatives considered

- **Check entitlements in each use case** — the sweep ADR-0012 exists to avoid, and the first route
  written without it would be the hole.
- **Ask the central service on every request** — its latency on every request, and its outage as
  everyone's.
- **Fall back to the unlimited plan when the source is unreachable** — an outage that grants access;
  refused outright.
- **Count usage from hand-written counters** — they drift (ADR-0012 §7). Limits are counted from the
  rows that are the usage, inside the transaction that changes them.

## Consequences and known limits

- **Blocked dependency.** `@munaxa/licensing@0.1.0` is on the platform branch and not published.
  Until it is, `pnpm install --frozen-lockfile` fails on this branch.
- **The control plane is `munaxa-control`.** `CONTROL_PLANE` mode calls its product API; the reading
  of its answers (`404` is no subscription, every other failure an outage) is the shared
  `readEntitlementResponse`, so Docs, School and Work draw that line in one place.
- **Delivery and sign-in are licensed too.** The webhook and audit-stream lanes ask
  `integration.webhooks` and `audit.stream` before each send (an event while the feature is not
  included is not delivered later; a retry waits; the audit cursor holds, so the stream resumes
  gap-free). Federated sign-in asks `sso.federation` when it is offered — the password box when it
  is not included — and again at the callback, before the provider is asked for the code, so a flow
  started before the plan changed does not finish after it. Each is a read: a suspended tenant that
  includes the feature keeps it.
- **Usage is reported** hourly on the `licensing.usage` lane under `CONTROL_PLANE` only: `users` and
  `storage.bytes`, measured by the modules that own them with the same counts `enforceLimit` uses,
  at the hour the firing belongs to so a redelivery reports the same point.
- **Offline revocation does not exist**, and a clock that was wrong from first boot and never moved
  back is indistinguishable from a correct one (platform ADR-0022).
- Every existing deployment keeps its behaviour: `LICENSING_MODE` defaults to `NONE`.
