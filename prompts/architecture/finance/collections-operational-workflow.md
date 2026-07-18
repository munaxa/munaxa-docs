# Munaxa Finance — Collections & Payment Operational Workflow

This document describes the **operational workflow** for finance officers. It is a workflow/UX
layer over the existing Finance Domain — **the ledger, payment plans, installments, allocation and
collections tables are unchanged**. Nothing here is an accounting redesign.

## Principle

The daily job of a school finance officer is **collecting overdue balances while keeping the
existing agreement** — not replacing payment plans. The software must make that the path of least
resistance:

- **Normal:** record a payment (any amount), which auto-allocates via the Allocation Policy across
  the open installments of the existing plan; record a promise-to-pay; log a call; send a reminder.
- **Exceptional:** replace the payment plan — only for hardship, scholarship, recalculation,
  transfer, school-approved renegotiation, or an administrative correction.

## Real-world flow (the default)

1. Student enrolled → charges created → payment plan created → parent signs.
2. Installments become due; a parent misses one or more.
3. Finance officer contacts the parent (logged in the **Communication Log**).
4. Officer optionally records a **Promise to Pay** (amount + expected date).
5. Parent pays one/multiple/partial installments → **payment is auto-allocated** (FIFO by due date)
   — **the original plan is unchanged.**

The plan is **never** replaced as part of this flow.

## What is reused (no changes)

| Concern | Reused component |
|---|---|
| Record payment (any amount) + automatic allocation | `PaymentService` + `allocation-policy` (FIFO) |
| Outstanding / overdue / oldest-due / days-overdue | `CollectionsService.snapshot` (over the ledger) |
| Aging buckets, reminders (in-app/SMS/email), transport evaluate/suspend | `CollectionsService` |
| Collections case / promise / dunning event tables | `CollectionsCase` · `PromiseToPay` · `DunningEvent` |
| Payment plans / installments / ledger | untouched |

## What was added (this change)

### Promise to Pay (new API + UI)
Records a parent's commitment under the account's `CollectionsCase` (auto-opened), moves the case to
`PROMISE_TO_PAY`, logs a `PROMISE` dunning event, and audits it.

- `POST /finance/collections/students/:studentId/promises` — `{ amount, promiseBy, note? }`
- `GET  /finance/collections/students/:studentId/promises` — with a derived status
  (`OPEN` · `OVERDUE` · `KEPT` · `BROKEN`)
- `POST /finance/collections/promises/:promiseId/resolve` — `{ kept: boolean }`

Promises also appear on the enriched collections profile (`GET /finance/collections/students/:id`).

### Communication Log (new API + UI)
Logs a parent contact as a `COMMUNICATION` dunning event — timestamped and audited.

- `POST /finance/collections/students/:studentId/communications` — `{ medium, note }` where
  `medium ∈ { PHONE, WHATSAPP, SMS, EMAIL, MEETING, NOTE }`
- `GET  /finance/collections/students/:studentId/communications`

Schema: one additive, nullable column `DunningEvent.medium` + a `CommunicationMedium` enum and a
`COMMUNICATION` `DunningEventType` value (migration `20260704120000_collections_communication_log`).
No ledger/plan/data-migration changes.

### Renegotiate Payment Plan → exceptional administrative action
`POST /finance/charges/:chargeId/plan` accepts an optional `reason`. When an active plan already
exists the write is audited as **`finance.plan.renegotiate`** (with `reason`, `replaced: true`,
`supersededCount`); a first plan is `finance.plan.create`. The previous plan is superseded and the
new plan is scheduled from the **current Ledger Outstanding Balance ONLY** (`net − paid`, from
`chargeViews`) — never the original charge amount, the original plan total, or a historical schedule.

**Hard invariant (BR-11):** `Σ(new installments) == ledger outstanding` to the last fils (0.001 JOD);
if the generated schedule would not equal the outstanding, the operation is rejected (fail-closed).
Previously verified payments stay attached to the superseded plan (history) and never appear inside
the new plan. Verified scenarios: 1705 debt −190 paid → 1515.000; 1705 −700 (6 mo) → 1005.000;
1705 −0 → 1705.000; partial/odd payments still take the basis from the ledger to the fils.

**Reconciliation invariant (single financial truth).** When a plan is superseded, a *partially-paid*
installment is shrunk to exactly its allocated amount (status `PAID`, zero balance) — it never keeps
a residual balance, because that remainder is already carried by the new plan. This preserves
`Σ(non-cancelled installment.amount) == charge.net`, so the two outstanding computations stay
identical to the fils:

```
Account / Statement outstanding  =  Σ max(installment.amount − installment.paid, 0)
Charge outstanding               =  max(charge.net − Σ paid, 0)
```

After materialising the new schedule, `createPlan` re-derives both figures and **aborts the
transaction (fail-closed)** if they differ, or if `Σ installments ≠ net` — inconsistent AR data can
never be persisted. (Regression fixed: a retained partial installment used to keep a residual that
the installment-sum path double-counted against the charge's net−paid path, e.g. Account 753.219 vs
Charge 752.889.)

In the **Student Finance** UI the action is **Renegotiate Payment Plan** — removed from the primary
action row and placed under a per-charge **Advanced actions** disclosure, requiring a reason + a
confirmation dialog.

## Enriched collections profile

`GET /finance/collections/students/:studentId` now returns, in one payload:
`collectionsStatus`, `snapshot` (outstanding · overdue · overdueCount · oldestOverdueDays), the
transport suspension state, reminder history, **promises** (with status), and the
**communications** log.

## Student Finance collections workspace (finance tab)

A **Collections** panel above the charges hierarchy: the overdue snapshot (Outstanding · Overdue ·
Overdue items · Oldest overdue · Due this month), transport status detail, **Promise to Pay**
(record + resolve), the **Communication Log**, a **reminder level** selector + Send, and
**Suspend / Reinstate transport**. Replace Plan is under a per-charge Advanced-actions disclosure.

## Operational finance dashboard (`/finance/dashboard`)

`GET /finance/collections/dashboard` (FINANCE_READ): promises due today, recently missed promises,
transport suspensions, the largest outstanding balances (top 10), and workload counts (students with
outstanding, overdue students, open cases, open promises, transport suspended) + total outstanding
and collected %. The admin page routes each row to the student's finance tab.

## Reminder levels

`SendReminderDto.level ∈ { FRIENDLY, OVERDUE, FINAL, TRANSPORT_WARNING, SUSPENSION_NOTICE }` — sets
the reminder's bilingual tone prefix and is stored on the `DunningEvent` (additive nullable column).
Encourages an escalating friendly→firm progression before any plan change.

## Transport suspension policy

`BillingPolicy` now supports three thresholds — **any satisfied one suspends**: `suspendTransportAfterOverdue`
(installments, existing), `suspendTransportAfterDays` (oldest overdue aged N days), and
`suspendTransportAfterAmount` (overdue amount ≥ X). `evaluateTransport` records the triggering reason.
Manual override: `POST students/:id/transport/suspend` (with reason) and `.../reinstate`. The student
profile surfaces `transportSuspended`, `transportSuspendedAt`, `transportSuspendedReason`,
`transportSuspendedById`, and `transportReinstatedAt`.

Additive migrations only (`20260704120000`, `20260705120000`) — no ledger/plan/data changes.
