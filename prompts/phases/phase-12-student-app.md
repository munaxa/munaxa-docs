# Phase 12 — Student App

The student-facing experience: a self-scoped `/me/*` surface (dashboard, homework, attendance
history, timetable, resource library, achievements, gamification), plus staff-facing learning
**resource library** and **achievement/badge** management. The defining concern is **scoping a
student to their own record** via `Student.userId` — a Student principal only ever reads their own
data.

## 1. Deliverables

| Area | Where |
|------|-------|
| DB models + RLS | `prisma/migrations/20260605120000_student_app/` (Resource, Achievement, StudentAchievement, StudentGamification) |
| Backend | `apps/api/src/student-portal/{common,me,resources,gamification}` |
| Flutter | `apps/mobile/lib/data/student`, `lib/features/student` |
| e2e | `apps/api/test/student-app.e2e-spec.ts` (8 cases) |
| unit | `apps/api/src/student-portal/gamification/gamification.streaks.spec.ts` (5 cases) |

New permissions (catalog + role map, re-seeded): `resource:read`/`resource:manage`,
`achievement:read`/`achievement:manage`, `gamification:read`. Students hold the read side;
Teacher/Principal/VicePrincipal hold `resource:manage` + `achievement:manage`.

## 2. Self-scoping (`StudentScopeService`)

`student-portal/common/student-scope.service.ts` resolves the acting user's `Student` profile
(`Student.userId = actorUserId`). `requireStudent()` / `requireStudentId()` throw **403** when no
student profile is linked (so staff cannot read `/me/*`). The `MeController` is gated by
`@RequireAnyPermission(homework/attendance/timetable/gamification:read)` and then row-scopes in the
service. This mirrors Phase 11's `ParentScopeService`.

## 3. Features

- **Student dashboard** — `GET /me/dashboard`: 30-day attendance tally, upcoming-homework count,
  recent grades, gamification rollup (points/level/streaks/achievement count), unread notifications.
- **Homework / attendance / timetable** — `GET /me/{homework,attendance,timetable}`, scoped to the
  student's section (homework, timetable) or their own records (attendance history).
- **Resource library** — `Resource` (LINK/VIDEO deep-link out — Munaxa is **not** an LMS;
  FILE/DOCUMENT stored in S3 via `StorageService`). Staff publish with section / grade /
  whole-school scope (`POST /resources`, presign for files). `GET /me/resources` returns what's
  visible to the student: **their section ∪ their grade ∪ whole-school** (file types include fresh
  download URLs).
- **Achievements + gamification** — `Achievement` (per-tenant badge catalog) + `StudentAchievement`
  (earned, idempotent) + `StudentGamification` (points/level/streak rollup). `GamificationService`:
  - `sync(studentId)` recomputes **attendance streaks** from `StudentAttendance` (see below),
    **auto-awards** `ATTENDANCE_STREAK`/`ATTENDANCE_TOTAL` achievements when the metric ≥ `threshold`,
    then recomputes `totalPoints` (Σ earned points) and `level` (`⌊points/100⌋ + 1`). Idempotent.
  - `award(...)` lets staff manually grant `ACADEMIC`/`GENERAL` badges (auto categories are rejected
    with 400). Both paths are audited.
  - `GET /me/gamification` returns a freshly synced summary; `GET /me/achievements` lists earned.

### Streak algorithm (`computeStreaks`, pure + unit-tested)

Per-period rows are collapsed to one status per day (worst wins: any `ABSENT` → absent day). Walking
days newest→oldest: `PRESENT`/`LATE` extend the run, `ABSENT` breaks it, `EXCUSED` is neutral
(skipped). `currentStreak` = the most-recent unbroken run; `longestStreak` = the max run over all
history; `totalPresentDays` = count of present/late days. Auto-awards use `longestStreak` (streak
category) and `totalPresentDays` (total category) so a badge, once earned, stays earned.

## 4. Tests (8 e2e + 5 unit)

e2e: dashboard self-scope; homework/attendance/timetable lists; **non-student → 403**; resource
library scope filtering (section ∪ grade ∪ school, other-section hidden); **student-cannot-manage
resources RBAC 403**; attendance-streak **auto-award** + points/level; staff manual award
(points accumulate); **auto-category manual award → 400**. Unit: the streak state machine
(empty, clean run, ABSENT break, EXCUSED neutral, multi-period collapse). Totals: **66 e2e across
11 suites**, **42 unit**.

## 5. Notes / follow-ups

- Staff resource/achievement management UI is a web (Admin Portal) concern; this phase ships the
  parent-/student-facing Flutter layer per the phase prompt (DB / Backend / Flutter / Tests).
- `gamification.sync` is invoked on read (`/me/gamification`, dashboard) for freshness; a future
  optimization could recompute on attendance writes instead.
