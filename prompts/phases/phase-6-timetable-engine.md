# Phase 6 — Timetable Engine

Master timetable, date-specific schedule exceptions (cancellation / substitution / replacement /
holiday), substitute teachers, Ramadan mode, and the **current-class engine** — with the resolution
algorithm implemented as a pure, fully unit-tested module.

## 1. Deliverables

| Area | Where |
|------|-------|
| DB models + RLS | `prisma/migrations/20260603150000_timetable/` (TimetableSlot, ScheduleException, TimetableConfig) |
| **Pure engine + unit tests** | `apps/api/src/timetable/engine/timetable-engine.ts` (+ `.spec.ts`, 14 cases) |
| Backend modules | `apps/api/src/timetable/{slots,exceptions,config,resolver}` |
| Admin Portal | `apps/admin/src/app/timetable`, `src/lib/timetable.ts` |
| Mobile | `apps/mobile/lib/data/timetable`, `lib/features/timetable` |
| e2e | `apps/api/test/timetable.e2e-spec.ts` (5 cases) |

## 2. Data model

- **TimetableSlot** — a recurring weekly class for a section, keyed by
  `(scheduleType, dayOfWeek, periodIndex)`. The `REGULAR` set is the master timetable; the
  `RAMADAN` set is the Ramadan-mode schedule. Times are `"HH:MM"` (24h) local school time.
- **ScheduleException** — a date-specific override: a cancelled period, a substitute teacher
  (`substituteTeacherId`), a replaced subject/teacher/room, or a whole-day `HOLIDAY`
  (`periodIndex` null; `sectionId` null ⇒ school-wide).
- **TimetableConfig** — per-campus settings: `ramadanModeEnabled` + `ramadanStartDate`/`ramadanEndDate`.

## 3. Current-class algorithm

Implemented in `timetable-engine.ts` (pure functions):

```
resolveScheduleType(config, date):           # step 4
  RAMADAN if ramadanModeEnabled and date ∈ [ramadanStartDate, ramadanEndDate] else REGULAR

resolveDay({ slots, exceptions, scheduleType, dayOfWeek }):
  if a whole-day HOLIDAY exception exists      → return { isHoliday: true, periods: [] }   # steps 1-2
  periods ← master slots where scheduleType & dayOfWeek match, sorted by periodIndex       # step 3
  for each period:                                                                          # steps 1-2
    exception ← exceptions[periodIndex]
    CANCELLATION → status CANCELLED
    SUBSTITUTION → status SUBSTITUTED (+ substituteTeacherId)
    REPLACEMENT  → status REPLACED   (+ subject/teacher/classroom from the exception)
  return periods

findCurrentAndNext(periods, nowMinutes):
  current ← period where start ≤ now < end and not CANCELLED
  next    ← earliest non-CANCELLED period starting after now
```

The spec's stated order — *check exceptions → use exception → else master → if Ramadan use Ramadan*
— is satisfied: the schedule type (Ramadan vs regular) selects the master set, then exceptions are
overlaid per period. **Fail-safe**: malformed times throw; cancelled periods are never returned as
"current"; with no tenant context the data layer (RLS) returns nothing.

## 4. API (`/api/v1`)

| Method | Path | Permission |
|--------|------|------------|
| CRUD | `/timetable/slots` (`?sectionId=`) | `timetable:manage` / `timetable:read` |
| CRUD | `/timetable/exceptions` (`?sectionId=&date=`) | `timetable:manage` / `timetable:read` |
| GET / PUT | `/timetable/config/:campusId` | `timetable:read` / `timetable:manage` |
| GET | `/timetable/sections/:sectionId/day?date=` | `timetable:read` |
| GET | `/timetable/sections/:sectionId/current?at=` | `timetable:read` |

## 5. Verified behavior
- **Unit (engine, 14)**: time parsing, day mapping, Ramadan window (inclusive bounds + disabled),
  regular vs Ramadan master selection, cancellation/substitution/replacement, whole-day holiday,
  current/next detection (before first, mid-class, after last, skip cancelled).
- **e2e (5, real DB)**: regular day resolves 2 periods; current/next at 09:00 → period 2; a
  cancellation marks the period CANCELLED; enabling Ramadan config switches the date to the RAMADAN
  set; a Parent can read but cannot manage slots (403).

## 6. Admin & Mobile
- **Admin** `/timetable`: resolve a section's day for a date; statuses colour-coded
  (cancelled struck-through, substituted aqua, replaced coral).
- **Mobile**: `TimetableApi` + `currentClassProvider` (Riverpod) power the Teacher app's "now/next"
  card and the Student timetable.

## 7. Notes
- Times are stored as local "HH:MM"; the resolver reads the wall-clock hours/minutes of the
  provided `at` (UTC). Full timezone/locale handling (and Hijri display) is refined in later phases.
- Conflict detection (overlapping periods, teacher double-booking) is a planned enhancement; the
  unique constraint already prevents duplicate `(section, scheduleType, day, period)` slots.

## Next: Phase 7 — Attendance System
Student & teacher attendance, QR attendance, an **offline-first** queue with background sync, the
attendance dashboard, and the parent attendance view.
