# HR Phase 8 — Recruitment

Adds an end-to-end recruitment pipeline — **job postings → applicants → interviews → offer → hire** —
that closes the loop with the Phase-1 employee lifecycle: a hired applicant becomes a real
`Employee` at status **HIRED**.

## 1. Deliverables

| Area | Where |
|------|-------|
| DB migration + RLS | `prisma/migrations/20260723190000_hr_recruitment/` |
| Prisma models | `JobPosting`, `JobApplicant`, `Interview`; enums `JobPostingStatus`, `ApplicantStatus`, `InterviewMode`, `InterviewOutcome` |
| Backend | `apps/api/src/people/recruitment/**` |
| RBAC | `recruitment:read/manage` in `@munaxa/domain` |
| Admin Portal | **People → Recruitment** (postings) + posting detail (applicants, interviews, hire), `lib/people.ts` |
| Tests | `apps/api/test/hr-recruitment.e2e-spec.ts` (5 cases) |

## 2. Model & workflow

- **`JobPosting`** — a vacancy, optionally tied to a `Department`/`Position` (org engine, Phase 1),
  with `employmentType`, `headcount` and a status (DRAFT → OPEN → CLOSED/FILLED; `openedAt`/`closedAt`
  are stamped automatically on transition).
- **`JobApplicant`** — a candidate on a posting, advancing APPLIED → SCREENING → INTERVIEW → OFFER →
  HIRED (or REJECTED/WITHDRAWN), with a rating and notes.
- **`Interview`** — a scheduled interview (ONSITE/PHONE/VIDEO) with an interviewer and an outcome
  (PENDING → PASSED/FAILED), rating and feedback.

### The hire loop (key integration)
`POST hr/applicants/:id/hire` **reuses `EmployeeService`** (exported from `PeopleModule`) to create a
real `Employee` at status `HIRED` — English names from the applicant, Arabic names + job details
from the hire request (job title defaulting to the posting title, department/position/employment-type
inherited from the posting). The applicant is then linked to the created employee
(`hiredEmployeeId`, unique 1:1) and marked HIRED. No employee-creation logic is duplicated.

Every mutation is tenant-scoped (RLS) and audited.

## 3. Resources & permissions

| Resource | Path (`/api/v1`) | Permission |
|----------|------------------|------------|
| Postings (list, filter) | `GET hr/job-postings?status=` | `recruitment:read` |
| Postings (create/update/delete) | `hr/job-postings[/:id]` | `recruitment:manage` |
| Applicants (list/create) | `hr/job-postings/:id/applicants` | read `recruitment:read`, create `recruitment:manage` |
| Applicant (get/update) | `hr/applicants/:id` | read `recruitment:read`, write `recruitment:manage` |
| Hire | `POST hr/applicants/:id/hire` | `recruitment:manage` |
| Interviews (create) | `POST hr/applicants/:id/interviews` | `recruitment:manage` |
| Interviews (update/delete) | `hr/interviews/:id` | `recruitment:manage` |

Guards: a hired applicant can't be edited or re-hired. Defaults: **HR** manage; **Principal** read.

## 4. Admin Portal

- **People → Recruitment** — the postings list: create postings and manage their status.
- **Posting detail** — the applicant pipeline: add applicants, advance status, schedule interviews
  and record outcomes, and **hire** (a small Arabic-name form) which creates the employee.

## 5. Validation

`prisma validate` ✓ · migration applies with **zero drift** ✓ · API + Admin typecheck ✓ · ESLint ✓ ·
**380** unit tests ✓ · e2e ✓ (incl. 5 new recruitment cases, covering the hire→Employee loop) ·
production builds ✓ · formatting ✓.
