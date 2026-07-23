# HR Phase 5 — Staff Attendance & Payroll Preparation

Adds per-employee **daily attendance** (check-in/out, lateness, overtime, source, an immutable
correction trail) and a **payroll-preparation** aggregation that combines attendance with approved
leave to produce the payable/absent/overtime figures a payroll officer exports. Kept deliberately
separate from the academic `TeacherAttendance` (teaching-presence) and student `StudentAttendance` —
this is the HR/payroll source of truth.

## 1. Deliverables

| Area | Where |
|------|-------|
| DB migration + RLS | `prisma/migrations/20260723160000_hr_staff_attendance/` |
| Prisma model | `StaffAttendance`; enums `StaffAttendanceStatus`, `StaffAttendanceSource` |
| Aggregation logic | `apps/api/src/people/attendance/payroll-prep.logic.ts` (+ `.spec.ts`) |
| Backend | `apps/api/src/people/attendance/**` |
| RBAC | `staff-attendance:read/manage`, `payroll:prepare` in `@munaxa/domain` |
| Admin Portal | employee **Attendance** tab, **People → Payroll** page, `lib/people.ts` |
| Tests | `apps/api/test/hr-attendance.e2e-spec.ts` (6 cases), `payroll-prep.logic.spec.ts` (6 cases) |

## 2. Model & workflow

- **`StaffAttendance`** — one row per employee per day (`@@unique([tenantId, employeeId, date])`).
  Captures `status`, `source` (MANUAL/QR/BIOMETRIC/GPS/MOBILE), `checkInAt`/`checkOutAt`,
  `lateMinutes`, `overtimeHours`, and `note`. Recording is an **upsert**: changing an existing day's
  status captures the previous value into the correction trail
  (`correctedFromStatus` / `correctedById` / `correctedAt`), and every write is audited.
- **Payroll preparation** — for a date range, per employee: working days (weekend-excluded, reusing
  the Phase-4 `workingDaysBetween`), present/remote/absent/late counts, summed late minutes and
  overtime hours, and approved-leave coverage split into **paid** vs **unpaid** (from
  `StaffLeaveType.paid`). `payableDays = workingDays − absentDays − unpaidLeaveDays` (clamped at 0).
  No money is computed here — this is *preparation* that feeds the payroll run.

## 3. Resources & permissions

| Resource | Path (`/api/v1`) | Permission |
|----------|------------------|------------|
| Daily roster (one date) | `GET hr/attendance?date=` | `staff-attendance:read` |
| Bulk mark a date | `POST hr/attendance/bulk` | `staff-attendance:manage` |
| Payroll-prep summary / export | `GET hr/payroll-prep?from=&to=[&format=csv\|xlsx\|pdf]` | `payroll:prepare` |
| Employee history | `GET employees/:id/attendance?from=&to=` | `staff-attendance:read` |
| Record / correct a day | `POST employees/:id/attendance` | `staff-attendance:manage` |

Defaults: **HR** read + manage + prepare; **Principal** / **VicePrincipal** read; **FinanceOfficer**
read + prepare (payroll consumes the summary).

## 4. Reuse

The CSV/Excel/PDF export reuses the shared `ExportService` (`ReportTable` renderer) — now exported
from `ReportingModule` — rather than a second exporter. Working-day arithmetic reuses the Phase-4
`leave-days.logic`.

## 5. Admin Portal

- **Employee profile → Attendance tab** — record/correct a day and view the dated history (with the
  correction trail shown inline).
- **People → Payroll** — pick a period, generate the payroll-prep table, and download it as
  CSV/Excel/PDF.

## 6. Validation

`prisma validate` ✓ · migration applies with **zero drift** ✓ · API + Admin typecheck ✓ · ESLint ✓ ·
**380** unit tests ✓ (incl. 6 payroll-prep cases) · e2e ✓ (incl. 6 new attendance cases) ·
production build ✓ · formatting ✓.
