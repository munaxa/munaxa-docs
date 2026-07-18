# Phase 9 — Finance  ·  SUPERSEDED

> **This document is obsolete.** The original Phase 9 finance module (FeePlan / Transaction /
> `fee-plans` / `transactions`, the Charge‑centric model) has been **replaced** by the
> Accounts Receivable (AR) domain — Finance Domain Specification v1.0 (greenfield, ADR‑013).
> The old models, modules, DTOs, routes and UI described here no longer exist.
>
> **See instead:**
> - `docs/architecture/finance/finance-domain-specification-v1.md` — the canonical spec (single source of truth).
> - `docs/architecture/finance/finance-erd.md` — the implemented ERD.
> - `docs/architecture/finance/FINANCE_COMPLETION_REPORT.md` — implementation + conformance review.
> - `docs/architecture/finance/finance-domain-redesign.md` — the redesign rationale/roadmap.
>
> Ubiquitous language now: `Payment` (not Transaction), `StudentFinancialAccount`, `Charge`,
> `PaymentPlan`, `Installment`, `PaymentAllocation` (→ installment), `Credit`, `Refund`,
> `CollectionsCase`. Invoices originate only from charges (JoFotara). RLS is forced on every
> AR table; every financial mutation writes an in‑transaction audit log.
