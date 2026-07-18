# ADR-0001 — Student is identity; Enrollment is academic placement

- **Status:** Accepted
- **Date:** 2026-07-16
- **Deciders:** Product owner + engineering (Student-Lifecycle refactor, PR #210)
- **Related:** `STUDENT_LIFECYCLE_ARCHITECTURE_REVIEW.md` (Decisions 4, 12, 13)

## Context

A `Student` is a **permanent identity record** — one row per human, for life. Academic
placement (grade, section, classroom, academic year, participation status, transport, fee
plan) is **year-scoped**: it varies every academic year and belongs to a specific
**Enrollment** (one per student per academic year).

Historically, placement was duplicated onto `Student` (e.g. `Student.sectionId`). This caused
a class of bugs where the profile/editor showed one grade while the Enrollment (and Enrollment
History) held another — and "fixing" it by re-admitting hit the one-enrollment-per-year
constraint with a raw uniqueness error. That is the concrete failure this ADR prevents.

## Decision

**The Enrollment is the single source of truth for all year-scoped academic placement.
The Student stores only permanent identity.**

Placement fields — grade, section, classroom, academic year, enrollment/participation status,
transport assignment, fee plan, advisor, homeroom teacher — live on the **Enrollment** (or a
child of it) and are **never** authoritative on, or written by callers to, the `Student`.

### Rules every future feature MUST follow

1. **Never write placement to `Student`.** No API, admin form, CSV import, migration,
   background job, or mobile client may set grade/section/classroom/year/status/transport/fee
   on the Student. Placement is set on the Enrollment.
2. **Read current placement from the active Enrollment** (the enrollment in the school's
   `ACTIVE` academic year). Read historical placement from the **selected** Enrollment.
   Never treat `Student` as the source of truth for placement.
3. **Changing placement is reason-first** (see the `enrollment-change` module): Grade
   Correction and Administrative Transfer edit the current Enrollment; Promotion and Repeat
   create a *new* Enrollment via Year-End Processing and never edit the current one.
4. **History is immutable.** Changing the current Enrollment never modifies a previous one.
5. Only the **current, active-year** Enrollment may be corrected — never a closed year, or a
   withdrawn / graduated / archived enrollment.

## Enforcement (as of PR #210)

- **Student API** (`CreateStudentDto` / `UpdateStudentDto`, `StudentService`) accepts and
  writes **identity only**. `sectionId` / `areaId` / `transportRequested` were removed from the
  DTOs and the service — the backend, not the UI, refuses placement writes to Student.
- **Admission** (`AdmissionsRepository`) no longer writes placement onto `Student`. Placement
  is written to the **Enrollment** in `createEnrollmentRowTx`, which is the single chokepoint
  all admission paths funnel through.
- **Placement changes** go through `PATCH /enrollments/:id/transfer` and
  `/enrollments/:id/correct-grade` (the `enrollment-change` module), which edit the Enrollment,
  are restricted to the active-year enrollment, and are fully audited (previous/new grade,
  section, classroom, reason, actor, timestamp).
- **Uniqueness is surfaced as business validation**, never a raw DB error (e.g. *"This student
  is already enrolled in Academic Year 2026/27 …"*).

## Remaining compatibility shims on `Student`

These deprecated columns remain **only** as a read-through cache for legacy readers during the
transition. They are written by **exactly one** sanctioned, single-writer path each — never by
callers — and must be removed in Phase B.

| Column | Cached from | Written by (only) | Still required because | Removal (Phase B) |
|---|---|---|---|---|
| `sectionId` | `Enrollment.sectionId` (current year) | `createEnrollmentRowTx`, `EnrollmentChangeRepository` | Read by attendance, student-portal, parent-portal, presence, fleet, admin student list | Redirect those readers to the active Enrollment, then drop the column + index |
| `areaId` | `Enrollment.areaId` | `createEnrollmentRowTx` | Read by fleet area planning, account repo | Redirect fleet/finance to Enrollment, then drop |
| `transportRequested` | `Enrollment.transportRequested` | `createEnrollmentRowTx` | Read by fleet, finance account, transport tab | Redirect to Enrollment, then drop |
| `enrollmentDate` | `Enrollment.admissionDate` | `createEnrollmentRowTx` | Shown as "admitted" in a few places | Read from Enrollment, then drop |
| `status` | derived from the student's enrollments | `EnrollmentLifecycleService` | Read by student list status filter/badge | Compute from enrollments at read time, then drop |

**Migration plan (Phase B, one reader-group per PR, only after production validation):**
1. Redirect each reader group above to the active/selected Enrollment (attendance → portal →
   parent-portal → presence → fleet → finance → reporting → admin lists → mobile → exports).
2. After a reader group no longer touches the shim, delete its dependency.
3. Once no reader remains for a column, drop the column + its indexes and the single-writer
   sync. Do this additively/reversibly, consistent with the refactor's migration principles.

## Read-side coupling inventory (to migrate in Phase B)

Modules still reading placement from `Student` rather than the Enrollment (audited PR #210):
`attendance/students`, `student-portal/me` (homework/timetable/resources),
`parent-portal` (dashboard, scope), `presence`, `finance/account`, `reporting`,
admin `fleet/lib`, admin `people/students` list, admin `transport-tab`. These work today because
the shim is kept in sync by the single writer; they are **not** new violations, but they are the
Phase-B backlog.

## Consequences

- **Positive:** No more grade/section divergence; one obvious place to change placement; complete
  audit trail; immutable history; the backend (not the UI) enforces the model.
- **Cost/known debt:** the five shim columns above remain until Phase B; new code must not read
  them (read the Enrollment) and must not write them (only the sanctioned sync may).

## What future developers must NEVER do

- Add a placement field to `Student` or write one from any caller.
- Read "current grade/section/…" from `Student` in new code — read the active Enrollment.
- Implement a generic "change grade" that edits `Student`, or that silently re-prices fees —
  placement changes are reason-first and finance changes are explicit (see PR 2).
