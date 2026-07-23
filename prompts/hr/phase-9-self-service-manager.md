# HR Phase 9 — Self-Service (ESS) & Manager Portal

Adds two employee-facing surfaces on top of the HR platform:

- **Employee self-service (ESS)** — the acting user sees and manages **their own** HR data at
  `/me/hr` (profile, leave balances/requests, attendance, assets, training, performance reviews).
- **Manager portal** — a manager works **their direct reports** at `/me/team` (roster + pending
  leave approvals).

The defining principle: **no business logic is duplicated**. This layer only resolves the acting
user to their `Employee` record and enforces ownership; every mutation delegates to the canonical
domain service (leave math, balance deduction, audit all live in `LeaveService` etc.).

## 1. Deliverables

| Area | Where |
|------|-------|
| Backend | `apps/api/src/people/self-service/**` (no new tables — reuses existing data) |
| RBAC | `ess:read`, `ess:request`, `team:read`, `team:approve` in `@munaxa/domain` |
| Service exports | `LeaveService`, `AttendanceService`, `AssetService`, `PerformanceService`, `TrainingService` exported from their modules for reuse |
| Admin Portal | **My workspace → My HR** and **My Team** pages, `lib/people.ts` |
| Tests | `apps/api/test/hr-self-service.e2e-spec.ts` (5 cases) |

## 2. Model & workflow

The `Employee.userId` link (a logged-in `User` ↔ their `Employee`) and `Employee.managerId`
(reporting line) drive resolution:

- **`myEmployeeId()`** maps the actor's `userId` → `Employee.id`; a user with no linked employee gets
  403 (`ess:*` alone is not enough — you must *be* an employee).
- **Self-service** delegates reads/writes for that employee id to the domain services. Cancelling a
  leave request first asserts the request belongs to the caller.
- **Manager portal** lists employees where `managerId` = the manager's own employee id; approving a
  report's leave first asserts the request's owner is a direct report, then calls
  `LeaveService.approve` (so balance deduction + audit run exactly as in the HR queue).

## 3. Resources & permissions

| Resource | Path (`/api/v1`) | Permission |
|----------|------------------|------------|
| Own profile | `GET me/hr/profile` | `ess:read` |
| Own leave (balances/list) | `GET me/hr/leave-balances`, `GET me/hr/leave-requests` | `ess:read` |
| Submit / cancel own leave | `POST me/hr/leave-requests[/:id/cancel]` | `ess:request` |
| Own attendance / assets / training / reviews | `GET me/hr/{attendance,assets,training,reviews}` | `ess:read` |
| Acknowledge own review | `POST me/hr/reviews/:id/acknowledge` | `ess:read` |
| Direct reports | `GET me/team/members` | `team:read` |
| Reports' pending leave | `GET me/team/leave-requests` | `team:read` |
| Approve / reject report leave | `POST me/team/leave-requests/:id/{approve,reject}` | `team:approve` |

Defaults: **`ess:*` is granted to every school-staff role** (spread via a shared `ESS_PERMISSIONS`
constant) so any employee with a login can self-serve. **`team:*`** goes to **Principal**,
**VicePrincipal** and **HR**. Row-level scoping (own record / own reports only) is enforced in the
service layer via the actor→employee link, never by the permission set alone.

## 4. Admin Portal

- **My workspace → My HR** — profile summary, leave balances, a request/cancel form, review
  acknowledgement, and attendance/assets/training counters.
- **My workspace → My Team** — the pending-approval queue (approve/reject) and the direct-reports
  roster.

## 5. Validation

`prisma validate` ✓ · zero schema drift ✓ · API + Admin typecheck ✓ · ESLint ✓ · **380** unit tests
✓ · e2e ✓ (incl. 5 new self-service/manager cases) · production builds ✓ · formatting ✓.
