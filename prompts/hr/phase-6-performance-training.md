# HR Phase 6 — Performance & Training

Adds two related HR sub-domains: **performance management** (appraisal cycles, reviews, goals) and
**training** (a course catalog with per-employee records, renewable-certification expiry tracking).

## 1. Deliverables

| Area | Where |
|------|-------|
| DB migration + RLS | `prisma/migrations/20260723170000_hr_performance_training/` |
| Prisma models | `PerformanceCycle`, `PerformanceReview`, `PerformanceGoal`, `TrainingCourse`, `TrainingRecord`; enums `PerformanceCycleStatus`, `PerformanceReviewStatus`, `PerformanceGoalStatus`, `TrainingRecordStatus` |
| Backend | `apps/api/src/people/performance/**`, `apps/api/src/people/training/**` |
| RBAC | `performance:read/manage`, `training:read/manage` in `@munaxa/domain` |
| Admin Portal | employee **Performance** & **Training** tabs, **People → Performance** (cycles) and **People → Training** (catalog + expiring report) pages, `lib/people.ts` |
| Tests | `apps/api/test/hr-performance-training.e2e-spec.ts` (5 cases) |

## 2. Model & workflow

### Performance
- **`PerformanceCycle`** — a named appraisal period (DRAFT → ACTIVE → CLOSED).
- **`PerformanceReview`** — one employee's appraisal within a cycle (unique per cycle+employee).
  Lifecycle: **DRAFT** (edit rating 1–5, summary, strengths, improvements) → **SUBMITTED** (by the
  reviewer, timestamped) → **ACKNOWLEDGED** (by the reviewee; the review then becomes read-only).
- **`PerformanceGoal`** — SMART goals under a review, with `weight`, `progress` (0–100), status and
  optional rating.

### Training
- **`TrainingCourse`** — catalog entry: title, category, provider, hours, `mandatory`, `isActive`.
- **`TrainingRecord`** — an employee's participation (ENROLLED → IN_PROGRESS → COMPLETED/FAILED/
  CANCELLED). Moving to COMPLETED auto-stamps `completedAt`. `expiresAt` supports renewable
  certifications; the earned certificate links to the existing **`EmployeeDocument`** store (reuse).

Every mutation is tenant-scoped (RLS) and written to the shared `AuditLog`.

## 3. Resources & permissions

| Resource | Path (`/api/v1`) | Permission |
|----------|------------------|------------|
| Performance cycles (CRUD) | `hr/performance-cycles` | read `performance:read`, write `performance:manage` |
| Reviews (get/update/submit) | `hr/performance-reviews/:id[/submit]` | read `performance:read`, write `performance:manage` |
| Review acknowledge | `hr/performance-reviews/:id/acknowledge` | `performance:read` (the reviewee's action) |
| Reviews (list/create) | `employees/:id/performance-reviews` | list `performance:read`, create `performance:manage` |
| Goals (add/update/delete) | `hr/performance-reviews/:id/goals`, `hr/performance-goals/:id` | `performance:manage` |
| Training courses (CRUD) | `hr/training-courses` | read `training:read`, write `training:manage` |
| Expiring certifications | `GET hr/training-records/expiring?within=` | `training:read` |
| Records (update/delete) | `hr/training-records/:id` | `training:manage` |
| Records (list/enrol) | `employees/:id/training-records` | list `training:read`, enrol `training:manage` |

Defaults: **HR** all; **Principal** read + manage (writes reviews); **VicePrincipal** read + manage
performance, read training.

## 4. Admin Portal

- **Employee profile → Performance tab** — reviews with inline rating/summary editing, submit/
  acknowledge, and goal management.
- **Employee profile → Training tab** — enrol in courses and drive record status.
- **People → Performance** — manage appraisal cycles.
- **People → Training** — the course catalog plus an expiring-certifications (90-day) alert list.

## 5. Validation

`prisma validate` ✓ · migration applies with **zero drift** ✓ · API + Admin typecheck ✓ · ESLint ✓ ·
**380** unit tests ✓ · e2e ✓ (incl. 5 new performance/training cases) · production builds ✓ ·
formatting ✓.
