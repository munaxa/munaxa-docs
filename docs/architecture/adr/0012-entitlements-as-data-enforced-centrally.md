# ADR-0012 — Plans and entitlements are data, enforced centrally, separate from permissions

- **Status:** Accepted
- **Date:** 2026-07-31
- **Phase:** 0

## Context

Munaxa Docs is sold as SaaS. That means plans, feature gating, seat and storage limits, trials and
usage-based billing — none of which the Phase 0 product architecture (00–20) covers.

There are two tempting shortcuts, and both are expensive later:

1. **Treat a plan feature as a permission** — add `feature:ocr` to the permission catalogue and gate
   on it. Permissions answer "may this user?"; plans answer "did this organisation buy it?". Merging
   them means a role grant can accidentally sell a feature, and an unpaid invoice looks like an
   authorisation bug.
2. **Add entitlement checks when billing is built**, at the end. By then there are twenty modules
   and every endpoint needs a sweep — the same failure mode as retrofitting audit.

## Decision

1. **Plans are versioned data**: a set of feature keys, limits and price points. A published plan
   version is immutable, so a price or limit change never rewrites what an existing subscriber
   bought.
2. **Every tenant has a subscription from provisioning**, even in a single-plan or on-premise
   deployment where everything is unlimited. There is no "no subscription" code path.
3. **Entitlements are resolved from plan + per-tenant overrides** into a cached snapshot, and are
   enforced in exactly two central places: a route guard (`@RequireFeature`, `@EnforceLimit`) and
   the `capabilities` payload the UI renders from.
4. **Entitlement failures are `402`, permission failures are `403`.** Different question, different
   answer, different UI (an upgrade path versus an access request).
5. **No entitlement check ever appears inside a domain rule.** Domain code decides what is *valid*;
   commerce decides what is *bought*.
6. **The guards land in Phase 2, permissive**, before there are many modules to retrofit. Billing,
   signup and the payment adapter come much later.
7. **Usage is metered from domain events** through the outbox, never from hand-written counters, and
   reconciliation drift is reported rather than silently corrected.
8. **The payment provider is a port and is never the source of truth for entitlements** — a provider
   outage must not open or close features.

## Alternatives considered

1. **Feature flags per tenant, no plan model** — works until a second customer wants the same
   bundle, then flag drift makes "what did they buy?" unanswerable.
2. **Entitlements inside the permission catalogue** — see context; conflates two lifetimes (a role
   grant is administrative, a plan is contractual) and lets one leak into the other.
3. **Delegate entitlements to the payment provider** (read features from the billing system at
   request time) — couples every request to an external service and makes on-premise installs
   impossible.
4. **Defer all of it to a later phase** — rejected for the guards and the usage projection only;
   deferred for everything else. The cheap part is the part that is expensive to add late.

## Consequences

- Two new contexts, Commerce and Platform, and a small set of tables (`plan`, `subscription`,
  `entitlement`, `usage_counter`, `billing_record`).
- Two guards on routes instead of one; the `capabilities` payload gains a reason and an upgrade
  hint so the UI can distinguish "not allowed" from "not included".
- Storage accounting must distinguish live, deleted-but-retained and derived bytes, because storage
  is the dominant variable cost.
- On-premise and single-tenant installs run the identical code with an unlimited plan — no second
  code path, which is the property that keeps both deployments honest.
- Full design: [21 — SaaS Commercial Architecture](../21-saas-commercial-architecture.md).
