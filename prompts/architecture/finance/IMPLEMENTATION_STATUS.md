# Finance Domain v1.0 — Implementation Status

Live tracker for the greenfield implementation of the Finance Domain Specification v1.0
(ADR-013). Updated as each layer lands. Terminology is the spec's ubiquitous language
(Payment, PaymentPlan, Installment, Charge, Credit, Refund, CollectionsCase,
StudentFinancialAccount, Payer, Allocation, Invoice).

## Environment (verified)

- Local Postgres 16 + Prisma engines operational; migrations, client generation and Jest
  all run green. (Docker Hub and the Prisma binary CDN are egress-restricted here; worked
  around by installing Postgres via apt and fetching the pinned Prisma engines directly.)
- Baseline before changes: 38 finance/e-invoicing unit tests passing.

## DONE — Data model (verified against a live DB)

- **Schema** (`prisma/schema.prisma`): AR model implemented — `Payer`,
  `StudentFinancialAccount`, `Charge` (restructured: `accountId` + reporting dimensions,
  `installmentPlanId`/`feePlanId` removed), `PaymentPlan`, `Installment`, `Payment`
  (replaces `Transaction`), `PaymentReceiptCounter`, `FeeAdjustment` (+`WRITE_OFF`, credit
  link), `PaymentAllocation` (→ `installmentId`), `Credit`, `RefundConsumption`, `Refund`
  (account/payer), `CollectionsCase`, `PromiseToPay`, `DunningEvent`. `StudentBillingProfile`
  retained as the cached projection. Legacy `FeePlan`/`Transaction`/`FinanceReceiptCounter`/
  `PaymentReminder` **dropped**. `prisma validate` passes.
- **Migration** `20260703120000_finance_ar_domain`: applied to the live DB. Adds the partial
  unique index `PaymentPlan_active_per_charge` (one ACTIVE plan per charge, BR-11) and
  RLS `ENABLE`+`FORCE`+`tenant_isolation` on every new tenant table (DB-1/MT-2), with
  `munaxa_app` grants. Verified: new tables present, old finance tables gone, RLS forced,
  partial index present.
- **Prisma client** regenerated with the new types.

## DONE — Domain core (backend)

- `finance/shared/money.ts` — single source of fils arithmetic (IR-2 global money invariant).
- `finance/charges/installment-schedule.service.ts` — the **sole** schedule generator
  (IR-1): monthly/weekly/quarterly/custom, deferred first, holiday skip, balloon; Σ == net.
- `finance/ledger/ledger.repository.ts` — **single source of truth for all derived figures**
  (LR-1..9): installment/charge/account balances, status recompute (installment→charge),
  adjustments (+credit-memo→Credit), allocations, over-payment credit, refunds (FIFO credit
  consumption), credit ledger. All writes audited in-transaction (AU-1).
- `finance/account/account.repository.ts` — `StudentFinancialAccount` + `Payer`, lazy
  `ensureAccount` (links Payer from primary guardian).
- `finance/charges/charge.repository.ts` — charge (obligation) + implicit installment,
  payment-plan create/supersede, cancel, installment reschedule (re-asserts BR-9).

## DONE — Backend service/API layer (compiles, typechecks, builds, lints; 181 unit tests pass)

Committed in `feat(finance): AR domain backend`. Greenfield — no old shapes preserved.

- [x] `finance/charges`: `charge.service`/`dto`/`controller` (obligation + plan engine;
      `POST /finance/charges`, `/charges/:id/plan`, `/charges/:id/cancel`,
      `PATCH /finance/installments/:id`, `GET /finance/charges`).
- [x] `finance/payments` (replaces `transactions`): repository/service/dto/controller
      (presign/record/verify/reject/notify-parent; gapless `PaymentReceiptCounter`; verify →
      FIFO allocation to installments; residue → over-payment `Credit`).
- [x] `finance/ledger`: `allocation-policy` (FIFO_BY_DUE_DATE port, AR-8), `ledger.repository`
      (derived-figure SoT + status recompute + adjustments/allocations/credits/refunds),
      `ledger.service`/`dto`/`controller`. Old `billing.repository` deleted.
- [x] `finance/account`: repository/service/controller (`GET /finance/accounts/:studentId`).
- [x] `finance/statement`: hierarchical account → charges → plans → installments tree (§13).
- [x] `finance/collections`: aging/overdue retargeted to **installments**; `CollectionsCase` +
      `PromiseToPay` + `DunningEvent`; `StudentBillingProfile` as cache.
- [x] `finance/finance.module.ts` rewired.
- [x] `einvoicing`: charge-sourced invoicing preserved; `Transaction`→`Payment`, `paymentId`.
- [x] `documents`, `dashboard`, `reporting`, `parent-portal`: adapted to the new model.
- [x] `admissions`: commit creates Account + Charge + Plan + Installments (no installment-charges).
- [x] Unit tests: installment schedule (Σ==net, cadences, balloon, holiday, custom) + allocation
      FIFO (ordering, caps, residue).

## DONE — Tests, UI, reports, docs

- [x] Integration + reconciliation e2e (live DB): commit→charge→plan→installment→payment→
      allocation→adjustment→credit→refund; ledger invariants (Σ installments == net;
      Σ allocations == paid; outstanding == Σ charge balance); gapless receipts; audit; RBAC.
- [x] RLS verification e2e: ENABLED+FORCED on all 16 AR tables.
- [x] `seed-demo.ts` — finance demo data on the new model (reuses the schedule engine).
- [x] Admin UI: hierarchical Student Finance (Account → Charges → Plans → Installments →
      Payments → Credits → Refunds → Adjustments → Documents); finance console reuses it;
      legacy fee-plans page/nav removed. Munaxa Design System only.
- [x] Parent/Flutter: `/finance/payments` flow + hierarchical Statement model + next-due
      installment helper + statementProvider.
- [x] Reports: `GET /finance/reports/summary?dimension=` (revenue/outstanding by year/grade/
      campus/category) + admin Finance Reports page; aging + collection effectiveness already
      in Collections; per-student financial in Reporting.
- [x] Performance: batched ledger reads (no N+1).
- [x] Docs: see `FINANCE_COMPLETION_REPORT.md` (completion + architecture conformance review).

**Status: COMPLETE.** All gates green — prisma validate, typecheck (api+admin), eslint,
181 unit tests, 58 finance e2e (8 suites). See the completion report for the full summary.

## Notes / decisions taken during build

- Mid-plan discounts rebalance the **unpaid tail** of the schedule so Σ installments == net
  stays exact (BR-9); reversals add back to the last active installment.
- Over-payment on a verified payment becomes an explicit `Credit(OVERPAYMENT)` — never a
  silent reduction of outstanding (BR-24), removing the historical "two truths" divergence.
- `AllocationPolicy` ships FIFO-by-due-date only (AR-8); other policies are declared seams.
