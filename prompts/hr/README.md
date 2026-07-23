# Enterprise HR (HRMS) — Program Overview

Munaxa's HR module is being transformed from a two-table staff directory into a complete
enterprise **Human Resources Management System**, fully integrated with the rest of the School OS.
The program is delivered in verified phases; each phase ships end-to-end (schema → migration → API
→ RBAC → UI → tests → docs) and only proceeds once every validation gate is green.

The pre-implementation audit lives at [`/HR_ARCHITECTURE_AUDIT.md`](../../HR_ARCHITECTURE_AUDIT.md).

## Phase status

| Phase | Scope | Status | Doc |
|------|-------|--------|-----|
| 1 | Core staff person, employee lifecycle (16 states), organisation engine (departments, positions, managers) | ✅ Done | [phase-1-core-lifecycle-org.md](./phase-1-core-lifecycle-org.md) |
| 2 | Contracts & documents (versioned, expiry), emergency contacts, dependents, education, certificates, bank | ✅ Done | [phase-2-contracts-documents.md](./phase-2-contracts-documents.md) |
| 3 | Driver refactor — drivers become Employees; Fleet references `driverId`; `DriverProfile` | ✅ Done | [phase-3-driver-refactor.md](./phase-3-driver-refactor.md) |
| 4 | Staff leave management (types, balances, multi-level approval, holiday awareness) | ✅ Done | [phase-4-staff-leave.md](./phase-4-staff-leave.md) |
| 5 | Staff attendance & payroll preparation (overtime, corrections, export) | ✅ Done | [phase-5-staff-attendance-payroll.md](./phase-5-staff-attendance-payroll.md) |
| 6 | Performance & training | ⏳ Planned | — |
| 7 | Asset management | ⏳ Planned | — |
| 8 | Recruitment (vacancies, applicants, interviews, offer→hire) | ⏳ Planned | — |
| 9 | Self-service & manager portals | ⏳ Planned | — |
| 10 | HR dashboard, reporting, automation, AI-ready | ⏳ Planned | — |

## Architectural principles

- **`Employee` is the single canonical staff person.** `Teacher` is an academic facet linked 1:1
  (`Teacher.employeeId`); a bus driver (Phase 3) is an `Employee` + `DriverProfile`.
- **Everything is tenant-scoped** (Postgres RLS) with `tenantId` indexes, cursor/offset-bounded
  lists, and per-facet permissions.
- **Every mutation is audited** through the shared `AuditLog`, and lifecycle changes additionally
  keep an immutable `EmployeeStatusHistory` timeline.
- **No duplicated tables/services/logic**; the free-text `department` string was replaced by a real
  `Department` entity (data migrated, not preserved as debt).
