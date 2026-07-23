# HR Phase 1 — Core, Employee Lifecycle & Organisation Engine

Transforms `Employee` from a thin directory row into the canonical HR **staff person**, adds a
full 16-state employment **lifecycle** with an audited status timeline, and introduces the
**organisation engine** (departments, positions, reporting managers) — tenant-scoped,
per-capability permission-guarded, and verified end-to-end.

## 1. Deliverables

| Area | Where |
|------|-------|
| DB migration + RLS | `prisma/migrations/20260723120000_hr_core_lifecycle_org/` |
| Prisma models | `Employee` (enriched), `EmployeeStatusHistory`, `Department`, `Position`; enums `EmploymentStatus` (16), `EmploymentType`, `MaritalStatus`; `Teacher.employeeId` link |
| Lifecycle state machine | `apps/api/src/people/employees/employee-lifecycle.logic.ts` (+ `.spec.ts`) |
| Backend | `apps/api/src/people/employees/**`, `apps/api/src/people/org/**` |
| RBAC | `packages/domain/src/permissions.ts`, `role-permissions.ts` |
| Admin Portal | `apps/admin/src/app/(app)/people/employees/**` (directory + full profile workspace), `people/org/page.tsx`, `src/lib/people.ts` |
| Tests | `apps/api/test/hr.e2e-spec.ts` (8 cases), `employee-lifecycle.logic.spec.ts` (7 cases) |

## 2. Data model

- **`Employee`** — identity (employee number, national ID, passport, nationality, visa + expiry,
  gender, DOB, marital status, religion, personal email/phone, photo), employment (job title,
  employment type, status, hire/probation/termination dates, weekly hours), and org placement
  (`campusId`, `departmentId`, `positionId`, self-referential `managerId`). Denormalised
  `createdById` / `updatedById`; soft-deleted via `deletedAt`. Unique `(tenantId, employeeNumber)`.
- **`EmployeeStatusHistory`** — immutable, timestamped lifecycle transitions (`fromStatus`,
  `toStatus`, `reason`, `effectiveDate`, `actorUserId`). Written in the same transaction as the
  status change and mirrored to `AuditLog`.
- **`Department`** — self-referential org tree (`parentId`), optional `campusId`, optional
  `headEmployeeId`. Unique `(tenantId, name)`.
- **`Position`** — optional `departmentId`, `budgetedHeadcount` → vacancies. Unique `(tenantId, title)`.
- **`Teacher.employeeId`** — optional 1:1 link to the canonical `Employee`.

All new tables enforce `tenant_isolation` RLS (`tenantId = app_current_tenant() OR app_is_platform()`).
The legacy `Employee.department` **string** was migrated into `Department` rows, then dropped.

## 3. Employee lifecycle

16 states: `CANDIDATE → INTERVIEW → OFFER_SENT → BACKGROUND_CHECK → OFFER_ACCEPTED → HIRED →
PROBATION → ACTIVE → {TRANSFERRED, PROMOTION, ON_LEAVE, SUSPENDED} → {RESIGNED, RETIRED,
TERMINATED} → ARCHIVED`. Transitions are enforced by a pure state machine
(`employee-lifecycle.logic.ts`); exit statuses stamp `terminationDate`; `ARCHIVED` is terminal.
Employees may only be **created** at an entry status (`CANDIDATE`, `HIRED`, `PROBATION`, `ACTIVE`).

## 4. Resources & permissions

| Resource | Path (`/api/v1`) | Permission |
|----------|------------------|------------|
| List / get employees | `GET /employees`, `GET /employees/:id` | `employee:read` |
| Create / update / delete | `POST/PATCH/DELETE /employees/:id` | `employee:manage` |
| Lifecycle transition | `POST /employees/:id/status` | `hr:lifecycle:manage` |
| Status history | `GET /employees/:id/status-history` | `employee:read` |
| Departments CRUD | `GET/POST/PATCH/DELETE /hr/departments` | `hr:org:read` / `hr:org:manage` |
| Positions CRUD | `GET/POST/PATCH/DELETE /hr/positions` | `hr:org:read` / `hr:org:manage` |

New permissions: `employee:read`, `hr:sensitive:read`, `hr:lifecycle:manage`, `hr:org:read`,
`hr:org:manage`. Defaults: **HR** gets all; **Principal** gets read + sensitive + lifecycle + org
read; **VicePrincipal** gets employee/org read. Sensitive personal fields (national ID, passport,
visa, DOB, marital status, religion, personal contacts, nationality) are **redacted** from callers
lacking `hr:sensitive:read`.

## 5. Admin Portal

- **HR directory** (`/people/employees`) — KPIs, search + type + status filters, unified
  teacher/employee list, quick create.
- **Employee profile workspace** (`/people/employees/:id`) — identity header, inline lifecycle
  status changer, tabs: Overview · Personal · Employment · Organization · History (status timeline).
  Full create/edit form shared with the directory.
- **Organisation** (`/people/org`) — departments (with headcount, hierarchy) and positions (with
  filled/budgeted/vacancies) management.

## 6. Validation

`prisma validate` ✓ · migration applies with **zero drift** ✓ · API + Admin typecheck ✓ · ESLint ✓ ·
**369** unit tests ✓ · **238** e2e tests ✓ (incl. 8 new HR cases) · production build ✓.
