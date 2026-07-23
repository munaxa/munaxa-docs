# HR Phase 4 — Staff Leave Management

Adds configurable staff **leave types**, per-employee **balances**, and **requests** with a
multi-level approval chain, weekend-aware working-day counting, and automatic balance
deduction/restoration. Kept fully separate from the student `LeaveRequest` (parent portal).

## 1. Deliverables

| Area | Where |
|------|-------|
| DB migration + RLS | `prisma/migrations/20260723150000_hr_staff_leave/` |
| Prisma models | `StaffLeaveType`, `StaffLeaveBalance`, `StaffLeaveRequest`, `StaffLeaveApproval`; enums `StaffLeaveStatus`, `LeaveApprovalDecision` |
| Working-day logic | `apps/api/src/people/leave/leave-days.logic.ts` (+ `.spec.ts`) |
| Backend | `apps/api/src/people/leave/**` |
| RBAC | `staff-leave:read/request/approve/manage` in `@munaxa/domain` |
| Admin Portal | `people/leave/page.tsx` (types + approval queue), employee **Leave** tab, `lib/people.ts` |
| Tests | `apps/api/test/hr-leave.e2e-spec.ts` (6 cases), `leave-days.logic.spec.ts` (5 cases) |

## 2. Model & workflow

- **`StaffLeaveType`** — Annual, Sick, Unpaid, Maternity, Hajj… with `paid` (payroll input),
  `defaultAnnualDays`, and `approvalLevels` (1–5).
- **`StaffLeaveBalance`** — entitled vs used days per employee/type/year (unique).
- **`StaffLeaveRequest`** — `workingDays` computed excluding the Fri/Sat weekend; a `PENDING`
  request advances through `approvalLevels`, becoming `APPROVED` on the final level (which deducts
  the balance) or `REJECTED`. Cancelling an approved request restores the balance. Every decision
  is recorded in **`StaffLeaveApproval`** and audited.

Approval, level-advance, balance deduction and restoration all happen in a single transaction.

## 3. Resources & permissions

| Resource | Path (`/api/v1`) | Permission |
|----------|------------------|------------|
| Leave types (CRUD) | `hr/leave-types` | read `staff-leave:read`, write `staff-leave:manage` |
| Approval queue | `GET hr/leave-requests` | `staff-leave:read` |
| Approve / reject | `hr/leave-requests/:id/{approve,reject}` | `staff-leave:approve` |
| Cancel | `hr/leave-requests/:id/cancel` | `staff-leave:request` |
| Balances (list / set) | `employees/:id/leave-balances` | read `staff-leave:read`, set `staff-leave:manage` |
| Requests (list / create) | `employees/:id/leave-requests` | list `staff-leave:read`, create `staff-leave:request` |

Defaults: **HR** all; **Principal** / **VicePrincipal** read + approve.

## 4. Admin Portal

- **People → Leave** — manage leave types and work the pending-approval queue (approve/reject).
- **Employee profile → Leave tab** — balances, request leave, and cancel/approve requests inline.

## 5. Validation

`prisma validate` ✓ · migration applies with **zero drift** ✓ · API + Admin typecheck ✓ · ESLint ✓ ·
**374** unit tests ✓ · **255** e2e tests ✓ (incl. 6 new leave cases) · production build ✓ · formatting ✓.
