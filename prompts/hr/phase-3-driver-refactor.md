# HR Phase 3 — Driver Refactor (Fleet Integration)

Replaces the denormalised `Bus.driverName` / `driverPhone` strings with a real relationship: bus
drivers are now canonical **Employees** carrying a **`DriverProfile`** (licence, medical,
infractions, performance). `Bus.driverId` references the driver Employee, so Fleet and HR share one
source of truth for driver identity.

## 1. Deliverables

| Area | Where |
|------|-------|
| DB migration + data migration + RLS | `prisma/migrations/20260723140000_hr_driver_refactor/` |
| Prisma models | `DriverProfile`, `DriverInfraction`; enum `InfractionSeverity`; `Bus.driverId` (replaces `driverName`/`driverPhone`) |
| Backend | `apps/api/src/people/employee-records/driver.*`; updated `advanced/bus/**` |
| RBAC | `driver:read`, `driver:manage` in `@munaxa/domain` |
| Admin Portal | Fleet bus form + table (`fleet/setup.tsx`, `fleet/lib.ts`), employee **Driver** tab (`[employeeId]/tabs/driver-tab.tsx`), `lib/bus.ts` + `lib/people.ts` |
| Tests | `apps/api/test/hr-drivers.e2e-spec.ts` (4 cases) |

## 2. The refactor

- **`Bus.driverName` / `driverPhone` → `Bus.driverId → Employee`.** The migration promotes each
  distinct fleet driver string into an `Employee` (jobTitle "Driver", phone preserved) with a
  `DriverProfile` and a seeded lifecycle-history row, then points every matching bus at it. No
  driver data is lost; the string columns are dropped.
- **`DriverProfile`** — 1:1 with `Employee`: licence number/class/expiry, medical-certificate
  expiry, performance rating (both expiry columns indexed for Phase-10 reminders).
- **`DriverInfraction`** — date, type, severity (`MINOR/MAJOR/SEVERE`), points; cascades from the
  profile.
- A bus's driver **must** be an Employee holding a driver profile — the bus service rejects any
  other employee (`400`).

## 3. Resources & permissions

| Resource | Path (`/api/v1`) | Permission |
|----------|------------------|------------|
| Driver directory (+ assigned buses) | `GET /drivers` | `driver:read` |
| Unassigned candidates | `GET /drivers/candidates` | `driver:manage` |
| Driver profile (get / upsert / delete) | `employees/:id/driver-profile` | `driver:read` / `driver:manage` |
| Infractions (add / edit / delete) | `employees/:id/driver-profile/infractions` | `driver:manage` |
| Assign driver to bus | `POST/PATCH /bus/vehicles` (`driverId`) | `bus:manage` |

`driver:manage` + `driver:read` default to **HR** and **FleetAdmin**; `driver:read` also to
**Principal** and **BusSupervisor**. Every mutation is audited.

## 4. Admin Portal

- **Fleet → Setup → Buses** — the driver field is now a dropdown of registered drivers (name +
  phone); the bus table shows the linked driver.
- **Employee profile → Driver tab** — register an employee as a driver, edit licence/medical/
  performance, and record/track infractions. Gated by `driver:read` / `driver:manage`.

## 5. Validation

`prisma validate` ✓ · migration applies with **zero drift** ✓ · API + Admin typecheck ✓ · ESLint ✓ ·
**369** unit tests ✓ · **249** e2e tests ✓ (incl. 4 new driver cases) · production build ✓ · formatting ✓.
