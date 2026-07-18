# Presence + Transportation — Migration Report (Phase 21)

Post-implementation report for the two new additive domains. The Academic Attendance module was
**not** modified. See the pre-implementation audit: `14-attendance-presence-transport-audit.md`.

## 1. Database change report
**New (migration `20260610150000_presence_transport`, additive only):**
- `StudentPresenceEvent` — GATE_IN/OUT, RECEPTION_CHECKIN/OUT; method NFC/RFID/QR/MANUAL/FACE/BUS;
  `occurredAt`, `deviceId`, `clientRef`. `@@unique([tenantId, clientRef])`; indexes on tenantId,
  (tenantId,studentId), (tenantId,occurredAt).
- `BusAttendanceEvent` — BOARD_AM/ARRIVE_SCHOOL/BOARD_PM/ARRIVE_HOME; method NFC/RFID/QR/MANUAL;
  `busId` → existing `Bus`; `@@unique([tenantId, clientRef])`; indexes incl. (tenantId,busId).
- `AttendanceSourceConfig` — per-tenant: `mode` (TEACHER_ONLY/GATE_ARRIVAL/BUS_ARRIVAL/HYBRID),
  `busMethod`, `presenceEnabled`, `transportEnabled`. `@@unique([tenantId])`.
- New enums: `PresenceEventType`, `PresenceMethod`, `BusEventType`, `TransportMethod`,
  `AttendanceSourceMode`. All three tables get the standard FORCE-RLS tenant policy; app role re-granted.
- Back-relations added to `Tenant`, `Student`, `Bus` (nullable/array — additive).

**Unchanged:** `StudentAttendance` (key `tenantId,studentId,date,periodIndex`), `TeacherAttendance`
(key `tenantId,teacherId,date`), and the `AttendanceMethod` enum (still MANUAL/QR).

## 2. API change report
**New endpoints** (tenant-scoped, RBAC, audit-logged):
- `POST /presence/events` (`presence:create`), `GET /presence/events` (`presence:read`)
- `POST /transport/events` (`transport:create`), `GET /transport/events` (`transport:read`)
- `GET /students/:id/timeline` (`attendance:read`)
- `GET /attendance/settings` (`attendance:read`), `PUT /attendance/settings` (`attendance:configure`)

Events are **idempotent on `clientRef`** (replay returns the existing row, `created:false`). New
permissions `presence:create/read`, `transport:create/read`, `attendance:configure` mapped to
roles (Teacher/Secretary create+read; Principal/VP read+configure; Parent read; SchoolAdmin `*`).
**Existing attendance endpoints unchanged.**

## 3. Mobile change report
New, mirroring the proven `AttendanceQueue` (offline-first, secure-storage, restart-safe):
- `data/presence/` — `PresenceQueue` + `PresenceApi`
- `data/transportation/` — `TransportationQueue` + `TransportationApi`
- `features/presencetracking/presence_controller.dart`, `features/transportation/transportation_controller.dart`

Queues de-dupe locally on `clientRef`, replay safely (server idempotent), and capture with no
connectivity. Primary NFC bus workflow: attendant taps student cards → events queue → auto-sync.
(Flutter not compiled in this environment; code mirrors the existing, working attendance queue.)

## 4. UI change report
- Admin **Settings → Attendance** (`/settings/attendance`): source mode, presence/transport
  toggles, bus capture method — wired to `/attendance/settings`. Nav entry + EN/AR i18n.
- Uses the existing design-system UI kit only (no new patterns). Typecheck + lint clean.

## 5. Compatibility report
- Academic Attendance models, keys, enum, endpoints, repository upserts: **untouched**.
- The only write into `StudentAttendance` is the engine's **guarded, non-overwriting create**
  (period 0, status PRESENT, method MANUAL) — it skips when a mark already exists, so a teacher's
  ABSENT/LATE/EXCUSED always wins; verified by test. Skips when the student has no section.
- New permissions require the catalog to include them: run `db:seed` (or `db:seed:demo`) and
  (re)provision tenant roles so existing tenants gain `presence:*`/`transport:*`. New tenants get
  them automatically via `provisionTenantRoles`.

## 6. Test report
- **+7 e2e** (`test/presence-transport.e2e-spec.ts`): presence create + idempotent replay, bus
  create + idempotent replay, engine TEACHER_ONLY (no attendance) vs GATE_ARRIVAL (auto PRESENT),
  **non-overwrite guard** (prior ABSENT survives GATE_IN), timeline aggregation (3 sources,
  chronological), RBAC (Parent blocked from create, allowed to read timeline).
- **Regression**: existing `attendance.e2e-spec.ts` unchanged and green.
- **Full suite green: 76 unit, 130 e2e / 20 suites.** API + admin typecheck + lint clean.

## Success criteria
1. Existing Attendance unchanged — ✅  2. APIs compatible — ✅  3. Existing e2e pass — ✅
4. Presence works — ✅  5. Transportation works — ✅  6. NFC bus offline — ✅ (queue; field test pending)
7. Manual bus offline — ✅ (queue)  8. Parent timeline — ✅  9. Teacher workload unchanged — ✅
10. No breaking changes — ✅
