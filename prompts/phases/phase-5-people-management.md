# Phase 5 — People Management

Students, Parents, Teachers, Employees (incl. secretary accounts), parent-student linking,
teacher-section assignment, QR ID generation, and bulk CSV import — tenant-scoped,
permission-guarded, and verified end-to-end.

## 1. Deliverables

| Area | Where |
|------|-------|
| DB models + RLS | `prisma/migrations/20260603140000_people/` (Student, Parent, Teacher, Employee, ParentStudent, TeacherSection) |
| Backend modules | `apps/api/src/people/**` |
| QR utility | `apps/api/src/people/people.util.ts` |
| Admin Portal | `apps/admin/src/app/people/students`, `src/lib/people.ts` |
| Mobile integration | `apps/mobile/lib/data/people/people_api.dart`, `lib/features/people/people_providers.dart` |
| Tests | `apps/api/test/people.e2e-spec.ts` (7 cases) |

## 2. Resources & permissions

| Resource | Path (`/api/v1`) | Permission | Highlights |
|----------|------------------|------------|-----------|
| Students | `/students` | `student:manage` | CRUD, `GET /:id/qr`, `POST /import` (CSV), parent links |
| — links | `/students/:id/parents` | `student:manage` | link / list / unlink a parent (relation + isPrimary) |
| Parents | `/parents` | `parent:manage` | CRUD, `?studentId=` filter |
| Teachers | `/teachers` | `teacher:manage` | CRUD, `/:id/sections` assign / list / unassign |
| Employees | `/employees` | `employee:manage` | CRUD (secretary = `jobTitle: "Secretary"`) |

All people records carry `tenantId` and are scoped by the `TenantRepository` (RLS); profiles
optionally link to a login `User` (`userId`). Students/Parents/Teachers/Employees use soft delete.

## 3. Features

- **QR ID generation**: each Student is issued a unique opaque `qrCode` (`MNX-…`, base32) on
  creation; `GET /students/:id/qr` returns it for client-side QR rendering (used by Phase 7
  QR attendance).
- **Bulk CSV import**: `POST /students/import` parses CSV (`csv-parse`, header row required),
  validates each row, creates the valid ones in a single tenant transaction, and returns
  `{ created, failed: [{ row, error }] }` — partial success with per-row diagnostics.
- **Parent-student linking**: many-to-many via `ParentStudent` (relation: FATHER/MOTHER/GUARDIAN/
  OTHER, `isPrimary`), upserted to be idempotent; unique per `(parentId, studentId)`.
- **Teacher assignment**: `TeacherSection` links a teacher to a section (optional subject);
  duplicate assignment → `409`. Tenant-safe (the section must exist in the caller's tenant).

## 4. Verified behavior (e2e, real PostgreSQL)
- ✅ Create student → unique `MNX-` QR; `GET /:id/qr` matches.
- ✅ Create parent → link to student → list returns the relation.
- ✅ Assign teacher to a section; duplicate → `409`; list returns one.
- ✅ Create employee (secretary).
- ✅ CSV import of 2 valid + 1 invalid row → `{ created: 2, failed: [{ row: 4, … }] }`.
- ✅ RBAC: a Student-role user managing people → `403`.
- ✅ Tenant isolation: tenant B sees none of tenant A's students.

## 5. Admin & Mobile
- **Admin** `/people/students`: list, create (bilingual), and **paste-CSV bulk import** showing the
  import summary; each row shows the QR code.
- **Mobile**: `PeopleApi` + `sectionStudentsProvider` (Riverpod) expose section rosters and student
  QR codes to the Teacher app (consumed fully in Phase 7 attendance).

## 6. Notes
- "Secretary accounts" are modeled as `Employee` profiles (`jobTitle`). Issuing an actual login
  (User + Secretary role + invite/temp password) reuses the Phase 3 auth/RBAC flow and is wired in
  when user-provisioning UIs land.
- National-ID/MoE-number validation hooks live in `@munaxa/utils` (Jordan helpers) and are enforced
  more strictly when the official spec is confirmed.

## Next: Phase 6 — Timetable Engine
MasterTimetable, ScheduleExceptions, substitute teachers, Ramadan mode, and the current-class
engine.
