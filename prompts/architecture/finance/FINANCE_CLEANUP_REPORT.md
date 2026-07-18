# Munaxa Finance — Cleanup Report

Post‑implementation cleanup of the completed AR rewrite. Objective: the repository contains
**only** the new Finance Domain — no legacy code, no duplicates, no dead code, no stale docs.
**No new functionality; no behaviour change.** Cross‑module connections were preserved and
re‑verified at every step.

> **Verification after cleanup:** `prisma validate` ✓ · migration status up‑to‑date · API
> typecheck **0 errors** · admin typecheck **0 errors** · ESLint **0 errors** (finance/documents)
> · **185 unit tests** · **58 finance e2e** (8 suites) · both locale JSONs valid, i18n builds.

---

## 1. Files removed

| File | Reason |
|---|---|
| *(previously)* `apps/api/src/finance/fee-plans/**` | Legacy fee‑plans module (removed in the rewrite). |
| *(previously)* `apps/api/src/finance/transactions/**` | Replaced by `payments/**`. |
| *(previously)* `apps/api/src/finance/ledger/billing.repository.ts` | Replaced by `ledger.repository.ts`. |
| *(previously)* `apps/admin/.../finance/fee-plans/page.tsx` | Legacy fee‑plans admin page. |
| *(previously)* `apps/api/test/billing-ledger.e2e-spec.ts` | Obsolete old‑model ledger test. |

This cleanup pass **removed content** (rather than whole files) from:

- `docs/phases/phase-9-finance.md` — the stale old‑model phase doc (FeePlan/Transaction/
  fee‑plans/transactions described as current) → replaced with a **superseded** notice pointing
  to the AR finance docs (kept the file so no phase‑index expectation is broken; nothing links to it).
- `packages/i18n/src/locales/{en,ar}.json` — removed the orphaned top‑level `feePlans` translation
  block (the page it served was deleted; zero `feePlans.` references remain).

*(Migration files are intentionally NOT deleted — see §3.)*

## 2. Code removed

- **Dead column:** `Enrollment.installmentPlanId` — zero references anywhere in the codebase
  (charges link to enrollments via `enrollmentId`). Dropped from the schema and the DB
  (migration `20260703130000_drop_enrollment_installment_plan_id`).
- **Duplicate `toFils` definitions:** removed the local `const toFils = …` in
  `admissions.repository.ts` and `registration-agreement.service.ts` → both import the shared
  `toFils` from `finance/shared/money`.
- **Duplicate installment split (business logic, 3 copies):** the inline
  `per = floor(total/n); last = total − per*(n−1)` loops in `enrollment.service`, `quote.service`
  and `registration-agreement.service` → replaced with the shared `splitFils()`; the canonical
  `InstallmentScheduleService` also delegates its non‑balloon split to `splitFils()`.
- **No commented‑out code**, no unreachable code, and **no old finance type names**
  (`InstallmentPlanView`, `InstallmentRow`, `ChargeBalance`, `DetailedTransaction`,
  `StatementTotals`, `TransactionRepository`, …) remain — verified by grep.

## 3. Database cleanup

- **Dropped:** `Enrollment.installmentPlanId` (dead). Verified absent from the live DB.
- **Schema:** `prisma validate` passes; migration status up‑to‑date.
- **Comments:** stale references to the renamed `FinanceReceiptCounter` corrected to
  `PaymentReceiptCounter` (schema doc‑comments); `PaymentReminder` lineage comments tidied.
- **Migrations are retained by design (correct, not debt).** The historical migrations
  (`20260603180000_finance`, `…_fee_collections`, `…_charge_installment_plan`,
  `…_finance_receipt_number`, `…_finance_receipt_counter_rls`, `…_finance_presence_rls`) *create*
  the old objects; the AR migration `20260703120000_finance_ar_domain` *drops* them. A migration
  history is an **append‑only ledger** — editing/deleting applied migrations would break
  `prisma migrate deploy` from a clean database (the diff‑based AR migration assumes the prior
  state exists). They are not "unused"; they are how the current schema is reproduced. No obsolete
  live tables/columns remain (the old finance tables are physically dropped by the AR migration).

## 4. API cleanup

- All finance controllers reviewed: **10 controllers, every route RBAC‑gated** (routes == 
  `@RequirePermissions` count). No obsolete routes/DTOs/validators/permissions remain — the old
  `/finance/transactions*` and `/finance/fee-plans*` routes and their DTOs were removed in the
  rewrite; `EInvoiceDocument.transactionId` → `paymentId` throughout.
- No duplicate validators introduced. (The installment min/max bound check appears in the two
  distinct quote flows — enrollment vs admissions — each with its own policy fetch; these are
  separate contexts, not a duplicated implementation, and are left as‑is — see §9.)

## 5. UI cleanup

- **Admin:** legacy fee‑plans page + nav entry removed; the `feePlans` **icon** is retained
  (reused by the fee‑catalog nav link — not dead). `documents` client `transactionId`→`paymentId`.
  Student Finance tab + finance console + reports page all on the AR client; no obsolete
  components/hooks/state/API calls remain (grep‑verified: only `InventoryTransaction` matches the
  old `Transaction` token, which is unrelated).
- **Mobile (Flutter):** `StatementTotals` → `AccountTotals`; payment flow on `/finance/payments`;
  no dead widgets (the finance feature is data + providers).
- **i18n:** orphaned `feePlans` page block removed from both locales.

## 6. Documentation cleanup

- `docs/phases/phase-9-finance.md` → superseded notice (old‑model content removed).
- Finance architecture docs are current and consistent: `finance-domain-specification-v1.md`
  (canonical), `finance-erd.md` (implemented ERD), `FINANCE_COMPLETION_REPORT.md`
  (implementation + conformance), `finance-domain-redesign.md` (rationale), `IMPLEMENTATION_STATUS.md`
  (COMPLETE). The spec matches the implemented system (conformance table in the completion report).
- Stale in‑code doc‑comments referencing renamed tables corrected.

## 7. Duplicate logic removed

**Single source of truth confirmed for every financial calculation:**

| Calculation | Single source |
|---|---|
| Fils conversion (`toFils`/`fromFils`) | `finance/shared/money.ts` |
| Installment amount split | `finance/shared/money.ts::splitFils` (reused by the schedule engine + all previews) |
| Installment schedule (dates + amounts) | `finance/charges/installment-schedule.service.ts` |
| Payment allocation | `finance/ledger/allocation-policy.ts` (FIFO) + `LedgerRepository.allocate` |
| Outstanding / balance / net / paid | `finance/ledger/ledger.repository.ts` (derived; nothing else computes them) |
| Credit balance | `LedgerRepository` (`creditBalanceTx`) |
| Refund consumption | `LedgerRepository.verifyRefund` (FIFO) |
| Collections status / aging | `collections.repository` + `collections.service` (over installments) |
| Statement | `statement.service` (composes the ledger; no re‑computation) |
| Reports | `reports.repository` (one SQL over the ledger) |

## 8. Dead code removed

- Dead column `Enrollment.installmentPlanId`; duplicate `toFils` (×2); duplicate split loops (×3).
- No commented‑out code, unreachable code, orphaned tests, or orphaned type names remain
  (grep‑verified across `apps/**`, `packages/**`, `prisma/**`).

## 9. Remaining technical debt (minor, non‑blocking)

1. **Duplicated installment min/max validation** across `enrollment.service` and `quote.service`
   (two separate quote flows). Low‑value to consolidate (different DTOs/policy fetch); left as‑is.
2. **Reports** have no CSV/XLSX/PDF export yet (the general Reporting module has exporters; wiring
   is additive).
3. **Preview date stepping** (`addMonths`) exists locally in the two quote services + the agreement
   service (local‑time) and in the canonical schedule engine (UTC). They were **intentionally not
   merged** — merging would shift preview dates under non‑UTC servers (a user‑visible change), which
   the cleanup must not introduce. The financial *amount* split is now shared; dates remain per‑caller.
4. Deferred‑by‑design (spec seams, not debt): GL/deferred‑revenue, AccountingPeriod, cross‑student
   credit automation, additional allocation policies/providers.

## 10. Final repository health assessment

**Healthy / production‑ready for the Finance domain.**

- **One** finance architecture — no old/new mixing, no compatibility layers, wrappers, aliases or
  temporary adapters.
- **One ubiquitous language** across schema, code, APIs and UI.
- **Single source of truth** for every financial calculation (§7).
- **Quality gates green:** prisma validate; API + admin typecheck (0 errors); ESLint (0 errors);
  185 unit + 58 finance e2e; production build compiles.
- **Security intact:** RLS forced on all AR tables; every route RBAC‑gated; all mutations audited
  in‑transaction; the one raw SQL uses a fixed whitelist under RLS.
- **No dead code, no commented‑out code, no orphaned tests, no misleading docs.**
- Migration history preserved (correctly); the live DB contains only AR objects.

The Finance implementation is clean, consistent, and maintainable — ready for production.
