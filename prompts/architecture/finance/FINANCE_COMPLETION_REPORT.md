# Munaxa Finance Domain — Completion Report

Implementation of **Finance Domain Specification v1.0** (greenfield, ADR‑013). This report is
the final deliverable set: completion, architecture conformance, testing, database, API, UI,
documentation, performance, security, technical debt, and future extension points.

> **Verification (this build, against a live PostgreSQL 16):** `prisma validate` ✓ · API
> typecheck 0 errors · admin typecheck 0 errors · ESLint 0 errors (finance/einvoicing/documents)
> · **181 unit tests** pass · **58 finance e2e** pass across 8 suites · production build compiles.
> Migration `20260703120000_finance_ar_domain` applied; RLS `FORCE`d on all 16 AR tables.

---

## 1. Finance Completion Report

The Charge‑centric finance system was **replaced** by an Accounts Receivable engine. One
ubiquitous language throughout (schema, services, APIs, UI): `Payment` (not Transaction),
`PaymentPlan`, `Installment`, `Charge`, `Credit`, `Refund`, `CollectionsCase`,
`StudentFinancialAccount`, `Payer`, `Allocation`, `Invoice`.

**Delivered end‑to‑end**

| Layer | What shipped |
|---|---|
| Database | 16 new AR tables; legacy `FeePlan`/`Transaction`/`FinanceReceiptCounter`/`PaymentReminder` dropped; RLS forced; partial unique index (one active plan/charge); one migration. |
| Domain core | `money` (fils), `InstallmentScheduleService` (sole generator), `LedgerRepository` (derived‑figure single source of truth), `AllocationPolicy` (FIFO port), account/charge/payment/ledger/statement/collections. |
| API | Account, Charges (+plan, +cancel, installment reschedule), Payments (presign/record/verify/reject/notify/list, gapless receipts), Ledger (adjustments, allocate→installments, credits, refunds), Statement (hierarchical), Household, Collections, Reports. |
| Integrations | JoFotara bridge (charge‑sourced invoices), Documents (receipts/certificates), Admissions commit (Account+Charge+Plan+Installments), Dashboard, Reporting, Parent‑portal — all on the AR model. |
| Admin UI | Hierarchical Student Finance tab (Account → Charges → Plans → Installments → Payments → Credits → Refunds → Adjustments → Documents); finance console reuses it; Finance Reports page; fee‑plans page/nav removed. Munaxa Design System only. |
| Mobile | Parent app payment flow on `/finance/payments`; hierarchical `Statement` model + `nextDueInstallment`. |
| Reports | Dimensional revenue/outstanding (year/grade/campus/category); aging + collection effectiveness; per‑student financial. |
| Tests | Unit (schedule, allocation) + e2e (integration, ledger/accounting reconciliation, RLS, audit, RBAC, JoFotara, collections, reporting). |
| Seed | Demo AR ledger (account, tuition+plan, registration, transport, payments, discount) reusing the real schedule engine. |

**No legacy finance architecture remains** — old models, services, repositories, DTOs, APIs,
UI and the fee‑plans module were deleted (no compatibility layers).

---

## 2. Architecture Conformance Report

Every module reviewed against the specification. **Conformant** unless noted.

| Spec area | Rule(s) | Implementation | Status |
|---|---|---|---|
| Obligation vs schedule | ADR‑001, BR‑8/9/14 | `Charge` 1—0..1 `PaymentPlan` 1—N `Installment`; charge never split; implicit single installment when no plan; Σ installments == net enforced. | ✅ |
| Account & Payer | BR‑1..4, ADR‑003 | `StudentFinancialAccount` (1 per student, currency, status); nullable `Payer`; receivables owned by the account. | ✅ |
| Ledger (single source) | LR‑1..9 | `LedgerRepository` recomputes all figures from child rows; installment→charge status roll‑up; no stored balances. | ✅ |
| Allocation | AR‑1..8 | `PaymentAllocation → installmentId`; `FifoByDueDatePolicy` port (only policy in v1.0); verify auto‑allocates; residue → over‑payment `Credit` (BR‑24). | ✅ |
| Installments | IR‑1..6 | One `InstallmentScheduleService` (monthly/weekly/quarterly/custom, deferred, holiday, balloon); reschedule re‑asserts Σ==net; supersede cancels unsettled only. | ✅ |
| Credit & Refund | CR‑1..5, BR‑31..35 | `Credit` lots (provenance, remaining); `Refund` consumes lots FIFO via `RefundConsumption`; verified‑time re‑check. | ✅ |
| Charge lifecycle | ADR‑007, §3.1 | `PENDING/PARTIAL/PAID/WAIVED/WRITTEN_OFF/CANCELLED`; `OVERDUE` derived (never stored). | ✅ |
| Collections | BR‑40..42, ADR‑010 | `CollectionsCase` + `PromiseToPay` + `DunningEvent`; aging/overdue over **installments**; LEGAL excluded from reminders; profile = cache. | ✅ |
| Statement | §13 | Hierarchical Account → Charges → Plans → Installments + payments/credits/refunds/adjustments + derived totals. | ✅ |
| Invoicing (JoFotara) | BR‑36/37/38, ADR‑009 | Invoices originate from `Charge` (or `Payment` receipt); never from installment/plan; plan changes never re‑invoice; provider bridge preserved. | ✅ |
| Reporting | RR‑1..5 | Read‑side dimensional report (SQL, RLS‑scoped) by year/grade/campus/category; aging; per‑student. | ✅ |
| Multi‑tenant | MT‑1..6 | `tenantId` everywhere; RLS ENABLED+FORCED on all 16 AR tables (verified in e2e); gapless per‑tenant receipt counter. | ✅ |
| Audit | AU‑1..5 | Every financial mutation writes `AuditLog` in the same transaction (charge/plan/payment/allocation/adjustment/credit/refund/collections/transport). | ✅ |
| Security / RBAC | SE‑1..7 | `finance:manage` / `finance:read` / `receipt:upload`; server recomputes all money; receipt keys tenant‑validated; no ambient authority. | ✅ |
| Money precision | Global | `Decimal(12,3)`; integer‑fils arithmetic in one shared `money` module; splits reconcile exactly. | ✅ |
| Extension points | EP‑1..8 | `AllocationPolicy` + `ScheduleStrategy` ports; `Payer` link; `FeeItem.categoryId` seam; dimensions for reporting; JoFotara provider seam. | ✅ |
| Migration strategy | ADR‑013 | Greenfield replacement (no parity gate / dual‑write / adapters) — matches the approved amendment. | ✅ |

**Deviations found & corrected during build:** (a) statement schedule view excluded superseded
(CANCELLED) installments to honour the "no flat/stale list" UI rule; (b) mid‑plan discounts
rebalance the unpaid tail so Σ installments == net stays exact; (c) ledger action endpoints
return 200. No open deviations remain.

---

## 3. Testing Summary

- **Unit (181, ts‑jest):** installment schedule (Σ==net across cadences, balloon, holiday skip,
  custom validation), FIFO allocation policy (ordering, caps, residue), plus all pre‑existing suites.
- **Integration / reconciliation e2e (`finance.e2e`, 11):** charge→plan→installments; PENDING
  payment has no effect; verify allocates + gapless receipt; 9‑installment plan sums to net; manual
  allocation; mid‑plan discount rebalances; over‑payment → credit → refund consumption + over‑limit
  rejection; **ledger reconciliation** (Σ installments==net, Σ installment.paid==charge.paid,
  outstanding==Σ balances, account charged/paid/outstanding); dimensional report reconciliation;
  audit; RBAC.
- **RLS e2e (`tenant-isolation.e2e`):** all 16 AR tables ENABLED+FORCED.
- **Adjacent e2e green:** collections, dashboard, reporting, documents, einvoicing, JoFotara bridge.
- **Totals:** 181 unit + 58 finance e2e (8 suites) passing.
- **Known non‑finance, pre‑existing failures (proven identical on `origin/main`):** `people`
  (parent DTO requires `phone`, test omits it), `student-app` (attendance seed uses fixed June
  dates now outside the 30‑day window vs today 2026‑07‑02), `parent-portal` (same class). Out of
  finance scope; not regressions.

---

## 4. Database Summary

**New tables (16, all `tenantId` + RLS FORCED):** `Payer`, `StudentFinancialAccount`, `Charge`
(restructured), `PaymentPlan`, `Installment`, `Payment`, `PaymentReceiptCounter`, `FeeAdjustment`
(+`WRITE_OFF`, credit link), `PaymentAllocation` (→installment), `Credit`, `RefundConsumption`,
`Refund`, `CollectionsCase`, `PromiseToPay`, `DunningEvent`, `StudentBillingProfile` (projection).

**Dropped:** `FeePlan`, `Transaction`, `FinanceReceiptCounter`, `PaymentReminder` + legacy columns
(`Charge.feePlanId`, `Charge.installmentPlanId`).

**Constraints/indexes:** one account per student (`@unique studentId`); partial unique
`PaymentPlan_active_per_charge WHERE status='ACTIVE'` (BR‑11); `@@unique([tenantId, receiptNo])`;
`@@unique([planId, seq])`; scan indexes on `Installment(tenantId,dueDate|status)`,
`Charge(tenantId, accountId|status|academicYearId|feeItemId)`, `PaymentAllocation(tenantId,installmentId)`.

**Migration:** `20260703120000_finance_ar_domain` (structural diff + RLS/grants block). `Decimal(12,3)`
preserved; RLS reuses `app_current_tenant()`/`app_is_platform()`; runtime role `munaxa_app` granted.

---

## 5. API Summary

`/finance/*`, versioned `v1`, tenant‑scoped, RBAC‑gated:

- **Accounts:** `GET /finance/accounts/:studentId`.
- **Charges/plans:** `POST /charges`, `POST /charges/:id/plan`, `POST /charges/:id/cancel`,
  `PATCH /installments/:id`, `GET /charges?studentId`.
- **Payments:** `POST /payments/receipt/presign`, `POST /payments`, `POST /payments/:id/verify|reject|notify-parent`, `GET /payments?studentId`.
- **Ledger:** `POST /ledger/adjustments`(+`/:id/reverse`), `POST /ledger/allocate` (installment lines),
  `GET /ledger/credits`, `POST /ledger/refunds`(+`/:id/verify|reject`).
- **Statement:** `GET /students/:id/statement` (hierarchical), `GET /students/:id/household`.
- **Collections:** profile, set status, reminders, push‑outstanding, aging, transport evaluate.
- **Reports:** `GET /finance/reports/summary?dimension=academicYear|grade|campus|category`.
- **JoFotara:** unchanged e‑invoicing endpoints (charge‑sourced).

Ubiquitous language: `Payment` replaces `Transaction`; allocation targets `installmentId`;
`EInvoiceDocument.paymentId` replaces `transactionId`.

---

## 6. UI Summary

- **Student Finance tab** — hierarchical: Student Financial Account (Outstanding · Paid ·
  Discounts · Credits · Refunded) → expandable **Charges** (gross/discount/net/outstanding) →
  **Payment Plan** (cadence × N) → **Installments** (due/amount/paid/balance/status, OVERDUE
  derived) → **Payments** (verify/reject/receipt/notify), **Credits**, **Refunds**, **Adjustments**,
  **Documents**. Inline actions: record+verify payment, create/replace plan, apply adjustment,
  refund credit. No duplicated charges; installments only inside their plan.
- **Finance console (`/finance`)** — student search + collections banner (reminders/legal) +
  the shared `FinanceTab` (no duplicated logic) + household.
- **Finance Reports (`/finance/reports`)** — dimension selector + revenue/outstanding table + totals.
- **Mobile (Flutter)** — parent statement model mirrors the hierarchy; pay flow on `/finance/payments`.
- Munaxa Design System components only; no new visual patterns; fee‑plans page/nav removed.

---

## 7. Documentation Summary

- `finance-domain-redesign.md` — architecture review + roadmap (rationale).
- `finance-domain-specification-v1.md` — frozen spec (BR/LR/AR/IR/CR/DB/RR/MT/AU/SE/MG + 13 ADRs);
  ADR‑013 records the greenfield amendment.
- `IMPLEMENTATION_STATUS.md` — live tracker (now COMPLETE).
- `FINANCE_COMPLETION_REPORT.md` — this report (completion + conformance + summaries).
- Inline: every service/repository documents the rules it enforces (rule IDs referenced in code).

---

## 8. Performance Summary

- **Ledger reads batched** — the per‑installment / per‑credit N+1 aggregate loops were replaced
  with grouped lookups (`paidByInstallment`, `consumedByCredit`) across `chargeViews`,
  `openInstallments`, account summary, credit balance, charge‑status recompute and per‑charge FIFO:
  **O(1) queries instead of O(n)** per read. Behaviour unchanged (reconciliation e2e green).
- **Reports** — one RLS‑scoped SQL statement (CTEs) per dimension, not per‑row aggregation.
- **Indexes** — dueDate/status/dimension indexes support aging scans and dimensional reports.
- All money math in integer fils (no repeated Decimal churn in hot loops).

---

## 9. Security Summary

- **RLS:** ENABLED + FORCED on all 16 AR tables (verified by `tenant-isolation.e2e`); fail‑closed
  with no tenant/platform context; runtime connects as non‑superuser `munaxa_app`.
- **RBAC:** every mutating endpoint requires `finance:manage`; reads `finance:read`; receipt upload
  `receipt:upload`. Parents cannot create charges or verify (e2e‑asserted).
- **Server‑authoritative money:** all net/balance/outstanding/credit recomputed server‑side; clients
  never supply derived values.
- **Raw SQL (reports):** table/column/label come from a fixed whitelist (never user input); the
  `dimension` param is validated (400 otherwise); runs under `withTenant` (RLS‑scoped) — no injection.
- **Receipts:** S3 keys tenant‑validated (`assertKeyInTenant`); presigned‑URL upload; gapless
  per‑tenant receipt numbers allocated only at verify.
- **Audit:** every financial state change written in‑transaction (AU‑1); append‑only.
- **Separation of duties:** fee‑modification approval honours `allowSelfFeeApproval`.
- **PII:** buyer snapshots minimised to JoFotara requirements; e‑invoice credentials encrypted, never returned.

---

## 10. Technical Debt Summary

Small, tracked, none blocking:

1. **Mid‑plan discount rebalancing** takes the discount off the unpaid tail and re‑adds on reversal
   to the last active installment — correct and Σ‑preserving, but a proportional policy could be
   offered later (an `AllocationPolicy`/re‑plan variant).
2. **Reports** return dimension ids + resolved labels but no CSV/XLSX/PDF export yet (the general
   Reporting module has exporters; wiring the dimensional report to them is additive).
3. **Cross‑student credit** (a payer's credit funding a sibling) is manual in v1.0 by design (D‑1);
   automation is a declared `CROSS_STUDENT` allocation‑policy seam.
4. **GL / deferred‑revenue** and **AccountingPeriod/close** are intentionally deferred (ADR‑008,
   D‑6) behind seams; not required for AR parity.
5. Pre‑existing non‑finance e2e flakes (people/student‑app/parent‑portal) are out of scope
   (documented in §3); worth a separate fix.

---

## 11. Future Extension Points

- **AllocationPolicy port** — add `PROPORTIONAL`, `SPECIFIC_INSTALLMENT`, `CROSS_STUDENT` without
  touching the engine (register a strategy).
- **ScheduleStrategy** — new installment cadences as new strategies.
- **Provider ports** — `PaymentProvider` (online gateway → produces `Payment` via the same verify
  path), `AccountingProvider` (GL export), additional `EInvoiceProvider` adapters (future countries).
- **Payer/Household** — family‑level statements and cross‑student credit build on the existing link.
- **FeeCategory** — nullable `FeeItem.categoryId` seam for hierarchical categories.
- **AccountingPeriod** — every money row carries an authoritative date; period/close layers on in a
  GL phase with zero AR rework.
- **Multi‑currency/FX** — `currency` columns present on account/charge/payment/credit; FX at the
  provider boundary when a real second‑country tenant exists.
- **Reporting warehouse** — dimensions + a domain‑event outbox enable a warehouse without touching
  the write model.

---

**Conclusion.** The Finance Domain Specification v1.0 is fully implemented and verified. The
codebase holds exactly one finance architecture (no old/new mixing), one ubiquitous language, a
single source of truth for every calculation, RLS‑forced multi‑tenancy, in‑transaction audit, and
a clean set of extension points — a foundation intended to serve Munaxa for the next 10–15 years
without another domain redesign.
