# Attendance / Presence / Transportation — Compatibility Audit

**Scope:** add two new domains — **Campus Presence** and **Transportation** — alongside the
existing Academic Attendance, with 100% backward compatibility. This is the pre-implementation
audit gate. **No code is changed by this document.**

## Existing functionality found

### Academic Attendance (Phase 7) — intact, must remain so
- **Models** (`prisma/schema.prisma`):
  - `StudentAttendance` — `@@unique([tenantId, studentId, date, periodIndex])`; fields incl.
    `status` (`AttendanceStatus` = PRESENT/ABSENT/LATE/EXCUSED), `method` (`AttendanceMethod` =
    **MANUAL/QR only**), `markedById`, `clientRef` (audit only), `sectionId`, `periodIndex`.
  - `TeacherAttendance` — `@@unique([tenantId, teacherId, date])`.
- **API** (`apps/api/src/attendance/`): `POST attendance/students/bulk` (idempotent offline-sync
  target), `POST attendance/students/qr`, `GET attendance/students`, `GET …/summary`,
  `GET …/:studentId/history`; teacher equivalents. Guarded by `attendance:create` / `attendance:read`.
- **Idempotency**: repository `upsert` / `upsertMany` on the natural unique key; `clientRef` is
  stored for audit/debug but is **not** the idempotency key.
- **RBAC**: `ATTENDANCE_CREATE`, `ATTENDANCE_READ`, `ATTENDANCE_EXPORT`; mapped to Teacher (create+
  read), admins, and read for most roles (`packages/domain`).
- **Mobile offline-first** (`apps/mobile/lib/data/attendance/`): `AttendanceQueue` — a durable
  write-ahead queue in `flutter_secure_storage` (JSON list, survives restarts), optimistic UI,
  drained by a sync service; `attendance_api.dart`, `attendance_controller.dart`. `PendingMark`
  carries `clientRef`.
- **e2e**: `apps/api/test/attendance.e2e-spec.ts` (8 tests) — bulk idempotency, QR, summary,
  history, RBAC.

### Existing Bus module (Phase 14) — fleet/routes, NOT bus attendance
- Models: `BusRoute`, `Bus` (incl. `lastLat/lastLng/lastSeenAt` GPS), `BusStop`,
  `StudentBusAssignment` (`@@unique([studentId, routeId])`).
- API: `bus.controller` gated by `@RequireFeature(BUS_TRACKING)` + `BUS_MANAGE`/`BUS_READ`.
- **This is route/fleet management + live location — there is no per-student bus *event* capture.**
  The new `BusAttendanceEvent` is complementary and references the existing `Bus` by id.

## Missing functionality (to build, all additive)
- **Campus Presence domain**: `StudentPresenceEvent` (GATE_IN/OUT, RECEPTION_CHECKIN/OUT) — none today.
- **Transportation events**: `BusAttendanceEvent` (BOARD_AM, ARRIVE_SCHOOL, BOARD_PM, ARRIVE_HOME) —
  none today (the Bus module tracks routes/GPS, not boarding events).
- **Multi-method identification**: NFC/RFID/QR/MANUAL (+ future FACE) — only MANUAL/QR exist, and
  only for academic attendance.
- **Attendance-source engine**: configurable per-tenant rule to derive `Present` from presence/bus
  arrival events (Teacher Only / Gate Arrival / Bus Arrival / Hybrid) — none today.
- **Unified parent timeline**: `GET /students/:id/timeline` aggregating the three domains — none.
- **Admin Settings → Attendance** page — none.
- **Mobile** `presencetracking` + `transportation` features with `PresenceQueue` /
  `TransportationQueue` — none.

## Potential conflicts
1. **`AttendanceMethod` enum is MANUAL/QR only.** The new domains need NFC/RFID/FACE/BUS. Extending
   this shared enum is unnecessary and risky → **new enums** `PresenceMethod` / `TransportMethod`
   instead. (Conflict avoided by isolation.)
2. **Idempotency model differs.** Academic attendance is an *upsert on a natural key*; presence/bus
   are *append-only events*. Replaying must be safe → a `@@unique([tenantId, clientRef])` per new
   table (skip-duplicate on replay), distinct from the attendance pattern.
3. **Attendance-source engine writes into `StudentAttendance`.** This is the only place the new work
   touches the protected table. Risk: overwriting a teacher's mark, or breaking the unique key.
   → Mitigation: reuse the **existing idempotent upsert path**, write `method=…`, and **never
   downgrade/overwrite an existing mark** (only create `PRESENT` when no row exists for
   (student,date,period)). The teacher's ABSENT/LATE/EXCUSED always wins.
4. **`StudentBusAssignment` already uses `busId`/`routeId`.** New `BusAttendanceEvent.busId` →
   existing `Bus`; add only a back-relation (additive).

## Required changes (all additive — new migrations only)
- **Schema**: `StudentPresenceEvent`, `BusAttendanceEvent`; enums `PresenceEventType`,
  `PresenceMethod`, `BusEventType`, `TransportMethod`; per-tenant `AttendanceSourceConfig`
  (mode + bus method + presence/transport on/off). New migration + RLS block; re-grant app role.
  Back-relations on `Tenant`, `Student`, `Bus` (nullable/array — additive).
- **API**: `POST/GET /presence/events`, `POST/GET /transport/events`, `GET /students/:id/timeline`,
  `GET/PUT /attendance/settings`. RBAC: new `presence:*`, `transport:*` permissions + role mappings.
- **Engine**: `AttendanceSourceService` — on arrival events, conditionally create `PRESENT` via the
  existing attendance upsert (guarded, non-overwriting).
- **Identification**: `StudentIdentificationProvider` interface + Nfc/Rfid/Qr/Manual providers
  (resolve a tap → studentId); engine is provider-agnostic.
- **Mobile**: `lib/features/presencetracking`, `lib/features/transportation`, `PresenceQueue`,
  `TransportationQueue` — mirror `AttendanceQueue` (secure storage, restart-safe, dedupe, replay).
- **Admin**: Settings → Attendance page (source mode, bus method, presence/transport toggles).
- **Tests**: new e2e (presence/bus create + replay + idempotency, timeline, RBAC). Existing
  attendance e2e must stay green.

## Zero-risk changes
New tables, new enums, new endpoints, new permissions, new mobile features, new admin page, new
config table. None alter existing columns, keys, enums, endpoints, or the attendance write path.

## Breaking-change risks (and mitigations)
| Risk | Mitigation |
| --- | --- |
| Extending `AttendanceMethod` enum | **Don't** — use separate `PresenceMethod`/`TransportMethod`. |
| Auto-attendance overwriting teacher marks | Engine only **creates** PRESENT when no mark exists; never updates/downgrades. |
| Changing `StudentAttendance`/`TeacherAttendance` unique keys | **Untouched** — additive only. |
| New required columns on existing tables | None added; all new fields live on new tables. |
| RLS regression | New tables get the standard FORCE-RLS tenant policy; app-role re-grant after migrate. |
| e2e regression | Run the existing attendance suite unchanged after each step. |

## Conclusion
The new domains are **fully additive** and can be built without modifying the Attendance module.
The single integration point (the attendance-source engine writing `PRESENT`) is isolated behind a
non-overwriting guard and the existing idempotent upsert. **Cleared to implement.**
